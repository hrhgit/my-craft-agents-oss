import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS, UI_VALIDATION_MAX_WAIT_MS } from '@mortise/shared/ui-validation'
import { ElectronUiDriverError, type UiVerificationLevel } from './electron-surface-driver'
import { resolveWindowsUiAutomationDriverPath } from './windows-native-driver-path'

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
    const target = this.resolvePublishedTarget(request)
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

  resolvePublishedTarget(request: Pick<WindowsNativeActionRequest, 'revision' | 'ref'>): WindowsNativeNode {
    if (request.revision !== this.revision || !request.ref.startsWith(`n${this.revision}:`)) {
      throw new ElectronUiDriverError('STALE_REF', `Native ref does not belong to revision ${this.revision}.`)
    }
    const target = this.refs.get(request.ref)
    if (!target) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown native target ${request.ref}.`)
    return target
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

interface PowerShellRunnerOptions {
  timeoutMs?: number
  terminationGraceMs?: number
  spawnProcess?: typeof spawn
}

export async function runPowerShellUiAutomation(
  request: Record<string, unknown>,
  options: PowerShellRunnerOptions = {},
): Promise<unknown> {
  const executable = process.env.MORTISE_UI_POWERSHELL || 'powershell.exe'
  const script = resolveWindowsUiAutomationDriverPath()
  const spawnProcess = options.spawnProcess ?? spawn
  const timeoutMs = options.timeoutMs ?? UI_VALIDATION_DEFAULT_TIMEOUT_MS
  const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  child.stdin.on('error', () => {})
  const exit = waitForPowerShellExit(child, timeoutMs, spawnProcess, options.terminationGraceMs)
  const stdout = streamText(child.stdout)
  const stderr = streamText(child.stderr)
  child.stdin.end(JSON.stringify(request))
  const [exitCode, stdoutText, stderrText] = await Promise.all([exit, stdout, stderr])
  if (exitCode !== 0) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', `Windows UI Automation failed: ${stderrText.slice(0, 2_000)}`)
  try { return JSON.parse(stdoutText) } catch (error) {
    const normalized = stdoutText.trim().replace(/[\r\n]+/g, ' ')
    const head = normalized.slice(0, 250)
    const tail = normalized.length > 250 ? normalized.slice(-250) : ''
    const summary = [head, tail].filter(Boolean).join(' ... ')
    const reason = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    throw new ElectronUiDriverError(
      'DRIVER_DISCONNECTED',
      `Windows UI Automation returned invalid JSON (${stdoutText.length} chars, ${reason})${summary ? `: ${summary}` : ' (empty output)'}.`,
    )
  }
}

async function waitForPowerShellExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  spawnProcess: typeof spawn,
  terminationGraceMs = 1_000,
): Promise<number | null> {
  return await new Promise<number | null>((resolveExit, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onError = (error: Error) => finish(() => {
      reject(new ElectronUiDriverError('DRIVER_DISCONNECTED', `Windows UI Automation failed to start: ${error.message}`))
    })
    const onExit = (code: number | null) => finish(() => resolveExit(code))
    const timeout = setTimeout(() => finish(() => {
      terminateWindowsProcessTree(child, spawnProcess, terminationGraceMs)
      reject(new ElectronUiDriverError('TIMEOUT', `Windows UI Automation timed out after ${timeoutMs}ms.`))
    }), timeoutMs)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function terminateWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
  spawnProcess: typeof spawn,
  terminationGraceMs: number,
): void {
  const forceKill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  if (!child.pid) {
    forceKill()
    return
  }
  let taskkill: ReturnType<typeof spawn>
  try {
    taskkill = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    forceKill()
    return
  }
  let completed = false
  const escalation = setTimeout(() => {
    if (completed) return
    completed = true
    taskkill.kill('SIGKILL')
    forceKill()
  }, Math.max(1, terminationGraceMs))
  escalation.unref()
  const complete = (failed: boolean) => {
    if (completed) return
    completed = true
    clearTimeout(escalation)
    if (failed) forceKill()
  }
  taskkill.once('error', () => complete(true))
  taskkill.once('exit', code => complete(code !== 0))
  taskkill.unref()
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
