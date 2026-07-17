import { describe, expect, it } from 'bun:test'
import {
  mergeWorkspaceSessionSummaries,
  removeWorkspaceSessionSummary,
  updateWorkspaceSessionSummary,
  type WorkspaceSessionSummary,
} from '../workspace-sidebar-model'

function summary(id: string, workspaceId = 'ws-a'): WorkspaceSessionSummary {
  return { id, workspaceId, lastMessageAt: 1 }
}

describe('workspace sidebar session summaries', () => {
  it('preserves inactive workspace shortcuts through a transient empty switch frame', () => {
    const previous = { 'ws-a': [summary('session-a')] }
    expect(mergeWorkspaceSessionSummaries(previous, 'ws-a', [])).toBe(previous)
  })

  it('stores the first authoritative list for a workspace', () => {
    const next = mergeWorkspaceSessionSummaries({}, 'ws-a', [summary('session-a')])
    expect(next['ws-a'].map(item => item.id)).toEqual(['session-a'])
  })

  it('commits an authoritative empty list after the workspace has loaded', () => {
    const previous = { 'ws-a': [summary('session-a')] }
    const next = mergeWorkspaceSessionSummaries(previous, 'ws-a', [], true)

    expect(next).not.toBe(previous)
    expect(next['ws-a']).toEqual([])
  })

  it('updates one cached session without disturbing sibling workspaces', () => {
    const previous = {
      'ws-a': [summary('session-a')],
      'ws-b': [summary('session-b', 'ws-b')],
    }
    const next = updateWorkspaceSessionSummary(previous, 'ws-a', 'session-a', { name: 'Renamed' })

    expect(next['ws-a'][0].name).toBe('Renamed')
    expect(next['ws-b']).toBe(previous['ws-b'])
  })

  it('removes a deleted session from only its workspace cache', () => {
    const previous = {
      'ws-a': [summary('session-a'), summary('session-a-2')],
      'ws-b': [summary('session-b', 'ws-b')],
    }
    const next = removeWorkspaceSessionSummary(previous, 'ws-a', 'session-a')

    expect(next['ws-a'].map(item => item.id)).toEqual(['session-a-2'])
    expect(next['ws-b']).toBe(previous['ws-b'])
  })
})
