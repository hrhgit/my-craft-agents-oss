export type UiSemanticAction = 'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text' | 'focus' | 'clear' | 'submit' | 'stop'

export interface UiSemanticState {
  disabled?: boolean
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  busy?: boolean
  focused?: boolean
  hidden?: boolean
  readonly?: boolean
}

export interface UiSemanticActionInput {
  value?: string
}

export interface UiSemanticDefinition {
  id: string
  role: string
  name: string | (() => string)
  description?: string | (() => string | undefined)
  value?: string | (() => string | undefined)
  sensitive?: boolean
  state?: UiSemanticState | (() => UiSemanticState)
  actions: readonly UiSemanticAction[]
  /** Physical input capabilities implemented by this concrete component. */
  physicalActions?: readonly UiSemanticAction[]
  invoke?: (action: UiSemanticAction, input: UiSemanticActionInput) => void | Promise<void>
}

export interface UiBusinessSemanticNode {
  id: string
  testId?: string
  role: string
  name: string
  description?: string
  value?: string
  state: UiSemanticState
  actions: UiSemanticAction[]
  actionModes: {
    semantic: UiSemanticAction[]
    physical: UiSemanticAction[]
  }
  domSelector: string
}

export interface UiBusinessSemanticSnapshot {
  schemaVersion: 1
  revision: number
  nodes: UiBusinessSemanticNode[]
  truncated: boolean
  limits: { maxNodes: number; maxStringLength: number }
}

export interface UiSemanticBridge {
  readonly schemaVersion: 1
  snapshot(options?: { maxNodes?: number; maxStringLength?: number }): UiBusinessSemanticSnapshot
  action(request: { id: string; action: UiSemanticAction; value?: string }): Promise<{ beforeRevision: number; afterRevision: number }>
}

declare global {
  interface Window {
    __mortiseUiValidation?: Partial<UiSemanticBridge> & { revision?: number; semanticRevision?: number; semanticBridgeInstalled?: true }
  }
}
