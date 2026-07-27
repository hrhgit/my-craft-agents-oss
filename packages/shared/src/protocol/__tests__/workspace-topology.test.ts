import { describe, expect, test } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import {
  WORKSPACE_MARKER_KIND,
  WORKSPACE_MARKER_RELATIVE_PATH,
  WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION,
  WORKSPACE_TOPOLOGY_ERROR_CODES,
  WORKSPACE_TRANSFER_SCHEMA_VERSION,
  assertWorkspaceV2,
  getWorkspaceLocationRole,
  parseWorkspaceInfoV2,
  parseWorkspaceMarkerV1,
  parseWorkspacePathRefV1,
  parseWorkspaceRemotePrimaryCommandV1,
  parseWorkspaceRemotePrimaryResultV1,
  parseWorkspaceTopologyCommandV1,
  parseWorkspaceTopologyChangedV1,
  parseWorkspaceTopologyResultV1,
  parseWorkspaceTransferRequestV1,
  parseWorkspaceTransferResultV1,
  parseWorkspaceV2,
  redactWorkspaceInfo,
  type WorkspaceLocationProjectionV1,
} from '../workspace-topology'
import { isTransportErrorCode } from '../types'

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-1',
    revision: 4,
    name: 'Product',
    nameSource: 'derived',
    slug: 'product',
    primaryLocationId: 'local-primary',
    locations: [
      {
        id: 'local-primary',
        name: 'Primary',
        rootName: 'Product',
        endpoint: { kind: 'local', rootPath: 'E:\\Product' },
      },
      {
        id: 'remote-docs',
        name: 'Docs',
        rootName: 'docs',
        endpoint: {
          kind: 'remote',
          url: 'wss://agent.example.test',
          remoteWorkspaceId: 'remote-workspace-1',
          credentialRef: 'credential-remote-docs',
          allowInsecureTls: false,
        },
      },
    ],
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function projections(): WorkspaceLocationProjectionV1[] {
  return [
    {
      schemaVersion: 1,
      locationId: 'local-primary',
      availability: { status: 'available', observedAt: 1_700_000_000_100 },
      permissions: { read: true, write: true, search: true, runCommands: true },
    },
    {
      schemaVersion: 1,
      locationId: 'remote-docs',
      availability: { status: 'unavailable', observedAt: 1_700_000_000_200, reason: 'offline' },
      permissions: { read: true, write: false, search: true, runCommands: false },
    },
  ]
}

