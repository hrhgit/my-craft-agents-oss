/** Production protocol entry: UI validation is a source-development capability. */
export * from './types'
export * from './channels'
export * from './dto'
export * from './events'
export * from './routing'
export * from './pi-projection'
export * from './capabilities'
export * from './automation-capability'
export * from './extension-contributions'
export * from './extension-interactions'
export type * from './extension-ui-validation'

/** Reject any unexpected validation event if an old extension sends one in production. */
export function validateExtensionUIValidationDeltaV1(_value: unknown): string {
  return 'Extension UI validation is unavailable in production builds.'
}
