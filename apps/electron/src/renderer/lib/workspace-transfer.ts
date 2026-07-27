import type { WorkspaceInfo } from '@mortise/core/types'
import type {
  ElectronAPI,
  ExportResourcesOptions,
  ExportResult,
  ResourceImportMode,
  ResourceImportResult,
} from '../../shared/types'
import { getPrimaryWorkspaceRoute } from './workspace-info'

type WorkspaceRouter = Pick<ElectronAPI, 'invokeWorkspaceApi'>

export async function copySessionsToWorkspace(
  api: WorkspaceRouter,
  sourceWorkspace: WorkspaceInfo,
  targetWorkspace: WorkspaceInfo,
  sessionIds: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<string[]> {
  const sourceRoute = getPrimaryWorkspaceRoute(sourceWorkspace)
  const targetRoute = getPrimaryWorkspaceRoute(targetWorkspace)
  const importedSessionIds: string[] = []

  for (const sessionId of sessionIds) {
    const bundle = await api.invokeWorkspaceApi(sourceRoute, 'exportSession', sessionId)
    const result = await api.invokeWorkspaceApi(
      targetRoute,
      'importSession',
      targetWorkspace.id,
      bundle,
      'fork',
    ) as { sessionId: string }
    importedSessionIds.push(result.sessionId)
    onProgress?.(importedSessionIds.length, sessionIds.length)
  }

  return importedSessionIds
}

export async function copyResourcesToWorkspace(
  api: WorkspaceRouter,
  sourceWorkspace: WorkspaceInfo,
  targetWorkspace: WorkspaceInfo,
  options: ExportResourcesOptions,
  mode: ResourceImportMode,
): Promise<{ exportResult: ExportResult; importResult: ResourceImportResult }> {
  const exportResult = await api.invokeWorkspaceApi(
    getPrimaryWorkspaceRoute(sourceWorkspace),
    'exportResources',
    sourceWorkspace.id,
    options,
  ) as ExportResult
  const importResult = await api.invokeWorkspaceApi(
    getPrimaryWorkspaceRoute(targetWorkspace),
    'importResources',
    targetWorkspace.id,
    exportResult.bundle,
    mode,
  ) as ResourceImportResult

  return { exportResult, importResult }
}
