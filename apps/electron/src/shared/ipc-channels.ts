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
  /** invoke → cross-server RPC: invoke a channel on an arbitrary remote server. */
  SERVER_INVOKE_ON_SERVER: 'server:invokeOnServer',
  /** invoke → transfer a session to another workspace's owning server. */
  SESSION_TRANSFER_TO_REMOTE_WORKSPACE: 'session:transferToRemoteWorkspace',
  /** invoke → sync a language change to main (persist + rebuild native menu). */
  I18N_CHANGE_LANGUAGE: 'i18n:changeLanguage',
  /** send -> publish a validated development-only UI state batch. */
  UI_VALIDATION_STATE_PUBLISH: '__ui-validation:state-publish',
  /** send -> mark all validation scopes for this renderer disposed. */
  UI_VALIDATION_STATE_DISPOSE: '__ui-validation:state-dispose',
} as const
