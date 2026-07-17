import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS, UI_VALIDATION_MAX_WAIT_MS } from '@craft-agent/shared/ui-validation'
import { ElectronUiDriverError, type UiVerificationLevel } from './electron-surface-driver'

export interface WindowsNativeNode {
  ref: string
  runtimeId: string
  role: string
  name: string
  automationId?: string
  nativeWindowHandle?: number
  enabled: boolean
  focused: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  actions: Array<'click' | 'fill' | 'select' | 'focus' | 'minimize' | 'maximize' | 'restore' | 'close'>
  backgroundActions: Array<'click' | 'fill' | 'select' | 'minimize' | 'close'>
}

export interface WindowsNativeSnapshot {
  revision: number
  processId: number
  windows: Array<{ name: string; role: string; nodes: WindowsNativeNode[] }>
  truncated: boolean
  verificationLevel: 'native-verified'
  windowMode?: 'foreground' | 'background'
}

export interface WindowsNativeActionRequest {
  revision: number
  ref: string
  action: 'click' | 'fill' | 'select' | 'focus' | 'minimize' | 'maximize' | 'restore' | 'close'
  value?: string
}

export interface WindowsNativeActionReceipt {
  actionId: string
  verificationLevel: UiVerificationLevel
  beforeRevision: number
  afterRevision: number
  targetResolved: Pick<WindowsNativeNode, 'ref' | 'role' | 'name'> & { kind: 'native' }
  settledBy: string[]
  warnings: string[]
}

interface RawNativeNode {
  runtimeId: string
  role: string
  name: string
  automationId?: string
  nativeWindowHandle?: number
  enabled: boolean
  focused: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  patterns?: string[]
  children?: RawNativeNode[]
}

interface RawNativeSnapshot {
  windows: RawNativeNode[]
  truncated?: boolean
}

type NativeRunner = (request: Record<string, unknown>) => Promise<unknown>

const MAX_NATIVE_NODES = 1_000

export class WindowsNativeUiDriver {
  private revision = 0
  private fingerprint = ''
  private refs = new Map<string, WindowsNativeNode>()

  constructor(
    private readonly processId: number,
    private readonly runner: NativeRunner = runPowerShellUiAutomation,
    private readonly platform = process.platform,
  ) {}

  available(): boolean { return this.platform === 'win32' && Number.isSafeInteger(this.processId) && this.processId > 0 }

