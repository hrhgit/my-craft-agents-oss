import type { ExtensionUIValidationDefinitionV1, ExtensionUIValidationDeltaV1, ExtensionUIValidationStateV1 } from '@mortise/shared/protocol'
import { validateExtensionUIValidationDeltaV1 } from '@mortise/shared/protocol'

export interface RegisteredExtensionValidation {
  extensionId: string
  sessionId: string
  runtimeId: string
  /** Trusted Pi command owner. Sandbox routes keep their synthetic identity separate. */
  commandOwnerExtensionId: string
  revision: number
  definition: ExtensionUIValidationDefinitionV1
}

const routeKey = (delta: Pick<ExtensionUIValidationDeltaV1, 'sessionId' | 'runtimeId' | 'extensionId'>) =>
  `${delta.sessionId}\0${delta.runtimeId}\0${delta.extensionId}`
const itemKey = (item: Pick<RegisteredExtensionValidation, 'sessionId' | 'runtimeId' | 'extensionId'>, definitionId: string) =>
  `${item.sessionId}\0${item.runtimeId}\0${item.extensionId}\0${definitionId}`

export class ExtensionValidationStore {
  private readonly items = new Map<string, RegisteredExtensionValidation>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  apply(delta: ExtensionUIValidationDeltaV1, options?: { commandOwnerExtensionId?: string }): boolean {
    if (validateExtensionUIValidationDeltaV1(delta) !== null) return false
    const route = routeKey(delta)
    if (delta.revision <= (this.revisions.get(route) ?? 0)) return false
    this.revisions.set(route, delta.revision)
    const prefix = `${route}\0`
    if (delta.operation === 'snapshot' || delta.operation === 'reset') {
      for (const key of this.items.keys()) if (key.startsWith(prefix)) this.items.delete(key)
    }
    if (delta.operation === 'snapshot') {
      for (const definition of delta.definitions) this.set(delta, definition, options?.commandOwnerExtensionId)
    } else if (delta.operation === 'upsert') {
      this.set(delta, delta.definition, options?.commandOwnerExtensionId)
    } else if (delta.operation === 'remove') {
      this.items.delete(itemKey(delta, delta.definitionId))
    }
    this.changed()
    return true
  }

  resetRuntime(sessionId: string, runtimeId: string): void {
    const prefix = `${sessionId}\0${runtimeId}\0`
    let changed = false
    for (const key of this.items.keys()) if (key.startsWith(prefix)) { this.items.delete(key); changed = true }
    for (const key of this.revisions.keys()) if (key.startsWith(prefix)) { this.revisions.delete(key); changed = true }
    if (changed) this.changed()
  }

  list(sessionId: string, contributionId?: string): RegisteredExtensionValidation[] {
    return [...this.items.values()].filter(item => item.sessionId === sessionId && (contributionId === undefined || item.definition.contributionId === contributionId))
  }

  listAll(): RegisteredExtensionValidation[] {
    return [...this.items.values()]
  }

  resolve(selector: {
    sessionId: string
    extensionId: string
    runtimeId?: string
    definitionId: string
  }): RegisteredExtensionValidation | undefined {
    const matches = [...this.items.values()].filter(item => item.sessionId === selector.sessionId
      && item.extensionId === selector.extensionId
      && (selector.runtimeId === undefined || item.runtimeId === selector.runtimeId)
      && item.definition.id === selector.definitionId)
    return matches.length === 1 ? matches[0] : undefined
  }

  updateState(
    route: Pick<RegisteredExtensionValidation, 'extensionId' | 'sessionId' | 'runtimeId' | 'commandOwnerExtensionId'>,
    definitionId: string,
    revision: number,
    state: ExtensionUIValidationStateV1,
  ): boolean {
    const current = this.resolve({ ...route, definitionId })
    if (!current) return false
    return this.apply({
      schemaVersion: 1,
      extensionId: route.extensionId,
      sessionId: route.sessionId,
      runtimeId: route.runtimeId,
      revision,
      operation: 'upsert',
      definition: { ...current.definition, ...state },
    }, { commandOwnerExtensionId: route.commandOwnerExtensionId })
  }

  getVersion = (): number => this.version
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  private set(route: Pick<RegisteredExtensionValidation, 'extensionId' | 'sessionId' | 'runtimeId' | 'revision'>, definition: ExtensionUIValidationDefinitionV1, commandOwnerExtensionId = route.extensionId): void {
    const item = { ...route, commandOwnerExtensionId, definition }
    this.items.set(itemKey(item, definition.id), item)
  }

  private changed(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

export const extensionValidationStore = new ExtensionValidationStore()
