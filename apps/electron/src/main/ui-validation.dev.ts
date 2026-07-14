/**
 * Source-development-only UI validation entry.
 *
 * Production builds compile the only import of this module out of the main
 * process entry, keeping the control plane and its transitive dependencies out
 * of packaged artifacts.
 */
export { startUiTestHost } from './ui-validation/test-host'
export { resolveUiValidationRoute } from './ui-validation/route-registry'
export { loadRendererTarget } from './ui-validation/renderer-navigation'
export { installUiValidationStateBridge } from './ui-validation/state-bridge'