  async snapshot(): Promise<WindowsNativeSnapshot> {
    this.ensureSupported()
    const raw = await this.runner({ v: 1, operation: 'snapshot', processId: this.processId, maxNodes: MAX_NATIVE_NODES }) as RawNativeSnapshot
    if (!raw || !Array.isArray(raw.windows)) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Windows UI Automation returned an invalid snapshot.')
    const fingerprint = JSON.stringify(raw.windows)
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.revision += 1
    }
    this.refs = new Map()
    let count = 0
    const windows = raw.windows.map((window, windowIndex) => ({
      name: bounded(window.name, 500),
      role: bounded(window.role, 100),
      nodes: flatten([window], []).flatMap(rawNode => {
        if (count++ >= MAX_NATIVE_NODES) return []
        const ref = `n${this.revision}:${createHash('sha256').update(rawNode.runtimeId).digest('hex').slice(0, 20)}`
        const node: WindowsNativeNode = {
          ref,
          runtimeId: rawNode.runtimeId,
          role: bounded(rawNode.role, 100),
          name: bounded(rawNode.name, 500),
          ...(rawNode.automationId ? { automationId: bounded(rawNode.automationId, 300) } : {}),
          ...(validNativeWindowHandle(rawNode.nativeWindowHandle) ? { nativeWindowHandle: rawNode.nativeWindowHandle } : {}),
          enabled: rawNode.enabled !== false,
          focused: rawNode.focused === true,
          ...(validBounds(rawNode.bounds) ? { bounds: rawNode.bounds } : {}),
          actions: nativeActions(rawNode),
          backgroundActions: backgroundNativeActions(rawNode),
        }
        this.refs.set(ref, node)
        return [node]
      }),
    }))
    return {
      revision: this.revision,
      processId: this.processId,
      windows,
      truncated: raw.truncated === true || count > MAX_NATIVE_NODES,
      verificationLevel: 'native-verified',
    }
  }

  async action(request: WindowsNativeActionRequest): Promise<WindowsNativeActionReceipt> {
    if (request.revision !== this.revision || !request.ref.startsWith(`n${this.revision}:`)) {
      throw new ElectronUiDriverError('STALE_REF', `Native ref does not belong to revision ${this.revision}.`)
    }
    const target = this.refs.get(request.ref)
    if (!target) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown native target ${request.ref}.`)
    if (!target.enabled) throw new ElectronUiDriverError('DISABLED', `Native target ${request.ref} is disabled.`)
    if (!target.actions.includes(request.action)) throw new ElectronUiDriverError('UNSUPPORTED', `${request.action} is not valid for native ${target.role}.`)
    if ((request.action === 'fill' || request.action === 'select') && request.value === undefined) {
      throw new ElectronUiDriverError('UNSUPPORTED', `${request.action} requires value.`)
    }
    await this.runner({
      v: 1,
      operation: 'action',
      processId: this.processId,
      runtimeId: target.runtimeId,
      action: request.action,
      ...(request.value !== undefined ? { value: request.value.slice(0, 10_000) } : {}),
    })
    const after = await this.snapshot()
    return {
      actionId: randomUUID(),
      verificationLevel: 'native-verified',
      beforeRevision: request.revision,
      afterRevision: after.revision,
      targetResolved: { kind: 'native', ref: request.ref, role: target.role, name: target.name },
      settledBy: ['windows-uia-action', 'windows-uia-snapshot'],
      warnings: [],
    }
  }

  async waitForNode(
    predicate: (node: WindowsNativeNode) => boolean,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ snapshot: WindowsNativeSnapshot; node: WindowsNativeNode }> {
    const timeoutMs = options.timeoutMs ?? UI_VALIDATION_DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > UI_VALIDATION_MAX_WAIT_MS) {
      throw new ElectronUiDriverError('INVALID_REQUEST', `Native wait timeout must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}ms.`)
    }
    const deadline = Date.now() + timeoutMs
    let delayMs = 10
    while (true) {
      if (options.signal?.aborted) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Native wait was aborted.')
      const snapshot = await this.snapshot()
      const node = snapshot.windows.flatMap(window => window.nodes).find(predicate)
      if (node) return { snapshot, node }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new ElectronUiDriverError('TIMEOUT', `Native target did not appear within ${timeoutMs}ms.`)
      await abortableDelay(Math.min(delayMs, remaining), options.signal)
      delayMs = Math.min(250, delayMs * 2)
    }
  }

  private ensureSupported(): void {
    if (this.platform !== 'win32') throw new ElectronUiDriverError('UNSUPPORTED', `Windows UI Automation is unavailable on ${this.platform}.`)
    if (!this.available()) throw new ElectronUiDriverError('NOT_READY', 'Windows UI Automation driver is not available.')
  }
}

function nativeActions(node: RawNativeNode): WindowsNativeNode['actions'] {
  if (node.enabled === false) return []
  const patterns = new Set(node.patterns ?? [])
  const actions: WindowsNativeNode['actions'] = ['focus']
  if (patterns.has('Invoke') || validBounds(node.bounds)) actions.push('click')
  if (patterns.has('Value')) actions.push('fill')
  if (patterns.has('SelectionItem')) actions.push('select')
  if (patterns.has('Window')) actions.push('minimize', 'maximize', 'restore', 'close')
  return actions
}

function backgroundNativeActions(node: RawNativeNode): WindowsNativeNode['backgroundActions'] {
  if (node.enabled === false) return []
  const patterns = new Set(node.patterns ?? [])
  const actions: WindowsNativeNode['backgroundActions'] = []
  if (patterns.has('Invoke')) actions.push('click')
  if (patterns.has('Value')) actions.push('fill')
  if (patterns.has('SelectionItem')) actions.push('select')
  if (patterns.has('Window')) actions.push('minimize', 'close')
  return actions
}

function flatten(nodes: RawNativeNode[], output: RawNativeNode[]): RawNativeNode[] {
  for (const node of nodes) {
    output.push(node)
    if (node.children) flatten(node.children, output)
  }
  return output
}

function bounded(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max) : '' }
function validBounds(value: RawNativeNode['bounds']): value is NonNullable<RawNativeNode['bounds']> {
  return !!value && [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.width >= 0 && value.height >= 0
}

function validNativeWindowHandle(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function runPowerShellUiAutomation(request: Record<string, unknown>): Promise<unknown> {
  const executable = process.env.CRAFT_UI_POWERSHELL || 'powershell.exe'
  const script = resolve(process.cwd(), 'scripts', 'craft-ui', 'windows-uia-driver.ps1')
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdin.end(JSON.stringify(request))
  const timeout = setTimeout(() => child.kill(), UI_VALIDATION_DEFAULT_TIMEOUT_MS)
  const [exitCode, stdout, stderr] = await Promise.all([
    new Promise<number | null>(resolveExit => child.once('exit', resolveExit)),
    streamText(child.stdout),
    streamText(child.stderr),
  ]).finally(() => clearTimeout(timeout))
  if (exitCode !== 0) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', `Windows UI Automation failed: ${stderr.slice(0, 2_000)}`)
  try { return JSON.parse(stdout) } catch (error) {
    const normalized = stdout.trim().replace(/[\r\n]+/g, ' ')
    const head = normalized.slice(0, 250)
    const tail = normalized.length > 250 ? normalized.slice(-250) : ''
    const summary = [head, tail].filter(Boolean).join(' ... ')
    const reason = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    throw new ElectronUiDriverError(
      'DRIVER_DISCONNECTED',
      `Windows UI Automation returned invalid JSON (${stdout.length} chars, ${reason})${summary ? `: ${summary}` : ' (empty output)'}.`,
    )
  }
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += String(chunk)
  return output
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Native wait was aborted.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