describe('Workspace V2', () => {
  test('accepts one-or-more named locations with a referenced primary', () => {
    const parsed = parseWorkspaceV2(workspace())
    expect(parsed.id).toBe('workspace-1')
    expect(parsed.nameSource).toBe('derived')
    expect(parsed.locations).toHaveLength(2)
    expect(() => assertWorkspaceV2(parsed)).not.toThrow()
  })

  test('rejects duplicate location ids and case-insensitive names', () => {
    const duplicateIds = workspace({
      locations: [
        { id: 'same', name: 'Primary', rootName: 'One', endpoint: { kind: 'local', rootPath: 'E:\\One' } },
        { id: 'same', name: 'Other', rootName: 'Two', endpoint: { kind: 'local', rootPath: 'E:\\Two' } },
      ],
      primaryLocationId: 'same',
    })
    expect(() => parseWorkspaceV2(duplicateIds)).toThrow('Location IDs must be unique')

    const duplicateNames = workspace({
      locations: [
        { id: 'one', name: 'Docs', rootName: 'One', endpoint: { kind: 'local', rootPath: 'E:\\One' } },
        { id: 'two', name: 'docs', rootName: 'Two', endpoint: { kind: 'local', rootPath: 'E:\\Two' } },
      ],
      primaryLocationId: 'one',
    })
    expect(() => parseWorkspaceV2(duplicateNames)).toThrow('Location names must be unique')
  })

  test('rejects an empty topology, dangling primary, stored role, and unknown major', () => {
    expect(() => parseWorkspaceV2({ ...workspace(), locations: [] })).toThrow()
    expect(() => parseWorkspaceV2(workspace({ primaryLocationId: 'missing' }))).toThrow('Primary location')
    expect(() => parseWorkspaceV2({
      ...workspace(),
      locations: [{
        id: 'local-primary',
        name: 'Primary',
        rootName: 'Product',
        role: 'primary',
        endpoint: { kind: 'local', rootPath: 'E:\\Product' },
      }],
    })).toThrow()
    expect(() => parseWorkspaceV2({ ...workspace(), schemaVersion: 3 })).toThrow()
    const { nameSource: _, ...withoutNameSource } = workspace()
    expect(() => parseWorkspaceV2(withoutNameSource)).toThrow()
  })

  test('derives role only from primaryLocationId', () => {
    const value = workspace()
    expect(getWorkspaceLocationRole(value, 'local-primary')).toBe('primary')
    expect(getWorkspaceLocationRole(value, 'remote-docs')).toBe('attached')
  })

  test('redacts local paths and credential references from client info', () => {
    const info = redactWorkspaceInfo(workspace(), projections())
    const json = JSON.stringify(info)

    expect(info.locations).toEqual([
      {
        id: 'local-primary',
        name: 'Primary',
        rootName: 'Product',
        endpoint: { kind: 'local' },
        availability: { status: 'available', observedAt: 1_700_000_000_100 },
        permissions: { read: true, write: true, search: true, runCommands: true },
      },
      {
        id: 'remote-docs',
        name: 'Docs',
        rootName: 'docs',
        endpoint: {
          kind: 'remote',
          url: 'wss://agent.example.test',
          remoteWorkspaceId: 'remote-workspace-1',
          allowInsecureTls: false,
        },
        availability: { status: 'unavailable', observedAt: 1_700_000_000_200, reason: 'offline' },
        permissions: { read: true, write: false, search: true, runCommands: false },
      },
    ])
    expect(json).not.toContain('E:\\\\Product')
    expect(json).not.toContain('credential-remote-docs')
    expect(json).not.toContain('token')
    expect(json).not.toContain('rootPath')
    expect(json).not.toContain('credentialRef')
    expect(() => redactWorkspaceInfo(workspace({
      locations: [{
        id: 'remote-primary',
        name: 'Remote',
        rootName: 'remote-product',
        endpoint: {
          kind: 'remote',
          url: 'wss://secret@example.test?token=also-secret',
          remoteWorkspaceId: 'remote-workspace-1',
          credentialRef: 'credential-remote',
        },
      }],
      primaryLocationId: 'remote-primary',
    }), [{
      schemaVersion: 1,
      locationId: 'remote-primary',
      availability: { status: 'unknown', reason: 'not-observed' },
      permissions: { read: false, write: false, search: false, runCommands: false },
    }])).toThrow('Remote URL must not embed credentials')
  })

  test('requires exact truthful availability and permission projections', () => {
    const duplicate = projections()[0]!
    expect(() => redactWorkspaceInfo(workspace(), projections().slice(0, 1))).toThrow('exactly cover')
    expect(() => redactWorkspaceInfo(workspace(), [...projections(), duplicate])).toThrow('unique')

    const info = redactWorkspaceInfo(workspace(), projections())
    expect(() => parseWorkspaceInfoV2({
      ...info,
      locations: info.locations.map(({ availability: _, ...location }) => location),
    })).toThrow()
    expect(() => parseWorkspaceInfoV2({
      ...info,
      locations: [{
        ...info.locations[0],
        availability: { status: 'unavailable', observedAt: 1, reason: 'E:\\secret' },
      }],
    })).toThrow()
  })
})

