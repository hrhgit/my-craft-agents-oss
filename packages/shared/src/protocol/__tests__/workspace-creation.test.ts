import { describe, expect, test } from 'bun:test'
import type { WorkspaceInfo } from '@mortise/core/types'
import {
  parseWorkspaceCreationRequestV1,
  parseWorkspaceCreationResultV1,
} from '../workspace-creation'

const workspace: WorkspaceInfo = {
  schemaVersion: 2 as const,
  id: 'workspace-1',
  revision: 0,
  name: 'Product',
  nameSource: 'custom' as const,
  slug: 'product',
  primaryLocationId: 'primary',
  locations: [{
    id: 'primary',
    name: 'Product',
    rootName: 'product',
    endpoint: { kind: 'local' as const },
    availability: { status: 'unknown' as const, reason: 'not-observed' as const },
    permissions: { read: false, write: false, search: false, runCommands: false },
  }],
}

describe('Workspace creation contract', () => {
  test('accepts zero or many locations and defaults the selected primary', () => {
    expect(parseWorkspaceCreationRequestV1({
      schemaVersion: 1,
      locations: [],
    })).toEqual({ schemaVersion: 1, locations: [] })

    expect(parseWorkspaceCreationRequestV1({
      schemaVersion: 1,
      name: 'Product',
      locations: [{ rootPath: 'E:\\Product' }, { rootPath: 'E:\\Docs' }],
    })).toEqual({
      schemaVersion: 1,
      name: 'Product',
      locations: [{ rootPath: 'E:\\Product' }, { rootPath: 'E:\\Docs' }],
      primaryLocationIndex: 0,
    })
  })

  test('rejects invalid primary references and compatibility fields', () => {
    expect(() => parseWorkspaceCreationRequestV1({
      schemaVersion: 1,
      locations: [],
      primaryLocationIndex: 0,
    })).toThrow()
    expect(() => parseWorkspaceCreationRequestV1({
      schemaVersion: 1,
      locations: [{ rootPath: 'E:\\Product' }],
      primaryLocationIndex: 2,
    })).toThrow()
    expect(() => parseWorkspaceCreationRequestV1({
      schemaVersion: 1,
      locations: [{ rootPath: 'E:\\Product', role: 'primary' }],
    })).toThrow('unknown fields')
  })

  test('validates created and reconnected results', () => {
    expect(parseWorkspaceCreationResultV1({
      schemaVersion: 1,
      action: 'created',
      workspace,
    })).toEqual({ schemaVersion: 1, action: 'created', workspace })
    expect(parseWorkspaceCreationResultV1({
      schemaVersion: 1,
      action: 'reconnected',
      workspace,
    }).action).toBe('reconnected')
    expect(() => parseWorkspaceCreationResultV1({
      schemaVersion: 1,
      action: 'opened',
      workspace,
    })).toThrow()
  })
})
