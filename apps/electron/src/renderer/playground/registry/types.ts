import type { ComponentType, ReactNode } from 'react'

export type ControlType =
  | { type: 'boolean' }
  | { type: 'string'; placeholder?: string }
  | { type: 'textarea'; placeholder?: string; rows?: number }
  | { type: 'number'; min?: number; max?: number; step?: number }
  | { type: 'select'; options: Array<{ label: string; value: string }> }

export interface PropDefinition {
  name: string
  description?: string
  control: ControlType
  defaultValue: unknown
}

export interface ComponentVariant {
  name: string
  description?: string
  props: Record<string, unknown>
}

export interface ComponentSource {
  file: string
  symbol: string
  coverage: 'standalone' | 'page-scene' | 'contained' | 'exempt'
}

export interface PreviewScenePhase {
  id: string
  label: string
  durationMs?: number
  props?: Record<string, unknown>
}

export interface PreviewScene {
  kind: 'static' | 'timeline'
  label: string
  frameDurationMs?: number
  /** Timeline repeats from its first phase unless explicitly disabled. */
  loop?: boolean
  /** Timelines start playing unless explicitly disabled. */
  autoPlay?: boolean
  phases?: readonly PreviewScenePhase[]
  render?: (input: { children: ReactNode; phase: PreviewScenePhase; phaseIndex: number }) => ReactNode
}

export type Category = 'Automations' | 'Mobile WebUI' | 'Onboarding' | 'Agent Setup' | 'Chat' | 'Island' | 'Browser' | 'Planner' | 'Custom Shadows' | 'Session List' | 'Entity Lists' | 'Edit Popover' | 'Turn Cards' | 'TurnCard Modes' | 'Fullscreen' | 'Chat Messages' | 'Chat Inputs' | 'Toast Messages' | 'Markdown' | 'Icons' | 'Settings' | 'Messaging' | 'Feedback' | 'OAuth' | 'Catalog'

export interface ComponentEntry {
  id: string
  name: string
  category: Category
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>
  props: PropDefinition[]
  variants?: ComponentVariant[]
  /** Returns mock data to merge with props (callbacks, complex objects) */
  mockData?: () => Record<string, unknown>
  /** Optional wrapper component for context providers */
  wrapper?: ComponentType<{ children: ReactNode }>
  /** Layout mode: 'centered' (default), 'top' for scrollable content, 'full' for full-height flex layout */
  layout?: 'centered' | 'top' | 'full'
  /** Optional preview overflow override for the component preview box */
  previewOverflow?: 'auto' | 'hidden' | 'visible'
  /** Source UI represented by this entry. The registry normalizes legacy entries. */
  source?: ComponentSource
  /** Context that makes the component visible and useful in the preview. */
  scene?: PreviewScene
}

export type RegisteredComponentEntry = ComponentEntry & {
  source: ComponentSource
  scene: PreviewScene
}

export interface CategoryGroup {
  name: Category
  components: ComponentEntry[]
}
