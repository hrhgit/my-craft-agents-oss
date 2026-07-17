export class ElectronUiDriverError extends Error {
  constructor(
    readonly code:
      | 'NOT_READY'
      | 'STALE_REF'
      | 'TARGET_NOT_FOUND'
      | 'AMBIGUOUS_TARGET'
      | 'DISABLED'
      | 'UNSUPPORTED'
      | 'TIMEOUT'
      | 'WINDOW_GONE'
      | 'DRIVER_DISCONNECTED'
      | 'INVALID_REQUEST',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ElectronUiDriverError'
  }
}
