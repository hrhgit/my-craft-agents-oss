import { describe, expect, it } from 'bun:test'
import {
  createSceneRuntimeController,
  type SceneTimer,
  type TimelineSceneEnvironment,
} from '../scene-runtime'

class ManualTimer implements SceneTimer {
  private nextId = 0
  private callbacks = new Map<number, () => void>()

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.callbacks.delete(handle as unknown as number)
  }

  get pendingCount(): number {
    return this.callbacks.size
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('No scheduled timer')
    this.callbacks.delete(entry[0])
    entry[1]()
  }
}

const timeline: TimelineSceneEnvironment<string> = {
  kind: 'timeline',
  intervalMs: 1000,
  steps: [
    { id: 'idle', label: 'Idle', state: 'idle' },
    { id: 'streaming', label: 'Streaming', state: 'streaming', durationMs: 250 },
  ],
}

describe('scene runtime', () => {
  it('exposes a stable static scene without a timer', () => {
    const timer = new ManualTimer()
    const controller = createSceneRuntimeController({ kind: 'static', state: 'dialog-open', label: 'Dialog open' }, timer)

    expect(controller.getSnapshot()).toMatchObject({
      kind: 'static',
      state: 'dialog-open',
      index: 0,
      isPlaying: false,
      canNavigate: false,
    })
    expect(timer.pendingCount).toBe(0)
  })

  it('loops deterministic timeline states while playing', () => {
    const timer = new ManualTimer()
    const controller = createSceneRuntimeController(timeline, timer)

    expect(controller.getSnapshot()).toMatchObject({ state: 'idle', index: 0, isPlaying: true })
    expect(timer.pendingCount).toBe(1)

    timer.runNext()
    expect(controller.getSnapshot()).toMatchObject({ state: 'streaming', index: 1, isPlaying: true })

    timer.runNext()
    expect(controller.getSnapshot()).toMatchObject({ state: 'idle', index: 0, isPlaying: true })
  })

  it('pauses, resumes, and replays a timeline from its initial state', () => {
    const timer = new ManualTimer()
    const controller = createSceneRuntimeController(timeline, timer)

    controller.pause()
    expect(controller.getSnapshot().isPlaying).toBe(false)
    expect(timer.pendingCount).toBe(0)

    controller.play()
    expect(controller.getSnapshot().isPlaying).toBe(true)
    timer.runNext()
    expect(controller.getSnapshot().state).toBe('streaming')

    controller.replay()
    expect(controller.getSnapshot()).toMatchObject({ state: 'idle', index: 0, isPlaying: true })
    expect(timer.pendingCount).toBe(1)
  })

  it('supports manual previous and next navigation, including loop boundaries', () => {
    const timer = new ManualTimer()
    const controller = createSceneRuntimeController({ ...timeline, autoPlay: false }, timer)

    controller.previous()
    expect(controller.getSnapshot()).toMatchObject({ state: 'streaming', index: 1 })
    controller.next()
    expect(controller.getSnapshot()).toMatchObject({ state: 'idle', index: 0 })
    expect(timer.pendingCount).toBe(0)
  })

  it('resets to the configured initial state and clears timers when disposed', () => {
    const timer = new ManualTimer()
    const controller = createSceneRuntimeController(timeline, timer)

    timer.runNext()
    controller.reset()
    expect(controller.getSnapshot()).toMatchObject({ state: 'idle', index: 0, isPlaying: true })
    expect(timer.pendingCount).toBe(1)

    controller.dispose()
    expect(timer.pendingCount).toBe(0)
    expect(controller.getSnapshot().isPlaying).toBe(false)
  })

  it('stops at the final state when looping is disabled', () => {
    const timer = new ManualTimer()
    const controller = createSceneRuntimeController({ ...timeline, loop: false }, timer)

    timer.runNext()
    expect(controller.getSnapshot()).toMatchObject({ state: 'streaming', index: 1, isPlaying: true })
    timer.runNext()
    expect(controller.getSnapshot()).toMatchObject({ state: 'streaming', index: 1, isPlaying: false })
    expect(timer.pendingCount).toBe(0)
  })
})