describe('Workspace markers and path references', () => {
  test('uses the fixed marker path and accepts only the three marker fields', () => {
    expect(WORKSPACE_MARKER_RELATIVE_PATH).toBe('.mortise/workspace.json')
    expect(parseWorkspaceMarkerV1({
      schemaVersion: 1,
      kind: WORKSPACE_MARKER_KIND,
      workspaceId: 'workspace-1',
    })).toEqual({ schemaVersion: 1, kind: 'mortise.workspace', workspaceId: 'workspace-1' })

    expect(() => parseWorkspaceMarkerV1({
      schemaVersion: 1,
      kind: WORKSPACE_MARKER_KIND,
      workspaceId: 'workspace-1',
      locationId: 'not-allowed',
    })).toThrow()
    expect(() => parseWorkspaceMarkerV1({
      schemaVersion: 2,
      kind: WORKSPACE_MARKER_KIND,
      workspaceId: 'workspace-1',
    })).toThrow()
  })

  test('accepts canonical relative paths and rejects escape or unknown fields', () => {
    expect(parseWorkspacePathRefV1({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      locationId: 'remote-docs',
      relativePath: 'guides/setup.md',
    }).relativePath).toBe('guides/setup.md')
    expect(parseWorkspacePathRefV1({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      locationId: 'remote-docs',
      relativePath: '',
    }).relativePath).toBe('')
    expect(() => parseWorkspacePathRefV1({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      locationId: 'remote-docs',
      relativePath: '../secret',
    })).toThrow()
    expect(() => parseWorkspacePathRefV1({
      schemaVersion: 2,
      workspaceId: 'workspace-1',
      locationId: 'remote-docs',
      relativePath: 'safe',
    })).toThrow()
    expect(() => parseWorkspacePathRefV1({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      locationId: 'remote-docs',
      relativePath: 'safe',
      absolutePath: 'E:\\secret',
    })).toThrow()
  })
})

describe('Workspace transfer contract', () => {
  const source = {
    schemaVersion: 1 as const,
    workspaceId: 'workspace-1',
    locationId: 'local-primary',
    relativePath: 'source.txt',
  }
  const destination = {
    schemaVersion: 1 as const,
    workspaceId: 'workspace-1',
    locationId: 'remote-docs',
    relativePath: 'archive/source.txt',
  }
  const request = {
    schemaVersion: WORKSPACE_TRANSFER_SCHEMA_VERSION,
    operationId: 'transfer-1',
    workspaceId: 'workspace-1',
    expectedRevision: 4,
    mode: 'move' as const,
    source,
    destination,
    expectedSha256: 'a'.repeat(64),
  }

  test('accepts only endpoint-qualified, revisioned, idempotent transfers', () => {
    expect(parseWorkspaceTransferRequestV1(request)).toEqual(request)
    expect(() => parseWorkspaceTransferRequestV1({
      ...request,
      source: { ...source, workspaceId: 'other-workspace' },
    })).toThrow('identities must match')
    expect(() => parseWorkspaceTransferRequestV1({
      ...request,
      source: { ...source, relativePath: '.mortise/workspace.json' },
    })).toThrow('private resources')
    expect(() => parseWorkspaceTransferRequestV1({
      ...request,
      destination: source,
    })).toThrow('must differ')
    expect(() => parseWorkspaceTransferRequestV1({ ...request, expectedSha256: 'A'.repeat(64) })).toThrow()
  })

  test('rejects secret, absolute-path, and compatibility fields', () => {
    expect(() => parseWorkspaceTransferRequestV1({ ...request, token: 'secret' })).toThrow()
    expect(() => parseWorkspaceTransferRequestV1({
      ...request,
      destination: { ...destination, rootPath: 'E:\\hidden' },
    })).toThrow()
    expect(() => parseWorkspaceTransferRequestV1({ ...request, schemaVersion: 2 })).toThrow()
  })

  test('strictly validates observable transfer outcomes', () => {
    const result = {
      schemaVersion: WORKSPACE_TRANSFER_SCHEMA_VERSION,
      operationId: 'transfer-1',
      status: 'applied' as const,
      workspaceId: 'workspace-1',
      sourceLocationId: 'local-primary',
      destinationLocationId: 'remote-docs',
      revision: 4,
      mode: 'move' as const,
      sha256: 'a'.repeat(64),
      bytes: 42,
      sourceRemoved: true,
    }
    expect(parseWorkspaceTransferResultV1(result)).toEqual(result)
    expect(() => parseWorkspaceTransferResultV1({ ...result, mode: 'copy', sourceRemoved: true })).toThrow()
    expect(() => parseWorkspaceTransferResultV1({ ...result, bytes: -1 })).toThrow()
    expect(() => parseWorkspaceTransferResultV1({ ...result, warning: 'ignored' })).toThrow()
  })
})

