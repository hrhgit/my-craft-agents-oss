import { describe, expect, it } from 'bun:test'
import type { PiProjectionEntityV1 } from '@craft-agent/shared/protocol'
import type { Message } from '../../../../shared/types'
import { buildPiTurnOverlay, buildPiTurns, getPiTurnSearchText } from '../pi-turn-model'

function entity(overrides: Partial<PiProjectionEntityV1> = {}): PiProjectionEntityV1 {
  return {
    entityId: 'content:text:assistant-1:0',
    entityType: 'content_block',
    entityVersion: 1,
    createdSeq: 1,
    turnId: 'turn-1',
    kind: 'assistant_text',
    payload: { role: 'assistant', messageId: 'assistant-1', contentIndex: 0, text: 'hello', streaming: false },
    lastEventId: 'event-1',
    lastSeq: 1,
    ...overrides,
  }
}

function annotation(messageId: string) {
  return {
    schemaVersion: 1 as const,
    id: `annotation-${messageId}`,
    createdAt: 10,
    updatedAt: 10,
    intent: 'comment' as const,
    body: [{ type: 'note' as const, text: 'Follow up' }],
    target: {
      source: { sessionId: 'session-1', messageId },
      selectors: [
        { type: 'text-position' as const, start: 0, end: 4 },
        { type: 'text-quote' as const, exact: 'done' },
      ],
    },
  }
}

