import { describe, it, expect } from 'bun:test'
import {
  buildCollapsedGroupsScopeSuffix,
  serializeSessionFilterForScope,
} from '../session-list-collapse'

describe('serializeSessionFilterForScope', () => {
  it('serializes the unified session filter', () => {
    expect(serializeSessionFilterForScope({ kind: 'allSessions' })).toBe('allSessions')
  })
})

describe('buildCollapsedGroupsScopeSuffix', () => {
  it('creates different keys for grouping modes', () => {
    const date = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'ws-1',
      currentFilter: { kind: 'allSessions' },
      groupingMode: 'date',
    })

    const unread = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'ws-1',
      currentFilter: { kind: 'allSessions' },
      groupingMode: 'unread',
    })
    expect(date).not.toBe(unread)
  })

  it('creates different keys across workspaces', () => {
    const ws1 = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'workspace-one',
      currentFilter: { kind: 'allSessions' },
      groupingMode: 'date',
    })

    const ws2 = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'workspace-two',
      currentFilter: { kind: 'allSessions' },
      groupingMode: 'date',
    })

    expect(ws1).not.toBe(ws2)
  })
})