describe('remote-primary Workspace contract', () => {
  const server = {
    url: 'wss://agent.example.test',
    credentialRef: 'credential-remote-primary',
    allowInsecureTls: false,
  }

  test('strictly separates connect-existing from create-and-connect', () => {
    const connect = {
      schemaVersion: WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION,
      operation: 'connect-existing' as const,
      operationId: 'remote-primary-1',
      workspaceId: 'local-workspace-id',
      locationId: 'remote-primary',
      displayName: { source: 'derived' as const },
      remoteRootName: 'customer-docs',
      server,
      remoteWorkspaceId: 'remote-workspace-id',
    }
    expect(parseWorkspaceRemotePrimaryCommandV1(connect)).toEqual(connect)

    const create = {
      schemaVersion: WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION,
      operation: 'create-and-connect' as const,
      operationId: 'remote-primary-2',
      workspaceId: 'local-workspace-id-2',
      locationId: 'remote-primary',
      displayName: { source: 'custom' as const, name: 'Customer Docs' },
      server,
      remoteRootName: 'customer-docs',
    }
    expect(parseWorkspaceRemotePrimaryCommandV1(create)).toEqual(create)
    expect(() => parseWorkspaceRemotePrimaryCommandV1({ ...connect, remoteRootName: undefined })).toThrow()
    expect(() => parseWorkspaceRemotePrimaryCommandV1({ ...create, remoteWorkspaceId: 'precreated' })).toThrow()
  })

  test('rejects credentials, fake local roots, invalid name-source shapes, and URL secrets', () => {
    const command = {
      schemaVersion: WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION,
      operation: 'connect-existing',
      operationId: 'remote-primary-1',
      workspaceId: 'local-workspace-id',
      locationId: 'remote-primary',
      displayName: { source: 'derived' },
      remoteRootName: 'customer-docs',
      server,
      remoteWorkspaceId: 'remote-workspace-id',
    }
    expect(() => parseWorkspaceRemotePrimaryCommandV1({ ...command, token: 'secret' })).toThrow()
    expect(() => parseWorkspaceRemotePrimaryCommandV1({ ...command, rootPath: 'E:\\bootstrap' })).toThrow()
    expect(() => parseWorkspaceRemotePrimaryCommandV1({
      ...command,
      displayName: { source: 'derived', name: 'must-not-be-silently-custom' },
    })).toThrow()
    expect(() => parseWorkspaceRemotePrimaryCommandV1({
      ...command,
      server: { ...server, url: 'wss://user:secret@agent.example.test' },
    })).toThrow('must not embed credentials')
  })

  test('requires stable local and remote identity with a genuinely remote primary', () => {
    const remoteWorkspace = workspace({
      id: 'local-workspace-id',
      name: 'Remote Product',
      nameSource: 'derived',
      primaryLocationId: 'remote-primary',
      locations: [{
        id: 'remote-primary',
        name: 'Primary',
        rootName: 'customer-docs',
        endpoint: {
          kind: 'remote',
          url: 'wss://agent.example.test',
          remoteWorkspaceId: 'remote-workspace-id',
          credentialRef: 'credential-remote-primary',
        },
      }],
    })
    const info = redactWorkspaceInfo(remoteWorkspace, [{
      schemaVersion: 1,
      locationId: 'remote-primary',
      availability: { status: 'unknown', reason: 'checking' },
      permissions: { read: false, write: false, search: false, runCommands: false },
    }])
    const result = {
      schemaVersion: WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION,
      operationId: 'remote-primary-1',
      status: 'applied' as const,
      workspaceId: 'local-workspace-id',
      locationId: 'remote-primary',
      remoteWorkspaceId: 'remote-workspace-id',
      workspace: info,
    }
    expect(parseWorkspaceRemotePrimaryResultV1(result)).toEqual(result)
    expect(() => parseWorkspaceRemotePrimaryResultV1({ ...result, workspaceId: 'different' })).toThrow()
    expect(() => parseWorkspaceRemotePrimaryResultV1({
      ...result,
      workspace: redactWorkspaceInfo(workspace(), projections()),
    })).toThrow('Created Workspace identity must match')
  })
})

