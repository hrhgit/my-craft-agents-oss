import { describe, expect, it } from 'bun:test'
import {
  createTestProcessLifecycle,
  installTestProcessLifecycle,
  type TestProcessLifecycle,
  windowsProcessTreeKillCommand,
} from './test-process-lifecycle.ts'

function fakeScheduler() {
  let callback: (() => void) | undefined
  let unrefCount = 0
  let cancelCount = 0
  const handle = {
    unref: () => {
      unrefCount += 1
      return handle
    },
  } as unknown as ReturnType<typeof setInterval>

  return {
    schedule(next: () => void): ReturnType<typeof setInterval> {
      callback = next
      return handle
    },
    cancel(received: ReturnType<typeof setInterval>): void {
      expect(received).toBe(handle)
      cancelCount += 1
    },
    tick(): void {
      callback?.()
    },
    counts(): { unref: number; cancel: number } {
      return { unref: unrefCount, cancel: cancelCount }
    },
  }
}

describe('test process lifecycle', () => {
  it('keeps the test process running while its parent is alive', () => {
    const scheduler = fakeScheduler()
    const terminated: number[] = []
    const lifecycle = createTestProcessLifecycle({
      platform: 'win32',
      parentPid: 100,
      currentPid: 200,
      isProcessAlive: () => true,
      terminateProcessTree: pid => terminated.push(pid),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })

    expect(lifecycle).toBeDefined()
    expect(scheduler.counts()).toEqual({ unref: 1, cancel: 0 })
    scheduler.tick()
    expect(terminated).toEqual([])
    expect(scheduler.counts()).toEqual({ unref: 1, cancel: 0 })
    lifecycle?.stop()
  })

  it('terminates the current Windows test process tree after its parent exits', () => {
    const scheduler = fakeScheduler()
    const terminated: number[] = []
    const lifecycle = createTestProcessLifecycle({
      platform: 'win32',
      parentPid: 100,
      currentPid: 200,
      isProcessAlive: () => false,
      terminateProcessTree: pid => terminated.push(pid),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })

    lifecycle?.checkParent()
    lifecycle?.checkParent()

    expect(terminated).toEqual([200])
    expect(scheduler.counts()).toEqual({ unref: 1, cancel: 1 })
  })

  it('uses taskkill to force-stop the selected process and all descendants', () => {
    expect(windowsProcessTreeKillCommand(200)).toEqual({
      executable: 'taskkill.exe',
      args: ['/PID', '200', '/T', '/F'],
    })
  })

  it('does not install a monitor outside Windows', () => {
    let scheduled = false
    const lifecycle = createTestProcessLifecycle({
      platform: 'linux',
      parentPid: 100,
      currentPid: 200,
      schedule: () => {
        scheduled = true
        return {} as ReturnType<typeof setInterval>
      },
    })

    expect(lifecycle).toBeUndefined()
    expect(scheduled).toBe(false)
  })

  it('reuses the installed monitor when the preload is loaded again', () => {
    const scheduler = fakeScheduler()
    const registry: Record<symbol, TestProcessLifecycle | undefined> = {}
    const options = {
      platform: 'win32' as const,
      parentPid: 100,
      currentPid: 200,
      registry,
      isProcessAlive: () => true,
      terminateProcessTree: () => undefined,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    }

    const first = installTestProcessLifecycle(options)
    const second = installTestProcessLifecycle(options)

    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(scheduler.counts()).toEqual({ unref: 1, cancel: 0 })
    first?.stop()
  })
})
