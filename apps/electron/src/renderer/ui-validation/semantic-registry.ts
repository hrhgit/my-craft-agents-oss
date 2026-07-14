import type {
  UiBusinessSemanticNode,
  UiBusinessSemanticSnapshot,
  UiSemanticAction,
  UiSemanticActionInput,
  UiSemanticDefinition,
  UiSemanticState,
} from './types'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/
const DEFAULT_MAX_NODES = 1_000
const HARD_MAX_NODES = 2_000
const DEFAULT_MAX_STRING_LENGTH = 2_048
const HARD_MAX_STRING_LENGTH = 8_192

interface Entry {
  definition: UiSemanticDefinition
  token: symbol
  fingerprint: string
}

export class UiSemanticRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private currentRevision = 0

  get revision(): number { return this.currentRevision }

  register(definition: UiSemanticDefinition): { update: (next: UiSemanticDefinition) => void; dispose: () => void } {
    validateDefinition(definition)
    const token = Symbol(definition.id)
    const prior = this.entries.get(definition.id)
    if (prior) throw new Error(`Duplicate UI semantic id: ${definition.id}`)
    this.entries.set(definition.id, { definition, token, fingerprint: definitionFingerprint(definition) })
    this.changed()
    return {
      update: (next) => {
        validateDefinition(next)
        if (next.id !== definition.id) throw new Error('A UI semantic registration cannot change its id.')
        const current = this.entries.get(next.id)
        if (!current || current.token !== token) return
        const fingerprint = definitionFingerprint(next)
        current.definition = next
        if (current.fingerprint !== fingerprint) {
          current.fingerprint = fingerprint
          this.changed()
        }
      },
      dispose: () => {
        const current = this.entries.get(definition.id)
        if (!current || current.token !== token) return
        this.entries.delete(definition.id)
        this.changed()
      },
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(options: { maxNodes?: number; maxStringLength?: number } = {}): UiBusinessSemanticSnapshot {
    const maxNodes = boundedInteger(options.maxNodes, DEFAULT_MAX_NODES, 1, HARD_MAX_NODES)
    const maxStringLength = boundedInteger(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH, 32, HARD_MAX_STRING_LENGTH)
    const definitions = [...this.entries.values()].map(entry => entry.definition).sort((a, b) => a.id.localeCompare(b.id))
    const nodes: UiBusinessSemanticNode[] = []
    for (const definition of definitions.slice(0, maxNodes)) {
      const sensitive = definition.sensitive === true
      const value = resolveValue(definition.value)
      nodes.push({
        id: definition.id,
        role: clip(definition.role, maxStringLength),
        name: clip(resolveRequired(definition.name), maxStringLength),
        description: clipOptional(resolveValue(definition.description), maxStringLength),
        value: value === undefined ? undefined : sensitive ? '[REDACTED]' : clip(value, maxStringLength),
        state: sanitizeState(resolveState(definition.state)),
        actions: [...new Set([...definition.actions, ...(definition.physicalActions ?? [])])],
        actionModes: {
          semantic: [...new Set(definition.actions)],
          physical: [...new Set(definition.physicalActions ?? [])],
        },
        domSelector: `[data-craft-semantic-id="${cssEscape(definition.id)}"]`,
      })
    }
    return {
      schemaVersion: 1,
      revision: this.currentRevision,
      nodes,
      truncated: definitions.length > nodes.length,
      limits: { maxNodes, maxStringLength },
    }
  }

  async invoke(id: string, action: UiSemanticAction, input: UiSemanticActionInput = {}): Promise<{ beforeRevision: number; afterRevision: number }> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`UI semantic target not found: ${id}`)
    if (!entry.definition.actions.includes(action)) throw new Error(`UI semantic action ${action} is not allowed for ${id}`)
    const state = resolveState(entry.definition.state)
    if (state.disabled) throw new Error(`UI semantic target is disabled: ${id}`)
    if (!entry.definition.invoke) throw new Error(`UI semantic action ${action} has no command-backed handler for ${id}`)
    const beforeRevision = this.currentRevision
    await entry.definition.invoke(action, input)
    this.changed()
    return { beforeRevision, afterRevision: this.currentRevision }
  }

  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.changed()
  }

  private changed(): void {
    this.currentRevision += 1
    for (const listener of this.listeners) listener()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(UI_SEMANTIC_CHANGE_EVENT, { detail: { revision: this.currentRevision } }))
    }
  }
}

export const UI_SEMANTIC_CHANGE_EVENT = 'craft:ui-validation:semantic-change'

function validateDefinition(definition: UiSemanticDefinition): void {
  if (!ID_PATTERN.test(definition.id)) throw new Error(`Invalid UI semantic id: ${definition.id}`)
  if (!definition.role.trim()) throw new Error('UI semantic role is required.')
  if (!resolveRequired(definition.name).trim()) throw new Error(`UI semantic name is required for ${definition.id}.`)
  if (definition.actions.length > 16) throw new Error(`Too many UI semantic actions for ${definition.id}.`)
}

function definitionFingerprint(definition: UiSemanticDefinition): string {
  const value = resolveValue(definition.value)
  return JSON.stringify({
    role: definition.role,
    name: resolveRequired(definition.name),
    description: resolveValue(definition.description),
    value: definition.sensitive && value !== undefined ? `redacted:${hashString(value)}` : value,
    state: sanitizeState(resolveState(definition.state)),
    actions: [...new Set(definition.actions)],
    physicalActions: [...new Set(definition.physicalActions ?? [])],
  })
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function resolveRequired(value: string | (() => string)): string { return typeof value === 'function' ? value() : value }
function resolveValue(value: string | (() => string | undefined) | undefined): string | undefined { return typeof value === 'function' ? value() : value }
function resolveState(value: UiSemanticDefinition['state']): UiSemanticState { return (typeof value === 'function' ? value() : value) ?? {} }
function sanitizeState(state: UiSemanticState): UiBusinessSemanticNode['state'] {
  const result: UiBusinessSemanticNode['state'] = {}
  for (const key of ['disabled', 'checked', 'selected', 'expanded', 'busy', 'focused', 'hidden', 'readonly'] as const) {
    const value = state[key]
    if (typeof value === 'boolean' || (key === 'checked' && value === 'mixed')) result[key] = value as never
  }
  return result
}
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value)) throw new Error('Snapshot bounds must be safe integers.')
  return Math.max(min, Math.min(max, value))
}
function clip(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}\u2026` }
function clipOptional(value: string | undefined, max: number): string | undefined { return value === undefined ? undefined : clip(value, max) }
function cssEscape(value: string): string { return value.replace(/[\\"]/g, '\\$&') }

export const uiSemanticRegistry = new UiSemanticRegistry()
