import { execFileSync, spawn } from 'node:child_process'

export interface ProcessEntry {
  pid: number
  ppid: number
  name: string
  commandLine: string
}

const TEST_OR_BUILD_PATTERNS: readonly RegExp[] = [
  /\bbun(?:\.exe)? test\b/i,
  /--isolate/i,
  /test-host\.fixture/i,
  /run-isolated-tests/i,
  /produce-electron-build|stage-electron-packaging|electron-build/i,
  /build-developer-kit/i,
]

const PROJECT_PATH_PATTERN = /craft-agent|mortise|packages[\\/]shared|packages[\\/]server-core|pi[\\/]packages|apps[\\/]electron|scripts[\\/]mortise-ui|scripts[\\/]build|scripts[\\/]run-isolated|scripts[\\/]e2e/i

export function isTestOrBuildProcess(entry: ProcessEntry): boolean {
  if (!PROJECT_PATH_PATTERN.test(entry.commandLine)) return false
  return TEST_OR_BUILD_PATTERNS.some(pattern => pattern.test(entry.commandLine))
}

export function collectOrphanedProcesses(entries: readonly ProcessEntry[]): ProcessEntry[] {
  const livePids = new Set(entries.map(entry => entry.pid))
  return entries
    .filter(entry => entry.pid > 0 && entry.ppid > 0)
    .filter(entry => isTestOrBuildProcess(entry))
    .filter(entry => !livePids.has(entry.ppid))
}

export function enumerateWindowsProcesses(): ProcessEntry[] {
  if (process.platform !== 'win32') return []
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
    if (!output) return []
    const parsed = JSON.parse(output) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row): ProcessEntry[] => {
      if (!row || typeof row !== 'object') return []
      const record = row as Record<string, unknown>
      const pid = Number(record.ProcessId)
      const ppid = Number(record.ParentProcessId)
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid <= 0) return []
      return [{
        pid,
        ppid,
        name: String(record.Name ?? ''),
        commandLine: String(record.CommandLine ?? ''),
      }]
    })
  } catch {
    return []
  }
}

export function terminateProcessTree(pid: number): void {
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  killer.unref()
}

const args = process.argv.slice(2)
const apply = args.some(arg => arg.toLowerCase() === '--apply')
for (const arg of args) {
  if (arg !== '--apply') throw new Error(`Unsupported orphan reaper argument: ${arg}`)
}

const orphaned = collectOrphanedProcesses(enumerateWindowsProcesses())

if (orphaned.length === 0) {
  process.stdout.write('No orphaned Mortise test/build processes found.\n')
} else {
  process.stdout.write(`Found ${orphaned.length} orphaned Mortise test/build process${orphaned.length === 1 ? '' : 'es'}:\n`)
  for (const entry of orphaned) {
    process.stdout.write(`  pid=${entry.pid} ppid=${entry.ppid} ${entry.name} ${entry.commandLine.slice(0, 160)}\n`)
  }
  if (apply) {
    for (const entry of orphaned) terminateProcessTree(entry.pid)
    process.stdout.write('Orphaned processes terminated.\n')
  } else {
    process.stdout.write('Dry-run: pass --apply to terminate them.\n')
  }
}