describe('buildPiTurns', () => {
  it('builds the existing user bubble model and merges local attachment metadata', () => {
    const localAttachment = {
      id: 'attachment-1', type: 'image' as const, name: 'photo.png', mimeType: 'image/png',
      size: 42, storedPath: 'C:/workspace/photo.png', thumbnailBase64: 'preview',
    }
    const overlay = buildPiTurnOverlay([{
      id: 'mutation-1', role: 'user', content: 'ignored Craft content', timestamp: 1234,
      attachments: [localAttachment], isQueued: true,
    }])
    const turns = buildPiTurns([
      entity({
        entityId: 'content:user:mutation-1', createdSeq: 1, turnId: undefined, kind: 'user_text',
        payload: { role: 'user', text: 'Pi owns this text', clientMutationId: 'mutation-1', optimistic: true },
      }),
      entity({
        entityId: 'artifact:attachment:mutation-1:attachment-1', entityType: 'artifact_ref',
        createdSeq: 2, turnId: undefined, kind: 'user_attachment',
        payload: {
          attachment: { id: 'attachment-1', name: 'photo.png', mediaType: 'image/png', size: 42 },
          clientMutationId: 'mutation-1', contentEntityId: 'content:user:mutation-1', order: 0,
        },
      }),
    ], overlay)

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      type: 'user',
      message: {
        id: 'mutation-1', content: 'Pi owns this text', timestamp: 1234,
        isPending: true, isQueued: true, attachments: [localAttachment],
      },
    })
  })

  it('uses the projected message timestamp without requiring an overlay match', () => {
    const timestamp = 1_783_861_200_000
    const turns = buildPiTurns([entity({
      entityId: 'content:user:runtime-user-1', createdSeq: 2, kind: 'user_text',
      payload: {
        role: 'user', messageId: 'runtime-user-1', text: 'hello', streaming: false, timestamp,
      },
    })])

    expect(turns[0]).toMatchObject({ type: 'user', timestamp, message: { timestamp } })
  })

  it('derives stable request timing from the user message and final turn lifecycle', () => {
    const startedAt = 1_783_861_200_000
    const completedAt = startedAt + 65_432
    const turns = buildPiTurns([
      entity({
        entityId: 'content:user:user-timing', createdSeq: 1, turnId: 'turn-timing', kind: 'user_text',
        createdAt: startedAt, updatedAt: startedAt,
        payload: { role: 'user', messageId: 'user-timing', text: 'timed request', streaming: false, timestamp: startedAt },
      }),
      entity({
        entityId: 'turn:turn-timing', entityType: 'turn', createdSeq: 2, lastSeq: 4,
        turnId: 'turn-timing', kind: 'turn_end', createdAt: startedAt, updatedAt: completedAt,
        payload: { status: 'completed' },
      }),
      entity({
        entityId: 'content:text:assistant-timing:0', createdSeq: 3, turnId: 'turn-timing',
        payload: {
          role: 'assistant', messageId: 'assistant-timing', contentIndex: 0,
          text: 'done', streaming: false, isFinal: true,
        },
      }),
    ])

    expect(turns[1]).toMatchObject({
      type: 'assistant', startedAt, completedAt, durationMs: 65_432,
    })
  })

  it('falls back to the runtime terminal time for the final response card', () => {
    const startedAt = 1_783_861_200_000
    const completedAt = startedAt + 8_900
    const turns = buildPiTurns([
      entity({
        entityId: 'content:user:user-terminal', createdSeq: 1, turnId: 'turn-terminal', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-terminal', text: 'timed request', streaming: false, timestamp: startedAt },
      }),
      entity({
        entityId: 'turn:turn-terminal', entityType: 'turn', createdSeq: 2, lastSeq: 4,
        turnId: 'turn-terminal', kind: 'turn_end',
        payload: { status: 'completed' },
      }),
      entity({
        entityId: 'content:text:assistant-terminal:0', createdSeq: 3, turnId: 'turn-terminal',
        payload: {
          role: 'assistant', messageId: 'assistant-terminal', contentIndex: 0,
          text: 'done', streaming: false, isFinal: true,
        },
      }),
      entity({
        entityId: 'agent:end', entityType: 'conversation', createdSeq: 5, lastSeq: 5,
        turnId: undefined, kind: 'agent_end', updatedAt: completedAt,
        payload: { status: 'completed' },
      }),
    ])

    expect(turns[1]).toMatchObject({
      type: 'assistant', startedAt, completedAt, durationMs: 8_900,
    })
  })

  it('keeps attachment-only prompts visible with a safe fallback attachment', () => {
    const turns = buildPiTurns([entity({
      entityId: 'artifact:attachment:user-1:file-1', entityType: 'artifact_ref',
      createdSeq: 1, turnId: undefined, kind: 'user_attachment',
      payload: {
        ownerMessageId: 'user-1', queueStatus: 'queued',
        attachment: { id: 'file-1', name: 'notes.txt', mediaType: 'text/plain', size: 5 }, order: 0,
      },
    })])
    expect(turns[0]).toMatchObject({
      type: 'user',
      message: { id: 'user-1', content: '', isQueued: true, attachments: [{ id: 'file-1', type: 'text', storedPath: '' }] },
    })
  })

  it('keeps the user before its assistant turn when Pi emits turn_start first', () => {
    const turns = buildPiTurns([
      entity({
        entityId: 'turn:pi-turn-0', entityType: 'turn', createdSeq: 2, lastSeq: 5,
        turnId: 'pi-turn-0', kind: 'turn_end', payload: { status: 'completed' },
      }),
      entity({
        entityId: 'content:user:user-1', createdSeq: 3, turnId: 'pi-turn-0', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-1', text: 'hello', streaming: false },
      }),
      entity({
        entityId: 'content:text:assistant-1:0', createdSeq: 4, turnId: 'pi-turn-0',
        payload: {
          role: 'assistant', messageId: 'assistant-1', contentIndex: 0,
          text: 'answer', streaming: false, isFinal: true,
        },
      }),
    ])

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(turns[0]).toMatchObject({ message: { id: 'user-1', content: 'hello' } })
    expect(turns[1]).toMatchObject({ response: { messageId: 'assistant-1', text: 'answer' } })
  })

  it('places an empty streaming assistant shell after the user in the same turn', () => {
    const turns = buildPiTurns([
      entity({
        entityId: 'turn:pi-turn-0', entityType: 'turn', createdSeq: 2,
        turnId: 'pi-turn-0', kind: 'turn_start', payload: { status: 'running' },
      }),
      entity({
        entityId: 'content:user:user-1', createdSeq: 3, turnId: 'pi-turn-0', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-1', text: 'hello', streaming: false },
      }),
    ])

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(turns[1]).toMatchObject({ type: 'assistant', isStreaming: true, timestamp: 3 })
  })

  it('groups thinking, tool work, commentary, and the final response into one TurnCard model', () => {
    const responseAnnotation = annotation('assistant-final')
    const overlay = buildPiTurnOverlay([{
      id: 'assistant-final', role: 'assistant', content: 'ignored', timestamp: 50,
      annotations: [responseAnnotation],
    }])
    const turns = buildPiTurns([
      entity({
        entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 2, lastSeq: 9,
        kind: 'turn_end', payload: { status: 'completed' },
      }),
      entity({
        entityId: 'content:thinking:assistant-thinking:0', createdSeq: 3, kind: 'thinking_end',
        payload: { role: 'assistant', messageId: 'assistant-thinking', contentKind: 'thinking', contentIndex: 0, text: 'Reasoning', streaming: false },
      }),
      entity({
        entityId: 'content:text:assistant-comment:0', createdSeq: 4,
        payload: { role: 'assistant', messageId: 'assistant-comment', contentIndex: 0, text: 'I will inspect it.', streaming: false, isIntermediate: true },
      }),
      entity({
        entityId: 'tool:read-1', entityType: 'tool_run', createdSeq: 5, kind: 'tool_execution_end',
        payload: { toolCallId: 'read-1', toolName: 'Read', input: { path: 'a.ts' }, result: 'source', status: 'completed' },
      }),
      entity({
        entityId: 'content:text:assistant-final:0', createdSeq: 6,
        payload: { role: 'assistant', messageId: 'assistant-final', contentIndex: 0, text: 'Done.', streaming: false, isIntermediate: false },
      }),
    ], overlay)

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      type: 'assistant', turnId: 'turn-1', isComplete: true, isStreaming: false,
      response: { text: 'Done.', messageId: 'assistant-final', annotations: [responseAnnotation] },
    })
    if (turns[0]?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(turns[0].activities.map(activity => [activity.type, activity.content])).toEqual([
      ['intermediate', 'Reasoning'],
      ['intermediate', 'I will inspect it.'],
      ['tool', 'source'],
    ])
  })

  it('merges low-level Pi model turns into one user-visible response card', () => {
    const turns = buildPiTurns([
      entity({ entityId: 'agent:start', entityType: 'conversation', createdSeq: 1, lastSeq: 1, turnId: undefined, kind: 'agent_start', payload: { status: 'running' } }),
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 2, lastSeq: 6, kind: 'turn_end', payload: { status: 'completed', stopReason: 'toolUse' } }),
      entity({
        entityId: 'content:user:user-1', createdSeq: 3, turnId: 'turn-1', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-1', text: 'inspect it', streaming: false },
      }),
      entity({
        entityId: 'content:text:assistant-comment:0', createdSeq: 4, turnId: 'turn-1',
        payload: { role: 'assistant', messageId: 'assistant-comment', contentIndex: 0, text: 'I will inspect it.', streaming: false, isIntermediate: true },
      }),
      entity({
        entityId: 'tool:read-1', entityType: 'tool_run', createdSeq: 5, turnId: 'turn-1', kind: 'tool_execution_end',
        payload: { toolCallId: 'read-1', toolName: 'Read', result: 'source', status: 'completed' },
      }),
      entity({ entityId: 'turn:turn-2', entityType: 'turn', createdSeq: 7, lastSeq: 9, turnId: 'turn-2', kind: 'turn_end', payload: { status: 'completed', stopReason: 'stop' } }),
      entity({
        entityId: 'content:text:assistant-final:0', createdSeq: 8, turnId: 'turn-2',
        payload: { role: 'assistant', messageId: 'assistant-final', contentIndex: 0, text: 'Done.', streaming: false, isFinal: true },
      }),
      entity({ entityId: 'agent:end', entityType: 'conversation', createdSeq: 10, lastSeq: 10, turnId: undefined, kind: 'agent_end', payload: { status: 'completed' } }),
    ])

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(turns[1]).toMatchObject({
      type: 'assistant', isComplete: true,
      response: { messageId: 'assistant-final', text: 'Done.' },
    })
    if (turns[1]?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(turns[1].activities.map(activity => [activity.type, activity.content])).toEqual([
      ['intermediate', 'I will inspect it.'],
      ['tool', 'source'],
    ])
  })

  it('keeps a completed tool round expanded at the batch level while the agent is still running', () => {
    const turns = buildPiTurns([
      entity({ entityId: 'agent:start', entityType: 'conversation', createdSeq: 1, lastSeq: 1, turnId: undefined, kind: 'agent_start', payload: { status: 'running' } }),
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 2, lastSeq: 6, kind: 'turn_end', payload: { status: 'completed', stopReason: 'toolUse' } }),
      entity({
        entityId: 'content:user:user-1', createdSeq: 3, turnId: 'turn-1', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-1', text: 'inspect it', streaming: false },
      }),
      entity({
        entityId: 'content:text:assistant-comment:0', createdSeq: 4, turnId: 'turn-1',
        payload: { role: 'assistant', messageId: 'assistant-comment', contentIndex: 0, text: 'Inspecting.', streaming: false, isIntermediate: true },
      }),
      entity({
        entityId: 'tool:read-1', entityType: 'tool_run', createdSeq: 5, turnId: 'turn-1', kind: 'tool_execution_end',
        payload: { toolCallId: 'read-1', toolName: 'Read', result: 'source', status: 'completed' },
      }),
    ])

    expect(turns[1]).toMatchObject({ type: 'assistant', isComplete: false, isStreaming: false, response: undefined })
  })

  it('starts a new visible response card after the next user message', () => {
    const turns = buildPiTurns([
      entity({
        entityId: 'content:user:user-1', createdSeq: 1, turnId: 'turn-1', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-1', text: 'first', streaming: false },
      }),
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 2, lastSeq: 3, kind: 'turn_end', payload: { status: 'completed' } }),
      entity({
        entityId: 'content:text:assistant-1:0', createdSeq: 3, turnId: 'turn-1',
        payload: { role: 'assistant', messageId: 'assistant-1', contentIndex: 0, text: 'First answer', streaming: false, isFinal: true },
      }),
      entity({
        entityId: 'content:user:user-2', createdSeq: 4, turnId: 'turn-2', kind: 'user_text',
        payload: { role: 'user', messageId: 'user-2', text: 'second', streaming: false },
      }),
      entity({ entityId: 'turn:turn-2', entityType: 'turn', createdSeq: 5, lastSeq: 7, kind: 'turn_end', payload: { status: 'completed' } }),
      entity({
        entityId: 'tool:misattributed', entityType: 'tool_run', createdSeq: 6, turnId: 'turn-1', kind: 'tool_execution_end',
        payload: { toolCallId: 'misattributed', toolName: 'pwsh', result: 'ok', status: 'completed' },
      }),
      entity({
        entityId: 'content:text:assistant-2:0', createdSeq: 7, turnId: 'turn-2',
        payload: { role: 'assistant', messageId: 'assistant-2', contentIndex: 0, text: 'Second answer', streaming: false, isFinal: true },
      }),
    ])

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    if (turns[1]?.type !== 'assistant' || turns[3]?.type !== 'assistant') throw new Error('Expected assistant turns')
    expect(turns[1].activities).toHaveLength(0)
    expect(turns[3].activities.map(activity => activity.toolName)).toEqual(['pwsh'])
  })

  it('uses tool ordering as a compatibility fallback for payloads without finality', () => {
    const turns = buildPiTurns([
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 1, lastSeq: 8, kind: 'turn_end', payload: { status: 'completed' } }),
      entity({
        entityId: 'content:text:comment:0', createdSeq: 2,
        payload: { role: 'assistant', contentIndex: 0, text: 'Checking.', streaming: false },
      }),
      entity({
        entityId: 'tool:read', entityType: 'tool_run', createdSeq: 3, kind: 'tool_execution_end',
        payload: { toolCallId: 'read', toolName: 'Read', status: 'completed', result: 'ok' },
      }),
      entity({
        entityId: 'content:text:final:0', createdSeq: 4,
        payload: { role: 'assistant', contentIndex: 0, text: 'Finished.', streaming: false },
      }),
    ])
    expect(turns[0]).toMatchObject({ type: 'assistant', response: { messageId: 'final', text: 'Finished.' } })
    if (turns[0]?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(turns[0].activities.some(activity => activity.content === 'Checking.')).toBe(true)
  })

  it('joins text blocks by contentIndex and preserves a streaming turn lifecycle', () => {
    const turns = buildPiTurns([
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 1, kind: 'turn_start', payload: { status: 'running' } }),
      entity({
        entityId: 'content:text:assistant-1:2', createdSeq: 3, lastSeq: 5,
        payload: { role: 'assistant', messageId: 'assistant-1', contentIndex: 2, text: 'second', streaming: true },
      }),
      entity({
        entityId: 'content:text:assistant-1:0', createdSeq: 2, lastSeq: 4,
        payload: { role: 'assistant', messageId: 'assistant-1', contentIndex: 0, text: 'first', streaming: false },
      }),
    ])
    expect(turns[0]).toMatchObject({
      type: 'assistant', isComplete: false, isStreaming: true,
      response: { messageId: 'assistant-1', text: 'first\n\nsecond', isStreaming: true },
    })
  })

  it('renders auth lifecycle and runtime failures through the existing turn variants', () => {
    const turns = buildPiTurns([
      entity({
        entityId: 'prompt:oauth-1', entityType: 'prompt_request', createdSeq: 1, turnId: undefined,
        kind: 'prompt_resolved', payload: {
          requestId: 'oauth-1', authType: 'oauth-google', sourceSlug: 'drive', sourceName: 'Google Drive',
          status: 'resolved', resolution: 'completed',
        },
      }),
      entity({
        entityId: 'error:2', entityType: 'conversation', createdSeq: 2, turnId: undefined,
        kind: 'runtime_error', payload: { message: 'Process exited', code: 'process_exited' },
      }),
    ])
    expect(turns.map(turn => turn.type)).toEqual(['auth-request', 'system'])
    expect(turns[0]).toMatchObject({
      message: { authRequestId: 'oauth-1', authRequestType: 'oauth-google', authStatus: 'completed' },
    })
    expect(turns[1]).toMatchObject({ message: { role: 'error', content: 'Process exited', errorCode: 'process_exited' } })
  })

  it('renders Host status, info, queue warnings, and displayable custom messages', () => {
    const turns = buildPiTurns([
      entity({
        entityId: 'host:status:1', entityType: 'conversation', createdSeq: 1, turnId: undefined,
        kind: 'host_status', payload: { message: 'Retrying request', level: 'info' },
      }),
      entity({
        entityId: 'host:info:2', entityType: 'conversation', createdSeq: 2, turnId: undefined,
        kind: 'host_info', payload: { message: 'Some events were dropped', level: 'warning', statusType: 'queue_overflow' },
      }),
      entity({
        entityId: 'content:custom:notice-1', entityType: 'content_block', createdSeq: 3, turnId: undefined,
        kind: 'custom_display', payload: {
          role: 'info', messageId: 'notice-1', content: 'Extension notice',
          level: 'error', customType: 'extension_notice',
        },
      }),
    ])

    expect(turns.map(turn => turn.type)).toEqual(['system', 'system', 'system'])
    expect(turns[0]).toMatchObject({ message: { role: 'status', content: 'Retrying request' } })
    expect(turns[1]).toMatchObject({ message: { role: 'info', content: 'Some events were dropped', infoLevel: 'warning' } })
    expect(turns[2]).toMatchObject({
      message: {
        id: 'notice-1', role: 'info', content: 'Extension notice', infoLevel: 'error',
        customType: 'extension_notice', customDisplay: true,
      },
    })
  })

  it('binds plan artifacts and annotations to their Pi assistant message identity', () => {
    const planAnnotation = annotation('plan-message')
    const overlay = buildPiTurnOverlay([{
      id: 'plan-message', role: 'assistant', content: 'ignored', timestamp: 10, annotations: [planAnnotation],
    }])
    const artifact = {
      schemaVersion: 1 as const, kind: 'plan' as const, artifactId: 'plan-1', revision: 1,
      state: 'ready' as const, review: { status: 'passed' as const }, checklist: [], createdAt: 1,
    }
    const turns = buildPiTurns([
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 1, lastSeq: 4, kind: 'turn_end', payload: { status: 'completed' } }),
      entity({
        entityId: 'content:text:plan-message:0', createdSeq: 2,
        payload: { role: 'assistant', messageId: 'plan-message', contentIndex: 0, text: 'Draft plan', streaming: false, isFinal: true },
      }),
      entity({
        entityId: 'artifact:plan-1', entityType: 'artifact_ref', createdSeq: 3, turnId: undefined,
        kind: 'plan_artifact', payload: { artifact, content: '# Final plan', assistantMessageId: 'plan-message' },
      }),
    ], overlay)
    expect(turns[0]).toMatchObject({
      type: 'assistant',
      response: { text: '# Final plan', messageId: 'plan-message', artifact, annotations: [planAnnotation] },
    })
  })

  it('searches response and tool detail text from the projected Turn model', () => {
    const turns = buildPiTurns([
      entity({ entityId: 'turn:turn-1', entityType: 'turn', createdSeq: 1, lastSeq: 4, kind: 'turn_end', payload: { status: 'completed' } }),
      entity({
        entityId: 'tool:grep', entityType: 'tool_run', createdSeq: 2, kind: 'tool_execution_end',
        payload: { toolCallId: 'grep', toolName: 'Grep', input: { pattern: 'projection' }, result: 'pi-turn-model.ts', status: 'completed' },
      }),
    ])
    expect(getPiTurnSearchText(turns[0]!)).toContain('projection')
    expect(getPiTurnSearchText(turns[0]!)).toContain('pi-turn-model.ts')
  })

  it('never reads Craft transcript content while building the overlay', () => {
    const message = {
      id: 'assistant-1', role: 'assistant', content: 'legacy text must not render', timestamp: 10,
      annotations: [annotation('assistant-1')],
    } satisfies Message
    const turns = buildPiTurns([entity()], buildPiTurnOverlay([message]))
    expect(turns[0]).toMatchObject({
      type: 'assistant', response: { text: 'hello', annotations: message.annotations },
    })
    expect(getPiTurnSearchText(turns[0]!)).not.toContain('legacy text')
  })

  it('does not merge Craft overlays by timestamp aliases', () => {
    const message = {
      id: 'different-message', role: 'assistant', content: '', timestamp: 10,
      annotations: [annotation('different-message')],
    } satisfies Message
    const turns = buildPiTurns([entity({
      entityId: 'content:text:ts-10:0',
      payload: {
        role: 'assistant', messageId: 'ts-10', contentKind: 'text', contentIndex: 0,
        text: 'Pi response', streaming: false, isFinal: true,
      },
    })], buildPiTurnOverlay([message]))

    expect(turns[0]).toMatchObject({
      type: 'assistant', response: { text: 'Pi response', messageId: 'ts-10' },
    })
    expect(turns[0]?.type === 'assistant' ? turns[0].response?.annotations : undefined).toBeUndefined()
  })

  it('does not merge Craft overlays through entity or client mutation aliases', () => {
    const userAliasOverlay = {
      id: 'mutation-alias', role: 'user', content: '', timestamp: 999,
      badges: [{ type: 'command' as const, label: 'Alias', rawText: '/alias', start: 0, end: 6 }],
    } satisfies Message
    const assistantAliasOverlay = {
      id: 'content:text:entity-alias:0', role: 'assistant', content: '', timestamp: 999,
      annotations: [annotation('content:text:entity-alias:0')],
    } satisfies Message
    const turns = buildPiTurns([
      entity({
        entityId: 'content:user:entity-alias', createdSeq: 5, turnId: undefined, kind: 'user_text',
        payload: {
          role: 'user', messageId: 'pi-user', clientMutationId: 'mutation-alias',
          text: 'Pi user text', streaming: false,
        },
      }),
      entity({
        entityId: 'content:text:entity-alias:0', createdSeq: 6,
        payload: {
          role: 'assistant', messageId: 'pi-assistant', clientMutationId: 'assistant-mutation-alias',
          contentIndex: 0, text: 'Pi assistant text', streaming: false, isFinal: true,
        },
      }),
    ], buildPiTurnOverlay([userAliasOverlay, assistantAliasOverlay]))

    expect(turns[0]).toMatchObject({
      type: 'user',
      message: { id: 'pi-user', content: 'Pi user text', timestamp: 5 },
    })
    expect(turns[0]?.type === 'user' ? turns[0].message.badges : undefined).toBeUndefined()
    expect(turns[1]).toMatchObject({
      type: 'assistant', response: { messageId: 'pi-assistant', text: 'Pi assistant text' },
    })
    expect(turns[1]?.type === 'assistant' ? turns[1].response?.annotations : undefined).toBeUndefined()
  })
})
