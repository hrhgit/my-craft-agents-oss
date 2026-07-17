/**
 * Source-development UI validation can start real renderers and native drivers.
 * Keep ordinary command waits generous, while callers can opt into a longer
 * bounded wait for cold environments and slow recovery paths.
 */
export const UI_VALIDATION_DEFAULT_TIMEOUT_MS = 60_000
export const UI_VALIDATION_EXTENDED_TIMEOUT_MS = 120_000
export const UI_VALIDATION_MAX_WAIT_MS = 600_000
export const UI_VALIDATION_MAX_STABLE_FOR_MS = 120_000
