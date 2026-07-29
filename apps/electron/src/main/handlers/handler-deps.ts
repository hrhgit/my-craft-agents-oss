/**
 * HandlerDeps — dependency bag for all IPC handlers.
 *
 * Concrete Electron specialization of the generic server-core handler deps.
 */

import type { HandlerDeps as BaseHandlerDeps } from '@mortise/server-core/handlers'
import type { SessionManager } from '@mortise/server-core/sessions'
import type { WindowManager } from '../window-manager'
import type { BrowserPaneManager } from '../browser-pane-manager'
import type { LayoutCoordinator } from '../layout-coordinator'
import type { BackendType } from '@mortise/shared/protocol'

export type HandlerDeps = BaseHandlerDeps<
  SessionManager,
  WindowManager,
  BrowserPaneManager
> & {
  layoutCoordinator?: LayoutCoordinator
  layoutCoordinators?: Partial<Record<BackendType, LayoutCoordinator>>
}
