import { describe, expect, it } from 'bun:test'
import { MORTISE_UI_FIXTURE_SCHEMA, validateMortiseUiFixtureSpec } from '../fixture.ts'

describe('mortise-ui fixture specification', () => {
  it('publishes the bounded workspace/session/history schema', () => {
    expect(MORTISE_UI_FIXTURE_SCHEMA).toMatchObject({
      properties: {
        version: { const: 1 },
        workspaces: { maxItems: 32 },
      },
    })
    expect(MORTISE_UI_FIXTURE_SCHEMA.examples[0].workspaces[0].sessions[0].messages).toHaveLength(2)
  })

  it('normalizes a composable data scene', () => {
    expect(validateMortiseUiFixtureSpec({
      version: 1,
      active: { workspaceId: 'workspace-a', sessionId: 'session-a' },
      workspaces: [{
        id: 'workspace-a', name: 'Workspace A',
        files: [{ path: 'src/index.ts', content: 'export {}\n' }],
        sessions: [{
          id: 'session-a',
          messages: [{ role: 'user', content: 'Inspect the source.' }],
          files: [{ path: 'plans/inspect.md', content: '# Inspect\n' }],
        }],
      }],
    })).toMatchObject({
      active: { workspaceId: 'workspace-a', sessionId: 'session-a' },
      workspaces: [{ slug: 'workspace-a', sessions: [{ id: 'session-a' }] }],
    })
  })

  it('rejects path escape and cross-workspace active sessions', () => {
    expect(() => validateMortiseUiFixtureSpec({
      version: 1,
      workspaces: [{ id: 'workspace-a', name: 'A', files: [{ path: '../outside', content: 'x' }] }],
    })).toThrow('parent segment')
    expect(() => validateMortiseUiFixtureSpec({
      version: 1,
      active: { workspaceId: 'workspace-a', sessionId: 'session-b' },
      workspaces: [
        { id: 'workspace-a', name: 'A' },
        { id: 'workspace-b', name: 'B', sessions: [{ id: 'session-b' }] },
      ],
    })).toThrow('must belong to workspace workspace-a')
  })

  it('validates child sessions within the same workspace', () => {
    expect(validateMortiseUiFixtureSpec({
      version: 1,
      workspaces: [{
        id: 'workspace-a', name: 'A',
        sessions: [{ id: 'parent' }, { id: 'child', parentSessionId: 'parent' }],
      }],
    }).workspaces[0]?.sessions?.[1]).toMatchObject({ id: 'child', parentSessionId: 'parent' })

    expect(() => validateMortiseUiFixtureSpec({
      version: 1,
      workspaces: [
        { id: 'workspace-a', name: 'A', sessions: [{ id: 'parent' }] },
        { id: 'workspace-b', name: 'B', sessions: [{ id: 'child', parentSessionId: 'parent' }] },
      ],
    })).toThrow('must reference a session in workspace workspace-b')
  })
})
