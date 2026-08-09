import type { Workspace } from '@mortise/core/types'
import {
  ensureWorkspaceMarker,
  readWorkspaceMarkerIfPresent,
  removeWorkspaceMarker,
} from './marker.ts'
import { ensureWorkspaceStorage } from './storage.ts'
import { getDefaultWorkspaceTopologyStore, type WorkspaceTopologyStore } from './topology-storage.ts'

export interface WorkspaceInitializationOptions {
  topologyStore?: WorkspaceTopologyStore
  operationId?: string
}

/**
 * The single idempotent entry point for local Workspace initialization.
 *
 * A Workspace is usable only after its local roots, identity markers, local
 * SQLite config record, plugin manifest, and canonical topology registration
 * all agree on the same Workspace ID.  Existing registrations are checked and
 * repaired too, which makes a retry after a partial previous initialization
 * safe.
 */
export function initializeWorkspace(
  workspace: Workspace,
  options: WorkspaceInitializationOptions = {},
): Workspace {
  const topologyStore = options.topologyStore ?? getDefaultWorkspaceTopologyStore()
  const existing = topologyStore.get(workspace.id)
  const canonical = existing ?? workspace
  const primaryLocationId = canonical.primaryLocationId
  const markersCreatedByThisAttempt: string[] = []

  try {
    for (const location of canonical.locations) {
      if (location.endpoint.kind !== 'local') continue
      // Materialize the selected root before marker validation, but do not
      // rewrite its SQLite config identity until a conflicting marker has
      // been ruled out.
      ensureWorkspaceStorage(location.endpoint.rootPath, canonical.id, canonical.name, { persistConfig: false })
      const marker = readWorkspaceMarkerIfPresent(location.endpoint.rootPath)
      ensureWorkspaceMarker(location.endpoint.rootPath, canonical.id)
      if (!marker) markersCreatedByThisAttempt.push(location.endpoint.rootPath)
      ensureWorkspaceStorage(
        location.endpoint.rootPath,
        canonical.id,
        canonical.name,
        { persistConfig: location.id === primaryLocationId },
      )
    }

    return existing ?? topologyStore.create(
      canonical,
      options.operationId ?? `workspace-initialize-${canonical.id}`,
    )
  } catch (error) {
    // Filesystem and SQLite cannot share one transaction.  If topology did
    // not commit, remove only markers created by this attempt so a retry with
    // a fresh generated ID is not trapped by an orphan marker.  A concurrent
    // successful registration wins and keeps its marker.
    if (!topologyStore.get(canonical.id)) {
      for (const rootPath of markersCreatedByThisAttempt) {
        try { removeWorkspaceMarker(rootPath, canonical.id) } catch { /* best-effort rollback */ }
      }
    }
    throw error
  }
}
