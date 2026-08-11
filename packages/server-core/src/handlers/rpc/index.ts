import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

import { registerAuthHandlers } from './auth'
import { cleanupWorkspaceFileWatchForClient, registerFilesHandlers } from './files'
import { registerPiProviderHandlers } from './pi-providers'
import { registerResourcesHandlers } from './resources'
import { registerOnboardingHandlers } from './onboarding'
import { cleanupSessionFileWatchForClient, registerSessionsHandlers } from './sessions'
export { registerSessionsHandlers, cleanupSessionFileWatchForClient } from './sessions'
export { cleanupWorkspaceFileWatchForClient } from './files'
import { registerServerHandlers } from './server'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
export type { ServerHandlerContext } from '../../bootstrap/headless-start'
export { getHealthCheck } from './server'
import { registerSettingsHandlers } from './settings'
import { registerSkillsHandlers } from './skills'
import { registerSystemCoreHandlers } from './system'
import { registerTransferHandlers } from './transfer'
import { registerWorkspaceCoreHandlers } from './workspace'
import { registerWorkspaceCoordinationHandlers } from './workspace-coordination'
import { registerMessagingHandlers } from './messaging'
import { createDefaultOperationCoordinator } from '../../operations/operation-coordinator'
import { registerOperationHandlers } from './operations'

export function cleanupClientFileWatches(clientId: string): void {
  cleanupSessionFileWatchForClient(clientId)
  cleanupWorkspaceFileWatchForClient(clientId)
}

export function registerCoreRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  const ownsOperationCoordinator = !deps.operationCoordinator
  const operationCoordinator = deps.operationCoordinator ?? createDefaultOperationCoordinator()
  if (ownsOperationCoordinator) server.onClose?.(() => operationCoordinator.close())
  const handlerDeps = { ...deps, operationCoordinator } as typeof deps
  registerOperationHandlers(server, operationCoordinator)
  registerAuthHandlers(server, handlerDeps)
  registerFilesHandlers(server, handlerDeps)
  registerPiProviderHandlers(server, handlerDeps)
  registerOnboardingHandlers(server, handlerDeps)
  registerResourcesHandlers(server, handlerDeps)
  registerSessionsHandlers(server, handlerDeps)
  if (serverCtx) registerServerHandlers(server, handlerDeps, serverCtx)
  registerSettingsHandlers(server, handlerDeps)
  registerSkillsHandlers(server, handlerDeps)
  registerSystemCoreHandlers(server, handlerDeps)
  registerTransferHandlers(server)
  registerWorkspaceCoreHandlers(server, handlerDeps)
  registerWorkspaceCoordinationHandlers(server, handlerDeps)
  registerMessagingHandlers(server, handlerDeps)
}
