import { describe, expect, it, mock } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import {
  deleteWorkspaceRemoteCredential,
  resolveWorkspaceLocationRuntime,
  setWorkspaceRemoteCredential,
  type WorkspaceRemoteCredentialAuthority,
} from '../workspace-remote-credentials'

function authority(): WorkspaceRemoteCredentialAuthority & {
  get: ReturnType<typeof mock>
  set: ReturnType<typeof mock>
  delete: ReturnType<typeof mock>
} {
  return {
    get: mock(async () => null),
    set: mock(async () => {}),
    delete: mock(async () => true),
  }
}

function workspace(): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-a',
    revision: 1,
    name: 'Workspace',
    slug: 'workspace',
    primaryLocationId: 'local',
    locations: [
      { id: 'local', name: 'Local', endpoint: { kind: 'local', rootPath: 'C:\\workspace' } },
      {
        id: 'remote',
        name: 'Remote',
        endpoint: {
          kind: 'remote',
          url: 'wss://remote.example',
          remoteWorkspaceId: 'remote-a',
          credentialRef: 'credential-a',
          allowInsecureTls: true,
        },
      },
    ],
    createdAt: 1,
  }
}

describe('Workspace remote credential boundary', () => {
  it('stores and deletes a namespaced opaque credential without exposing its ref in the key', async () => {
    const store = authority()
    const input = { workspaceId: 'workspace-a', credentialRef: 'credential-a', token: 'secret-token' }
    await setWorkspaceRemoteCredential(store, input)
    await deleteWorkspaceRemoteCredential(store, input)

    const id = store.set.mock.calls[0][0]
    expect(id).toMatchObject({ type: 'automation_secret', workspaceId: 'workspace-a' })
    expect(id.name).toStartWith('remote-location-')
    expect(JSON.stringify(id)).not.toContain(input.credentialRef)
    expect(store.set.mock.calls[0][1]).toEqual({ value: input.token })
    expect(store.delete).toHaveBeenCalledWith(id)
  })

  it('resolves the private remote runtime while keeping local locations credential-free', async () => {
    const store = authority()
    store.get.mockResolvedValue({ value: 'secret-token' })
    const topology = workspace()

    expect(await resolveWorkspaceLocationRuntime(store, topology, 'local')).toEqual({
      kind: 'local', workspaceId: 'workspace-a', locationId: 'local',
    })
    expect(await resolveWorkspaceLocationRuntime(store, topology, 'remote')).toEqual({
      kind: 'remote',
      workspaceId: 'workspace-a',
      locationId: 'remote',
      url: 'wss://remote.example',
      remoteWorkspaceId: 'remote-a',
      token: 'secret-token',
      allowInsecureTls: true,
    })
    expect(store.get).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the credential is missing and never includes credential material in the error', async () => {
    const store = authority()
    const topology = workspace()
    await expect(resolveWorkspaceLocationRuntime(store, topology, 'remote'))
      .rejects.toThrow('Remote Workspace credential is unavailable for workspace-a::remote')
  })
})
