/**
 * Resources RPC Handlers
 *
 * Handles workspace resource export/import (skills and automations).
 */

import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { requirePrimaryLocalWorkspaceRoot } from '@mortise/core/types'
import { MORTISE_PROJECT_SKILLS_DIR } from '@mortise/shared/config/paths'
import { getCredentialManager } from '@mortise/shared/credentials'
import { getWorkspaceOrThrow, resolveWorkspaceId } from '../utils'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type {
  ResourceBundle,
  ResourceImportMode,
  ExportResourcesOptions,
} from '@mortise/shared/resources'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.resources.EXPORT,
  RPC_CHANNELS.resources.IMPORT,
] as const

export function registerResourcesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Export workspace resources to a portable bundle
  server.handle(
    RPC_CHANNELS.resources.EXPORT,
    async (ctx, workspaceId: string, options: ExportResourcesOptions) => {
      const resolvedWorkspaceId = resolveWorkspaceId(ctx.workspaceId, workspaceId) ?? workspaceId
      const workspace = getWorkspaceOrThrow(resolvedWorkspaceId)

      const { exportResources } = await import('@mortise/shared/resources')
      const automationHost = deps.sessionManager.getAutomationHost(resolvedWorkspaceId) ?? undefined
      const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)
      const result = exportResources(workspaceRoot, options, resolvedWorkspaceId, automationHost)

      deps.platform.logger?.info(
        `RESOURCES_EXPORT: Exported from ${resolvedWorkspaceId}: ` +
        `${result.bundle.resources.skills?.length ?? 0} skills, ` +
        `${result.bundle.resources.automations?.length ?? 0} automations` +
        (result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : ''),
      )

      return result
    },
  )

  // Import a resource bundle into a workspace
  server.handle(
    RPC_CHANNELS.resources.IMPORT,
    async (ctx, workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode) => {
      const resolvedWorkspaceId = resolveWorkspaceId(ctx.workspaceId, workspaceId) ?? workspaceId
      const workspace = getWorkspaceOrThrow(resolvedWorkspaceId)

      const { importResources } = await import('@mortise/shared/resources')
      const automationHost = deps.sessionManager.getAutomationHost(resolvedWorkspaceId) ?? undefined
      const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)
      const result = await importResources(
        workspaceRoot,
        bundle,
        mode,
        resolvedWorkspaceId,
        automationHost,
        {
          isAvailable: async dependency => {
            if (dependency.kind === 'session') return automationHost?.hasSessionDependency(dependency.id) ?? false
            if (dependency.kind === 'secret') {
              return !!await getCredentialManager().getAutomationSecret(resolvedWorkspaceId, dependency.id)
            }
            return false
          },
        },
      )

      deps.platform.logger?.info(
        `RESOURCES_IMPORT: Imported into ${resolvedWorkspaceId} (mode=${mode}): ` +
        `skills=${result.skills.imported.length} imported, ${result.skills.skipped.length} skipped, ${result.skills.failed.length} failed; ` +
        `automations=${result.automations.imported.length} imported, ${result.automations.skipped.length} skipped, ${result.automations.failed.length} failed`,
      )

      // Skills remain filesystem resources; Automations V3 publishes through
      // its canonical store/dispatcher rather than ConfigWatcher.
      for (const slug of result.skills.imported) {
        deps.sessionManager.notifyConfigFileChange(workspaceRoot, `${MORTISE_PROJECT_SKILLS_DIR}/${slug}/SKILL.md`)
      }

      return result
    },
  )
}
