import { describe, expect, test } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import {
  WORKSPACE_MARKER_KIND,
  WORKSPACE_MARKER_RELATIVE_PATH,
  WORKSPACE_TOPOLOGY_ERROR_CODES,
  assertWorkspaceV2,
  getWorkspaceLocationRole,
  parseWorkspaceMarkerV1,
  parseWorkspacePathRefV1,
  parseWorkspaceTopologyCommandV1,
  parseWorkspaceTopologyChangedV1,
  parseWorkspaceTopologyResultV1,
  parseWorkspaceV2,
  redactWorkspaceInfo,
} from '../workspace-topology'
import { isTransportErrorCode } from '../types'

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-1',
    revision: 4,
    name: 'Product',
    slug: 'product',
    primaryLocationId: 'local-primary',
    locations: [
      {
        id: 'local-primary',
        name: 'Primary',
        endpoint: { kind: 'local', rootPath: 'E:\\Product' },
      },
      {
        id: 'remote-docs',
        name: 'Docs',
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

describe('Workspace V2', () => {
  test('accepts one-or-more named locations with a referenced primary', () => {
    const parsed = parseWorkspaceV2(workspace())
    expect(parsed.id).toBe('workspace-1')
    expect(parsed.locations).toHaveLength(2)
    expect(() => assertWorkspaceV2(parsed)).not.toThrow()
  })

  test('rejects duplicate location ids and case-insensitive names', () => {
    const duplicateIds = workspace({
      locations: [
        { id: 'same', name: 'Primary', endpoint: { kind: 'local', rootPath: 'E:\\One' } },
        { id: 'same', name: 'Other', endpoint: { kind: 'local', rootPath: 'E:\\Two' } },
      ],
      primaryLocationId: 'same',
    })
    expect(() => parseWorkspaceV2(duplicateIds)).toThrow('Location IDs must be unique')

    const duplicateNames = workspace({
      locations: [
        { id: 'one', name: 'Docs', endpoint: { kind: 'local', rootPath: 'E:\\One' } },
        { id: 'two', name: 'docs', endpoint: { kind: 'local', rootPath: 'E:\\Two' } },
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
        role: 'primary',
        endpoint: { kind: 'local', rootPath: 'E:\\Product' },
      }],
    })).toThrow()
    expect(() => parseWorkspaceV2({ ...workspace(), schemaVersion: 3 })).toThrow()
  })

  test('derives role only from primaryLocationId', () => {
    const value = workspace()
    expect(getWorkspaceLocationRole(value, 'local-primary')).toBe('primary')
    expect(getWorkspaceLocationRole(value, 'remote-docs')).toBe('attached')
  })

  test('redacts local paths and credential references from client info', () => {
    const info = redactWorkspaceInfo(workspace())
    const json = JSON.stringify(info)

    expect(info.locations).toEqual([
      { id: 'local-primary', name: 'Primary', endpoint: { kind: 'local' } },
      {
        id: 'remote-docs',
        name: 'Docs',
        endpoint: {
          kind: 'remote',
          url: 'wss://agent.example.test',
          remoteWorkspaceId: 'remote-workspace-1',
          allowInsecureTls: false,
        },
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
        endpoint: {
          kind: 'remote',
          url: 'wss://secret@example.test?token=also-secret',
          remoteWorkspaceId: 'remote-workspace-1',
          credentialRef: 'credential-remote',
        },
      }],
      primaryLocationId: 'remote-primary',
    }))).toThrow('Remote URL must not embed credentials')
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
        url: 'wss://agent.example.test',
        remoteWorkspaceId: 'remote-workspace-1',
        credentialRef: 'credential-docs',
      },
      { ...base, operation: 'detach', locationId: 'assets' },
      {
        ...base,
        operation: 'replace-endpoint',
        locationId: 'docs',
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
    const info = redactWorkspaceInfo(workspace({ revision: 5 }))
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
          endpoint: { kind: 'local', rootPath: 'E:\\Product' },
        }],
      },
    })).toThrow()
  })
})
