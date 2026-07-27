import { describe, expect, it, mock } from 'bun:test'
import type { WorkspaceInfo } from '@mortise/core/types'
import { copyResourcesToWorkspace, copySessionsToWorkspace } from '../workspace-transfer'

function workspace(id: string, locationId: string, endpoint: WorkspaceInfo['locations'][number]['endpoint']): WorkspaceInfo {
  return {
    schemaVersion: 2,
    id,
    revision: 1,
    primaryLocationId: locationId,
    locations: [{ id: locationId, name: locationId, endpoint }],
    name: id,
    slug: id,
  }
}

const source = workspace('source-workspace', 'source-location', { kind: 'local' })
const target = workspace('target-workspace', 'target-location', {
  kind: 'remote',
  url: 'https://target.test',
  remoteWorkspaceId: 'remote-target-workspace',
})

describe('workspace transfer routing', () => {
  it('copies each session through source export and target fork import', async () => {
    const invokeWorkspaceApi = mock(async (_route: unknown, method: string, ...args: unknown[]) => {
      if (method === 'exportSession') return { exported: args[0] }
      return { sessionId: `copy-${(args[1] as { exported: string }).exported}` }
    })
    const progress = mock(() => undefined)

    await expect(copySessionsToWorkspace(
      { invokeWorkspaceApi } as any,
      source,
      target,
      ['session-a', 'session-b'],
      progress,
    )).resolves.toEqual(['copy-session-a', 'copy-session-b'])
    expect(invokeWorkspaceApi.mock.calls).toEqual([
      [{ serverId: 'local', workspaceId: source.id, locationId: 'source-location' }, 'exportSession', 'session-a'],
      [{ serverId: 'https://target.test', workspaceId: target.id, locationId: 'target-location' }, 'importSession', target.id, { exported: 'session-a' }, 'fork'],
      [{ serverId: 'local', workspaceId: source.id, locationId: 'source-location' }, 'exportSession', 'session-b'],
      [{ serverId: 'https://target.test', workspaceId: target.id, locationId: 'target-location' }, 'importSession', target.id, { exported: 'session-b' }, 'fork'],
    ])
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]])
  })

  it('copies resources without renderer credentials or a direct server channel', async () => {
    const bundle = { version: 1, exportedAt: 1, sourceWorkspaceId: source.id, resources: {} }
    const importResult = {
      skills: { imported: ['skill-a'], skipped: [], failed: [], warnings: [] },
      automations: { imported: [], skipped: [], failed: [], warnings: [] },
    }
    const invokeWorkspaceApi = mock(async (_route: unknown, method: string) => (
      method === 'exportResources' ? { bundle, warnings: [] } : importResult
    ))

    await expect(copyResourcesToWorkspace(
      { invokeWorkspaceApi } as any,
      source,
      target,
      { skills: ['skill-a'] },
      'skip',
    )).resolves.toEqual({ exportResult: { bundle, warnings: [] }, importResult })
    expect(invokeWorkspaceApi.mock.calls).toEqual([
      [{ serverId: 'local', workspaceId: source.id, locationId: 'source-location' }, 'exportResources', source.id, { skills: ['skill-a'] }],
      [{ serverId: 'https://target.test', workspaceId: target.id, locationId: 'target-location' }, 'importResources', target.id, bundle, 'skip'],
    ])
  })
})
