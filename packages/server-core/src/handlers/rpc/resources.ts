/**
 * Resources RPC Handlers
 *
 * Handles workspace resource export/import (skills and automations).
 */

import { RPC_CHANNELS } from '@mortise/shared/protocol'
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
      const result = exportResources(workspace.rootPath, options)

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
      const result = await importResources(workspace.rootPath, bundle, mode)

      deps.platform.logger?.info(
        `RESOURCES_IMPORT: Imported into ${resolvedWorkspaceId} (mode=${mode}): ` +
        `skills=${result.skills.imported.length} imported, ${result.skills.skipped.length} skipped, ${result.skills.failed.length} failed; ` +
        `automations=${result.automations.imported.length} imported, ${result.automations.skipped.length} skipped, ${result.automations.failed.length} failed`,
      )

      // Notify ConfigWatcher of imported files so UI refreshes on Linux
      // (Bun's fs.watch doesn't reliably detect atomic renames)
      if (result.automations.imported.length > 0 || result.automations.skipped.length === 0 && bundle.resources.automations?.length) {
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, 'automations.json')
      }
      for (const slug of result.skills.imported) {
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `.pi/skills/${slug}/SKILL.md`)
      }

      return result
    },
  )
}
