import { execFileSync } from 'node:child_process'

const UNIX_EPOCH_DOTNET_TICKS = 621355968000000000
const PROCESS_START_TIME_TOLERANCE_MS = 2_000

export interface MortiseUiProcessIdentity {
  pid?: number
  startedAt?: number
  recordedAt?: number
}

export function getProcessStartTime(pid: number | undefined): number | undefined {
  if (!validPid(pid) || process.platform !== 'win32') return undefined
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; $process.StartTime.ToUniversalTime().Ticks`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
    const ticks = Number(output)
    if (!Number.isFinite(ticks) || ticks <= UNIX_EPOCH_DOTNET_TICKS) return undefined
    return (ticks - UNIX_EPOCH_DOTNET_TICKS) / 10_000
  } catch {
    return undefined
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!validPid(pid)) return false
  try { process.kill(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES'
  }
}

export function matchesProcessIdentity(identity: MortiseUiProcessIdentity): boolean {
  if (!isProcessAlive(identity.pid)) return false
  if (identity.pid === process.pid) return true
  const observed = getProcessStartTime(identity.pid)
  if (observed === undefined) return true
  return !isProcessIdentityMismatch(identity, observed)
}

export function isProcessIdentityMismatch(identity: Omit<MortiseUiProcessIdentity, 'pid'>, observed: number | undefined): boolean {
  if (observed === undefined) return false
  if (identity.startedAt !== undefined) return Math.abs(observed - identity.startedAt) > PROCESS_START_TIME_TOLERANCE_MS
  if (identity.recordedAt !== undefined) return observed > identity.recordedAt + PROCESS_START_TIME_TOLERANCE_MS
  return false
}

function validPid(pid: number | undefined): pid is number {
  return Number.isInteger(pid) && pid! > 0
}
