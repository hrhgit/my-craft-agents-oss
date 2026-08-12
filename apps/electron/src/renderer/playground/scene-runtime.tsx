import * as React from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react'
import type { PreviewScene, PreviewScenePhase } from './registry/types'

const DEFAULT_FRAME_MS = 1_600

export interface SceneTimer {
  setTimeout(callback: () => void, delayMs?: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const browserTimer: SceneTimer = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle),
}

export interface StaticSceneEnvironment<State> {
  kind: 'static'
  label: string
  state: State
}

export interface TimelineSceneEnvironment<State> {
  kind: 'timeline'
  label?: string
  intervalMs: number
  autoPlay?: boolean
  loop?: boolean
  steps: ReadonlyArray<{ id: string; label: string; state: State; durationMs?: number }>
}

export type SceneEnvironment<State> = StaticSceneEnvironment<State> | TimelineSceneEnvironment<State>

export interface SceneRuntimeSnapshot<State> {
  kind: 'static' | 'timeline'
  label: string
  state: State
  index: number
  isPlaying: boolean
  canNavigate: boolean
  stepId?: string
  stepLabel?: string
}

export interface SceneRuntimeController<State> {
  getSnapshot(): SceneRuntimeSnapshot<State>
  subscribe(listener: () => void): () => void
  play(): void
  pause(): void
  replay(): void
  reset(): void
  previous(): void
  next(): void
  dispose(): void
}

/**
 * A dependency-free deterministic controller. React previews use the same
 * transition rules below, while this controller keeps the behavior testable
 * without browser timers or renderer state.
 */
export function createSceneRuntimeController<State>(
  environment: SceneEnvironment<State>,
  timer: SceneTimer = browserTimer,
): SceneRuntimeController<State> {
  if (environment.kind === 'static') {
    let disposed = false
    return {
      getSnapshot: () => ({ kind: 'static', label: environment.label, state: environment.state, index: 0, isPlaying: false, canNavigate: false }),
      subscribe: () => () => {},
      play: () => {},
      pause: () => {},
    replay: () => {},
      reset: () => {},
      previous: () => {},
      next: () => {},
      dispose: () => { disposed = true; void disposed },
    }
  }

  let index = 0
  let playing = environment.autoPlay !== false
  let disposed = false
  let pending: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())

  const clear = () => {
    if (pending !== undefined) timer.clearTimeout(pending)
    pending = undefined
  }
  const snapshot = (): SceneRuntimeSnapshot<State> => {
    const step = environment.steps[index]!
    return { kind: 'timeline', label: environment.label ?? 'Timeline scene', state: step.state, index, isPlaying: playing, canNavigate: environment.steps.length > 1, stepId: step.id, stepLabel: step.label }
  }
  const schedule = () => {
    clear()
    if (disposed || !playing || environment.steps.length < 2) return
    const step = environment.steps[index]!
    pending = timer.setTimeout(() => {
      pending = undefined
      if (disposed || !playing) return
      if (index === environment.steps.length - 1 && environment.loop === false) {
        playing = false
        notify()
        return
      }
      index = (index + 1) % environment.steps.length
      notify()
      schedule()
    }, step.durationMs ?? environment.intervalMs)
  }
  const move = (direction: 1 | -1) => {
    if (disposed || environment.steps.length < 2) return
    index = (index + direction + environment.steps.length) % environment.steps.length
    notify()
    schedule()
  }

  schedule()
  return {
    getSnapshot: snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    play: () => { if (!disposed) { playing = true; notify(); schedule() } },
    pause: () => { playing = false; clear(); notify() },
    replay: () => { if (!disposed) { index = 0; playing = true; notify(); schedule() } },
    reset: () => { if (!disposed) { index = 0; playing = environment.autoPlay !== false; notify(); schedule() } },
    previous: () => move(-1),
    next: () => move(1),
    dispose: () => { disposed = true; playing = false; clear(); listeners.clear() },
  }
}

export const defaultPreviewScene = (label = 'Default surface'): PreviewScene => ({
  kind: 'static',
  label,
})

