/**
 * Preload-local IPC channel names.
 *
 * These channels are private to the Electron preload ↔ main-process boundary
 * (they never traverse the WebSocket RPC layer). Centralizing them here keeps
 * preload and main in sync on the exact wire-format strings. Channels prefixed
 * with `__` are internal framework channels.
 *
 * This is intentionally separate from `RPC_CHANNELS` in
 * `packages/shared/src/protocol/channels.ts`, which holds the stable,
 * auto-tested wire-format contract for WebSocket RPC. Preload-local channels
 * are Electron-only and do not belong in the shared RPC registry.
 */
export const PRELOAD_LOCAL_CHANNELS = {
  /** sendSync → returns the local WS server port (main ↘ preload). */
  GET_WS_PORT: '__get-ws-port',
  /** invoke → main shows a native message box dialog. */
  DIALOG_SHOW_MESSAGE_BOX: '__dialog:showMessageBox',
  /** send → preload reports remote WS connection state to main for logging. */
  TRANSPORT_STATUS: '__transport:status',
  /** invoke → relaunch the app (for server config changes). */
  APP_RELAUNCH: 'app:relaunch',
  /** invoke → remove a workspace from config. */
  WORKSPACE_REMOVE: 'workspace:remove',
  /** invoke -> resolve one trusted location endpoint for preload transport only. */
  WORKSPACE_RESOLVE_LOCATION_RUNTIME: '__workspace:resolve-location-runtime',
  /** invoke -> persist one remote location secret through the host credential authority. */
  WORKSPACE_SET_REMOTE_CREDENTIAL: '__workspace:set-remote-credential',
  /** invoke -> delete one remote location secret through the host credential authority. */
  WORKSPACE_DELETE_REMOTE_CREDENTIAL: '__workspace:delete-remote-credential',
  /** invoke -> acquire the app-wide Workspace transfer orchestration lease. */
  WORKSPACE_TRANSFER_LEASE_ACQUIRE: '__workspace:transfer-lease-acquire',
  /** invoke -> release the app-wide Workspace transfer orchestration lease. */
  WORKSPACE_TRANSFER_LEASE_RELEASE: '__workspace:transfer-lease-release',
  /** invoke → sync a language change to main (persist + rebuild native menu). */
  I18N_CHANGE_LANGUAGE: 'i18n:changeLanguage',
  /** send -> publish a validated development-only UI state batch. */
  UI_VALIDATION_STATE_PUBLISH: '__ui-validation:state-publish',
  /** send -> mark all validation scopes for this renderer disposed. */
  UI_VALIDATION_STATE_DISPOSE: '__ui-validation:state-dispose',
} as const
