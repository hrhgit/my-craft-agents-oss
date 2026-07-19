import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { WindowsNativeUiDriver, runPowerShellUiAutomation } = await import('../windows-native-driver')

function fakeChild(pid = 4321): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    exitCode: null,
    signalCode: null,
    kill: mock(() => true),
    unref: mock(() => child),
  })
  return child
}

describe('WindowsNativeUiDriver', () => {
  it('binds refs to revisions and reports native verification', async () => {
    let name = 'Open'
    const requests: Record<string, unknown>[] = []
    const driver = new WindowsNativeUiDriver(42, async request => {
      requests.push(request)
      if (request.operation === 'action') { name = 'Opened'; return { ok: true } }
      return { windows: [{ runtimeId: '1', role: 'Window', name: 'Mortise', enabled: true, focused: true, children: [
        { runtimeId: '1.2', role: 'Button', name, enabled: true, focused: false, patterns: ['Invoke'], children: [] },
      ] }] }
    }, 'win32')
    const snapshot = await driver.snapshot()
    expect(driver.available()).toBeTrue()
    expect(snapshot.verificationLevel).toBe('native-verified')
    const target = snapshot.windows[0]!.nodes.find(node => node.name === 'Open')!
    expect(target.actions).toContain('click')
    expect(target.backgroundActions).toContain('click')
    const receipt = await driver.action({ revision: snapshot.revision, ref: target.ref, action: 'click' })
    expect(receipt.verificationLevel).toBe('native-verified')
    expect(receipt.afterRevision).toBeGreaterThan(receipt.beforeRevision)
    expect(requests.some(request => request.operation === 'action' && request.runtimeId === '1.2')).toBeTrue()
  })

  it('rejects stale refs and unsupported platforms', async () => {
    const runner = async () => ({ windows: [{ runtimeId: '1', role: 'Window', name: 'Mortise', enabled: true, focused: true, children: [] }] })
    const driver = new WindowsNativeUiDriver(42, runner, 'win32')
    const snapshot = await driver.snapshot()
    await expect(driver.action({ revision: snapshot.revision - 1, ref: 'n0:stale', action: 'focus' })).rejects.toMatchObject({ code: 'STALE_REF' })
    const unsupported = new WindowsNativeUiDriver(42, runner, 'linux')
    expect(unsupported.available()).toBeFalse()
    await expect(unsupported.snapshot()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('does not invalidate a published ref with a hidden pre-action snapshot', async () => {
    let snapshotReads = 0
    const driver = new WindowsNativeUiDriver(42, async request => {
      if (request.operation === 'action') return { ok: true }
      snapshotReads += 1
      return { windows: [{
        runtimeId: '1', role: 'Window', name: 'Mortise', enabled: true,
        focused: snapshotReads > 1, patterns: ['Window'], children: [],
      }] }
    }, 'win32')
    const snapshot = await driver.snapshot()
    const target = snapshot.windows[0]!.nodes[0]!

    const receipt = await driver.action({ revision: snapshot.revision, ref: target.ref, action: 'focus' })

    expect(receipt.beforeRevision).toBe(snapshot.revision)
    expect(snapshotReads).toBe(2)
  })

  it('waits in the native driver until a target appears', async () => {
    let reads = 0
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: '1', role: 'Window', name: 'Mortise', enabled: true, focused: true,
      children: ++reads > 1 ? [{ runtimeId: '2', role: 'Window', name: 'Folder picker', enabled: true, focused: true, patterns: ['Window'] }] : [],
    }] }), 'win32')
    const result = await driver.waitForNode(node => node.name === 'Folder picker', { timeoutMs: 500 })
    expect(result.node.actions).toContain('close')
    expect(reads).toBe(2)
  })

  it('advertises only pattern-backed operations as background-safe', async () => {
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: 'root', role: 'Window', name: 'Mortise', nativeWindowHandle: 9001, enabled: true, focused: false,
      patterns: ['Window'], children: [
        { runtimeId: 'invoke', role: 'Button', name: 'Invoke', enabled: true, focused: false, patterns: ['Invoke'], bounds: { x: 1, y: 1, width: 10, height: 10 } },
        { runtimeId: 'coordinate', role: 'Button', name: 'Coordinate', enabled: true, focused: false, bounds: { x: 1, y: 1, width: 10, height: 10 } },
        { runtimeId: 'value', role: 'Edit', name: 'Value', enabled: true, focused: false, patterns: ['Value'] },
      ],
    }] }), 'win32')

    const snapshot = await driver.snapshot()
    const nodes = snapshot.windows[0]!.nodes
    expect(nodes.find(node => node.name === 'Mortise')).toMatchObject({
      nativeWindowHandle: 9001,
      backgroundActions: ['minimize', 'close'],
    })
    expect(nodes.find(node => node.name === 'Invoke')!.backgroundActions).toEqual(['click'])
    expect(nodes.find(node => node.name === 'Coordinate')!.actions).toContain('click')
    expect(nodes.find(node => node.name === 'Coordinate')!.backgroundActions).toEqual([])
    expect(nodes.find(node => node.name === 'Value')!.backgroundActions).toEqual(['fill'])
  })

  it('rejects when PowerShell fails to spawn', async () => {
    const child = fakeChild()
    const spawnProcess = mock(() => child)
    const result = runPowerShellUiAutomation({ operation: 'snapshot' }, {
      timeoutMs: 500,
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
    })

    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))

    await expect(result).rejects.toMatchObject({
      code: 'DRIVER_DISCONNECTED',
      message: expect.stringContaining('spawn ENOENT'),
    })
  })

  it('rejects on the hard timeout and escalates a hanging process-tree termination', async () => {
    const child = fakeChild()
    const taskkill = fakeChild(9876)
    const calls: Array<{ executable: string; args: string[] }> = []
    const spawnProcess = mock((executable: string, args: string[]) => {
      calls.push({ executable, args })
      return calls.length === 1 ? child : taskkill
    })

    const startedAt = Date.now()
    await expect(runPowerShellUiAutomation({ operation: 'snapshot' }, {
      timeoutMs: 5,
      terminationGraceMs: 5,
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
    })).rejects.toMatchObject({ code: 'TIMEOUT' })

    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(calls[1]).toEqual({
      executable: 'taskkill.exe',
      args: ['/PID', '4321', '/T', '/F'],
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