describe('Workspace topology commands and errors', () => {
  const base = {
    schemaVersion: 1 as const,
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    expectedRevision: 4,
  }

  test('strictly validates every topology operation', () => {
    const commands = [
      { ...base, operation: 'attach-local', locationId: 'assets', name: 'Assets', rootPath: 'E:\\Assets' },
      {
        ...base,
        operation: 'attach-remote',
        locationId: 'docs',
        name: 'Docs',
        rootName: 'docs',
        url: 'wss://agent.example.test',
        remoteWorkspaceId: 'remote-workspace-1',
        credentialRef: 'credential-docs',
      },
      { ...base, operation: 'detach', locationId: 'assets' },
      {
        ...base,
        operation: 'replace-endpoint',
        locationId: 'docs',
        rootName: 'docs-v2',
        endpoint: {
          kind: 'remote',
          url: 'wss://next.example.test',
          remoteWorkspaceId: 'remote-workspace-2',
          credentialRef: 'credential-next',
        },
      },
      { ...base, operation: 'set-primary', locationId: 'docs' },
      { ...base, operation: 'rename', locationId: 'docs', name: 'Reference' },
    ]

    for (const command of commands) {
      expect(parseWorkspaceTopologyCommandV1(command).operation).toBe(
        command.operation as ReturnType<typeof parseWorkspaceTopologyCommandV1>['operation'],
      )
    }
  })

  test('rejects missing concurrency/idempotency data, secrets, unknown fields, and major versions', () => {
    expect(() => parseWorkspaceTopologyCommandV1({
      ...base,
      operation: 'detach',
      locationId: 'docs',
      operationId: undefined,
    })).toThrow()
    expect(() => parseWorkspaceTopologyCommandV1({
      ...base,
      operation: 'detach',
      locationId: 'docs',
      expectedRevision: -1,
    })).toThrow()
    expect(() => parseWorkspaceTopologyCommandV1({
      ...base,
      operation: 'attach-remote',
      locationId: 'docs',
      name: 'Docs',
      rootName: 'docs',
      url: 'wss://agent.example.test',
      remoteWorkspaceId: 'remote-workspace-1',
      credentialRef: 'credential-docs',
      token: 'must-not-cross-the-contract',
    })).toThrow()
    expect(() => parseWorkspaceTopologyCommandV1({
      ...base,
      operation: 'attach-remote',
      locationId: 'docs',
      name: 'Docs',
      rootName: 'docs',
      url: 'wss://secret@example.test?token=also-secret',
      remoteWorkspaceId: 'remote-workspace-1',
      credentialRef: 'credential-docs',
    })).toThrow('Remote URL must not embed credentials')
    expect(() => parseWorkspaceTopologyCommandV1({ ...base, schemaVersion: 2, operation: 'detach', locationId: 'docs' })).toThrow()
  })

  test('registers stable transport error codes', () => {
    for (const code of Object.values(WORKSPACE_TOPOLOGY_ERROR_CODES)) {
      expect(isTransportErrorCode(code)).toBe(true)
    }
  })

  test('strictly validates redacted results and monotonic change events', () => {
    const info = redactWorkspaceInfo(workspace({ revision: 5 }), projections())
    expect(parseWorkspaceTopologyResultV1({
      schemaVersion: 1,
      operationId: 'operation-1',
      status: 'applied',
      workspace: info,
    }).workspace.revision).toBe(5)

    const change = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      operation: 'rename',
      previousRevision: 4,
      revision: 5,
      changedLocationIds: ['remote-docs'],
      workspace: info,
    }
    expect(parseWorkspaceTopologyChangedV1(change).revision).toBe(5)
    expect(() => parseWorkspaceTopologyChangedV1({ ...change, revision: 6 })).toThrow()
    expect(() => parseWorkspaceTopologyResultV1({
      schemaVersion: 1,
      operationId: 'operation-1',
      status: 'applied',
      workspace: {
        ...info,
        locations: [{
          id: 'local-primary',
          name: 'Primary',
          rootName: 'Product',
          endpoint: { kind: 'local', rootPath: 'E:\\Product' },
        }],
      },
    })).toThrow()
  })
})
