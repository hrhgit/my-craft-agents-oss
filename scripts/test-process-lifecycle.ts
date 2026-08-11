import { spawn } from 'node:child_process'

const TEST_PROCESS_LIFECYCLE_KEY = Symbol.for('mortise.test-process-lifecycle')
const DEFAULT_PARENT_CHECK_INTERVAL_MS = 1_000

type IntervalHandle = ReturnType<typeof setInterval>

export interface TestProcessLifecycle {
  checkParent(): void
  stop(): void
}

export interface TestProcessLifecycleOptions {
  platform?: NodeJS.Platform
  parentPid?: number
  currentPid?: number
  intervalMs?: number
  isProcessAlive?: (pid: number) => boolean
  terminateProcessTree?: (pid: number) => void
  schedule?: (callback: () => void, intervalMs: number) => IntervalHandle
  cancel?: (handle: IntervalHandle) => void
}

export interface InstallTestProcessLifecycleOptions extends TestProcessLifecycleOptions {
  registry?: Record<symbol, TestProcessLifecycle | undefined>
}

export function isTestProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES'
  }
}

export function windowsProcessTreeKillCommand(pid: number): {
  executable: string
  args: string[]
} {
  return {
    executable: 'taskkill.exe',
    args: ['/PID', String(pid), '/T', '/F'],
  }
}

export function terminateWindowsProcessTree(pid: number): void {
  const command = windowsProcessTreeKillCommand(pid)
  const killer = spawn(command.executable, command.args, {
    windowsHide: true,
    stdio: 'ignore',
  })
  killer.unref()
}

export function createTestProcessLifecycle(
  options: TestProcessLifecycleOptions = {},
): TestProcessLifecycle | undefined {
  const platform = options.platform ?? process.platform
  const parentPid = options.parentPid ?? process.ppid
  const currentPid = options.currentPid ?? process.pid
  if (platform !== 'win32' || parentPid <= 0 || currentPid <= 0) return undefined

  const isProcessAlive = options.isProcessAlive ?? isTestProcessAlive
  const terminateProcessTree = options.terminateProcessTree ?? terminateWindowsProcessTree
  const schedule = options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs))
  const cancel = options.cancel ?? (handle => clearInterval(handle))
  let cleanupStarted = false
  let stopped = false

  const checkParent = (): void => {
    if (stopped || cleanupStarted || isProcessAlive(parentPid)) return
    cleanupStarted = true
    cancel(timer)
    terminateProcessTree(currentPid)
  }

  const timer = schedule(checkParent, options.intervalMs ?? DEFAULT_PARENT_CHECK_INTERVAL_MS)
  timer.unref?.()

  return {
    checkParent,
    stop(): void {
      if (stopped) return
      stopped = true
      cancel(timer)
    },
  }
}

export function installTestProcessLifecycle(
  options: InstallTestProcessLifecycleOptions = {},
): TestProcessLifecycle | undefined {
  const registry = options.registry ?? (process as unknown as Record<symbol, TestProcessLifecycle | undefined>)
  const existing = registry[TEST_PROCESS_LIFECYCLE_KEY]
  if (existing) return existing

  const lifecycle = createTestProcessLifecycle(options)
  if (lifecycle) registry[TEST_PROCESS_LIFECYCLE_KEY] = lifecycle
  return lifecycle
}

installTestProcessLifecycle()
