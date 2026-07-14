export interface RegisteredExtensionValidation {
  extensionId: string
  sessionId: string
  runtimeId: string
  commandOwnerExtensionId: string
  revision: number
  definition: { id: string; contributionId: string }
}

/** Production builds do not advertise validation capability and retain no definitions. */
export class ExtensionValidationStore {
  apply(_delta: unknown, _options?: unknown): false { return false }
  resetRuntime(_sessionId: string, _runtimeId: string): void {}
  list(_sessionId: string, _contributionId?: string): RegisteredExtensionValidation[] { return [] }
  listAll(): RegisteredExtensionValidation[] { return [] }
  resolve(_selector: unknown): undefined { return undefined }
  updateState(_route: unknown, _definitionId: string, _revision: number, _state: unknown): false { return false }
  getVersion = (): number => 0
  subscribe = (_listener: () => void): (() => void) => () => {}
}

export const extensionValidationStore = new ExtensionValidationStore()