function normalizedPhases(scene: PreviewScene): readonly PreviewScenePhase[] {
  const phases = scene.phases ?? []
  return scene.kind === 'timeline' && phases.length > 0
    ? phases
    : [{ id: 'default', label: scene.label }]
}

export function usePreviewScene(scene: PreviewScene, resetKey: string) {
  const phases = React.useMemo(() => normalizedPhases(scene), [scene])
  const environment = React.useMemo<SceneEnvironment<PreviewScenePhase>>(() => {
    if (scene.kind === 'static') return { kind: 'static', label: scene.label, state: phases[0]! }
    return {
      kind: 'timeline',
      label: scene.label,
      intervalMs: scene.frameDurationMs ?? DEFAULT_FRAME_MS,
      autoPlay: scene.autoPlay,
      loop: scene.loop,
      steps: phases.map(phase => ({ id: phase.id, label: phase.label, state: phase, durationMs: phase.durationMs })),
    }
  }, [phases, scene])
  const initialSnapshot = React.useMemo(() => ({
    kind: scene.kind,
    label: scene.label,
    state: phases[0]!,
    index: 0,
    isPlaying: scene.kind === 'timeline' && scene.autoPlay !== false,
    canNavigate: scene.kind === 'timeline' && phases.length > 1,
    stepId: scene.kind === 'timeline' ? phases[0]!.id : undefined,
    stepLabel: scene.kind === 'timeline' ? phases[0]!.label : undefined,
  }), [phases, scene.autoPlay, scene.kind, scene.label])
  const [snapshot, setSnapshot] = React.useState<SceneRuntimeSnapshot<PreviewScenePhase>>(initialSnapshot)
  const controllerRef = React.useRef<SceneRuntimeController<PreviewScenePhase> | null>(null)

  React.useEffect(() => {
    const controller = createSceneRuntimeController(environment)
    controllerRef.current = controller
    setSnapshot(controller.getSnapshot())
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.getSnapshot()))
    return () => {
      unsubscribe()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [environment, resetKey])

  return {
    phaseIndex: snapshot.index,
    phase: snapshot.state,
    playing: snapshot.isPlaying,
    isTimeline: scene.kind === 'timeline',
    replay: () => controllerRef.current?.replay(),
    previous: () => controllerRef.current?.previous(),
    next: () => controllerRef.current?.next(),
    togglePlaying: () => {
      const controller = controllerRef.current
      if (!controller) return
      if (controller.getSnapshot().isPlaying) controller.pause()
      else controller.play()
    },
  }
}

interface PreviewSceneFrameProps {
  scene: PreviewScene
  phase: PreviewScenePhase
  phaseIndex: number
  children: React.ReactNode
}

export function PreviewSceneFrame({ scene, phase, phaseIndex, children }: PreviewSceneFrameProps) {
  const content = scene.render?.({ children, phase, phaseIndex }) ?? children
  return (
    <div
      className="h-full w-full"
      data-playground-scene={scene.kind}
      data-playground-scene-phase={phase.id}
    >
      {content}
    </div>
  )
}

interface PreviewSceneControlsProps {
  label: string
  scene: PreviewScene
  phase: PreviewScenePhase
  playing: boolean
  onReplay(): void
  onPrevious(): void
  onNext(): void
  onTogglePlaying(): void
}

export function PreviewSceneControls({
  label,
  scene,
  phase,
  playing,
  onReplay,
  onPrevious,
  onNext,
  onTogglePlaying,
}: PreviewSceneControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" aria-label="Preview scene controls">
      <span className="rounded border border-border px-1.5 py-0.5 font-mono">{label}</span>
      {scene.kind === 'timeline' && (
        <>
          <span className="max-w-52 truncate">{phase.label}</span>
          <IconButton label="Previous scene phase" onClick={onPrevious}><ChevronLeft className="h-3.5 w-3.5" /></IconButton>
          <IconButton label={playing ? 'Pause scene' : 'Play scene'} onClick={onTogglePlaying}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton label="Next scene phase" onClick={onNext}><ChevronRight className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Replay scene" onClick={onReplay}><RotateCcw className="h-3.5 w-3.5" /></IconButton>
        </>
      )}
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded border border-border hover:bg-foreground/5 hover:text-foreground"
    >
      {children}
    </button>
  )
}
