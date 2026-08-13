import { describe, expect, it } from 'bun:test'
import {
  collectOrphanedProcesses,
  isTestOrBuildProcess,
  type ProcessEntry,
} from './reap-orphaned-processes.ts'

function entry(pid: number, ppid: number, commandLine: string): ProcessEntry {
  return { pid, ppid, name: 'bun.exe', commandLine }
}

describe('reap orphaned processes', () => {
  it('matches Mortise test and build commands in this repository', () => {
    expect(isTestOrBuildProcess(entry(100, 1, 'bun.exe test --isolate packages/shared/src/agent/__tests__/pi-agent-abort.test.ts'))).toBe(true)
    expect(isTestOrBuildProcess(entry(100, 1, 'bun run scripts/run-isolated-tests.ts'))).toBe(true)
    expect(isTestOrBuildProcess(entry(100, 1, 'bun.exe E:\\_workSpace\\_Agents\\craft-agent\\scripts\\mortise-ui\\test-host.fixture.ts'))).toBe(true)
    expect(isTestOrBuildProcess(entry(100, 1, 'bun run scripts/build/produce-electron-build.ts --mode ui-validation'))).toBe(true)
    expect(isTestOrBuildProcess(entry(100, 1, 'bun run scripts/build-developer-kit.ts'))).toBe(true)
  })

  it('does not match dev servers, unrelated projects, or ordinary commands', () => {
    expect(isTestOrBuildProcess(entry(100, 1, 'node vite.js dev --config apps/electron/vite.config.ts --open /playground.html'))).toBe(false)
    expect(isTestOrBuildProcess(entry(100, 1, 'bun.exe test --isolate other-project/packages/foo.test.ts'))).toBe(false)
    expect(isTestOrBuildProcess(entry(100, 1, 'C:\\Windows\\System32\\svchost.exe'))).toBe(false)
    expect(isTestOrBuildProcess(entry(100, 1, 'bun run scripts/server.ts'))).toBe(false)
  })

  it('collects only processes whose parent is no longer alive', () => {
    const processes = [
      entry(200, 1, 'bun.exe test --isolate packages/shared/src/agent/__tests__/pi-agent-abort.test.ts'),
      entry(201, 200, 'bun.exe test --isolate packages/shared/src/agent/__tests__/pi-agent-child-sessions.test.ts'),
      entry(300, 250, 'bun.exe test --isolate packages/shared/src/agent/__tests__/live-parent.test.ts'),
      entry(250, 1, 'bun.exe test --isolate packages/shared/src/agent/__tests__/parent-alive.test.ts'),
    ]
    const orphaned = collectOrphanedProcesses(processes)
    expect(orphaned.map(item => item.pid)).toEqual([200, 250])
  })

  it('ignores entries without a valid parent or pid', () => {
    const processes = [
      entry(0, 1, 'bun.exe test --isolate packages/shared/foo.test.ts'),
      entry(1, 0, 'bun.exe test --isolate packages/shared/foo.test.ts'),
    ]
    expect(collectOrphanedProcesses(processes)).toEqual([])
  })
})
