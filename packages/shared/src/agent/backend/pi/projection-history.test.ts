import { describe, expect, it } from 'bun:test'
import {
  PLAN_ARTIFACT_CUSTOM_TYPE,
  PLAN_MODE_STATE_CUSTOM_TYPE,
} from '@mortise/core/types'
import {
  buildPiProjectionSnapshotFromHostProjection,
  type PiHostSessionProjectionLike,
} from './projection-history.ts'

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-1',
  revision: 1,
  state: 'ready' as const,
  review: { status: 'passed' as const },
  checklist: [],
  createdAt: 1,
}

function projection(): PiHostSessionProjectionLike {
  return {
    leafId: 'custom-1',
    entries: [{
      type: 'message', id: 'user-entry', parentId: null, timestamp: new Date(100).toISOString(),
      message: {
        role: 'user', content: 'hello', timestamp: 100, clientMutationId: 'mutation-1',
        attachments: [{ id: 'attachment-1', name: 'note.txt', mediaType: 'text/plain', size: 5 }],
      },
    }, {
      type: 'message', id: 'assistant-tool-entry', parentId: 'user-entry', timestamp: new Date(200).toISOString(),
      message: {
        role: 'assistant', timestamp: 200, api: 'anthropic-messages', provider: 'anthropic', model: 'test',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'call-1', name: 'Read', arguments: { path: 'note.txt' } },
        ],
      },
    }, {
      type: 'message', id: 'tool-result-entry', parentId: 'assistant-tool-entry', timestamp: new Date(250).toISOString(),
      message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', isError: false, timestamp: 250,
        content: [{ type: 'text', text: 'contents' }],
      },
    }, {
      type: 'message', id: 'assistant-final-entry', parentId: 'tool-result-entry', timestamp: new Date(300).toISOString(),
      message: {
        role: 'assistant', timestamp: 300, api: 'anthropic-messages', provider: 'anthropic', model: 'test',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', content: [{ type: 'text', text: 'done' }],
      },
    }, {
      type: 'custom_message', id: 'plan-1', parentId: 'assistant-final-entry', timestamp: new Date(350).toISOString(),
      customType: PLAN_ARTIFACT_CUSTOM_TYPE, content: '# Plan', display: true,
      details: { schemaVersion: 1, artifact },
    }, {
      type: 'custom_message', id: 'state-1', parentId: 'plan-1', timestamp: new Date(375).toISOString(),
      customType: PLAN_MODE_STATE_CUSTOM_TYPE, content: '', display: false,
      details: { schemaVersion: 1, state: { schemaVersion: 1, phase: 'ready', activeArtifactId: 'plan-1', updatedAt: 375 } },
    }, {
      type: 'custom_message', id: 'custom-1', parentId: 'state-1', timestamp: new Date(400).toISOString(),
      customType: 'extension-notice', content: 'Notice', display: true,
      details: { level: 'warning' },
    }, {
      type: 'message', id: 'sibling', parentId: 'user-entry', timestamp: new Date(999).toISOString(),
      message: {
        role: 'assistant', timestamp: 999, api: 'anthropic-messages', provider: 'anthropic', model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', content: [{ type: 'text', text: 'wrong branch' }],
      },
    }],
  }
}

describe('Pi HostSessionProjection history builder', () => {
  it('rebuilds only the active Pi branch with stable message and turn identities', () => {
    const snapshot = buildPiProjectionSnapshotFromHostProjection(
      'session-1', 'history-runtime', projection(),
    )

    expect(snapshot.lastSeq).toBeGreaterThan(0)
    expect(snapshot.entities.find(entity => entity.entityId === 'content:user:mutation-1')).toMatchObject({
      turnId: 'pi-turn-0', createdAt: 100, updatedAt: 100,
      payload: { messageId: 'mutation-1', queueStatus: 'accepted', source: 'pi' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'artifact:attachment:mutation-1:attachment-1')).toMatchObject({
      turnId: 'pi-turn-0', payload: { ownerMessageId: 'mutation-1' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'content:thinking:assistant-tool-entry:0')).toMatchObject({
      turnId: 'pi-turn-0', kind: 'thinking_end', payload: { messageId: 'assistant-tool-entry', text: 'reasoning' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'content:text:assistant-tool-entry:1')).toMatchObject({
      turnId: 'pi-turn-0', kind: 'assistant_text', payload: { text: 'checking' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'tool:call-1')).toMatchObject({
      turnId: 'pi-turn-0', entityVersion: 2, kind: 'tool_execution_end',
      payload: { input: { path: 'note.txt' }, result: 'contents', status: 'completed' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'content:text:assistant-final-entry:0')).toMatchObject({
      turnId: 'pi-turn-1', payload: { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'artifact:plan-1')).toMatchObject({
      kind: 'plan_artifact', payload: { content: '# Plan' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'plan-state:session-1')).toMatchObject({
      kind: 'plan_mode_state', payload: { phase: 'ready', activeArtifactId: 'plan-1' },
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'content:custom:ts-400')).toMatchObject({
      kind: 'custom_display', payload: { content: 'Notice', level: 'warning' },
    })
    expect(snapshot.entities.some(entity => JSON.stringify(entity).includes('wrong branch'))).toBe(false)
    expect(snapshot.entities.filter(entity => entity.entityType === 'turn').map(entity => entity.entityId))
      .toEqual(['turn:pi-turn-0', 'turn:pi-turn-1'])
    expect(snapshot.entities.find(entity => entity.entityId === 'turn:pi-turn-0')).toMatchObject({
      createdAt: 100, updatedAt: 250,
    })
    expect(snapshot.entities.find(entity => entity.entityId === 'turn:pi-turn-1')).toMatchObject({
      createdAt: 300, updatedAt: 400,
    })
  })

  it('is deterministic and produces a terminal snapshot', () => {
    const first = buildPiProjectionSnapshotFromHostProjection('session-1', 'history-runtime', projection())
    const second = buildPiProjectionSnapshotFromHostProjection('session-1', 'history-runtime', projection())

    expect(second).toEqual(first)
    expect(first.entities.at(-1)).toMatchObject({ kind: 'agent_end', payload: { status: 'completed' } })
  })

  it('recovers string assistant history with the canonical Pi entry identity', () => {
    const snapshot = buildPiProjectionSnapshotFromHostProjection('session-1', 'history-runtime', {
      leafId: 'assistant-entry',
      entries: [{
        type: 'message', id: 'user-entry', parentId: null, timestamp: new Date(100).toISOString(),
        message: { role: 'user', content: 'hello', timestamp: 100 },
      }, {
        type: 'message', id: 'assistant-entry', parentId: 'user-entry', timestamp: new Date(200).toISOString(),
        message: { role: 'assistant', content: 'plain answer', timestamp: 200 } as never,
      }],
    })

    expect(snapshot.entities.find(entity => entity.entityId === 'content:text:assistant-entry:0')).toMatchObject({
      kind: 'assistant_text',
      payload: { messageId: 'assistant-entry', text: 'plain answer', isFinal: true },
    })
  })

  it('honors an explicitly empty leaf and rejects an unknown leaf', () => {
    expect(buildPiProjectionSnapshotFromHostProjection('session-1', 'history-runtime', {
      leafId: null,
      entries: projection().entries,
    })).toEqual({
      schemaVersion: 1, sessionId: 'session-1', runtimeId: 'history-runtime', lastSeq: 0, entities: [],
    })

    expect(() => buildPiProjectionSnapshotFromHostProjection('session-1', 'history-runtime', {
      leafId: 'missing',
      entries: projection().entries,
    })).toThrow('Invalid Pi session projection leaf: missing')
  })
})
