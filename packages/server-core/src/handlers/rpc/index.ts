import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

import { registerAuthHandlers } from './auth'
import { registerAutomationsHandlers } from './automations'
import { cleanupWorkspaceFileWatchForClient, registerFilesHandlers } from './files'
import { registerPiProviderHandlers } from './pi-providers'
import { registerOAuthHandlers } from './oauth'
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
import { registerSourcesHandlers } from './sources'
import { registerSystemCoreHandlers } from './system'
import { registerTransferHandlers } from './transfer'
import { registerWorkspaceCoreHandlers } from './workspace'
import { registerWorkspaceCoordinationHandlers } from './workspace-coordination'
import { registerMessagingHandlers } from './messaging'

export function cleanupClientFileWatches(clientId: string): void {
  cleanupSessionFileWatchForClient(clientId)
  cleanupWorkspaceFileWatchForClient(clientId)
}

export function registerCoreRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  registerAuthHandlers(server, deps)
  registerAutomationsHandlers(server, deps)
  registerFilesHandlers(server, deps)
  registerPiProviderHandlers(server, deps)
  registerOAuthHandlers(server, deps)
  registerOnboardingHandlers(server, deps)
  registerResourcesHandlers(server, deps)
  registerSessionsHandlers(server, deps)
  if (serverCtx) registerServerHandlers(server, deps, serverCtx)
  registerSettingsHandlers(server, deps)
  registerSkillsHandlers(server, deps)
  registerSourcesHandlers(server, deps)
  registerSystemCoreHandlers(server, deps)
  registerTransferHandlers(server)
  registerWorkspaceCoreHandlers(server, deps)
  registerWorkspaceCoordinationHandlers(server, deps)
  registerMessagingHandlers(server, deps)
}
