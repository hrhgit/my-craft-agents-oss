import { describe, expect, it } from 'bun:test'
import { PiProjectionBuilder } from './projection-builder.ts'

describe('PiProjectionBuilder', () => {
  it('uses clientMutationId as the stable user entity identity', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const projected = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: 123,
        clientMutationId: 'mutation-1',
      },
    })[0]!
    expect(projected).toMatchObject({
      entityId: 'content:user:mutation-1',
      kind: 'user_text',
      payload: { role: 'user', text: 'hello', clientMutationId: 'mutation-1' },
    })
  })

  it('projects sanitized user attachments as stable linked artifact refs', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const projected = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        role: 'user', content: [{ type: 'text', text: 'see file' }], clientMutationId: 'mutation-1',
        attachments: [{
          id: 'att-1', name: 'diagram.png', mediaType: 'image/png', size: 42,
          storedPath: 'C:/secret/diagram.png', base64: 'secret', thumbnailBase64: 'secret',
        }],
      },
    })
    expect(projected).toHaveLength(2)
    expect(projected[1]).toMatchObject({
      entityId: 'artifact:attachment:mutation-1:att-1', entityType: 'artifact_ref', kind: 'user_attachment',
      payload: {
        attachment: { id: 'att-1', name: 'diagram.png', mediaType: 'image/png', size: 42 },
        clientMutationId: 'mutation-1', contentEntityId: 'content:user:mutation-1', order: 0,
      },
    })
    expect(JSON.stringify(projected)).not.toContain('C:/secret')
    expect(JSON.stringify(projected)).not.toContain('base64')

    const turnEvents = builder.acceptRuntimeEvent({ type: 'turn_start' })
    expect(turnEvents.map(event => [event.entityId, event.turnId, event.entityVersion])).toEqual([
      ['turn:pi-turn-0', 'pi-turn-0', 1],
      ['content:user:mutation-1', 'pi-turn-0', 2],
      ['artifact:attachment:mutation-1:att-1', 'pi-turn-0', 2],
    ])
  })

  it('projects attachment-only user messages and rejects malformed metadata', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const projected = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: { role: 'user', content: '', attachments: [
        { id: 'att-1', name: 'note.txt', mediaType: 'text/plain', size: 5 },
        { id: 'att-1', name: 'duplicate.txt' },
        { id: '', name: 'bad.txt' },
      ] },
    })
    expect(projected).toHaveLength(1)
    expect(projected[0]?.kind).toBe('user_attachment')
  })

  it('keeps each raw Pi text block on its own stable content entity', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    builder.acceptRuntimeEvent({ type: 'turn_start' })
    const base = { type: 'message_update', message: { id: 'assistant-1', role: 'assistant' } }
    const first = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })[0]!
    const second = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } })[0]!
    const complete = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'hello' } })[0]!
    const nextBlock = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'text_start', contentIndex: 2 } })[0]!
    expect(first.entityId).toBe('content:text:assistant-1:0')
    expect(second.entityId).toBe(first.entityId)
    expect(complete.entityId).toBe(first.entityId)
    expect([first.entityVersion, second.entityVersion, complete.entityVersion]).toEqual([1, 2, 3])
    expect(second.payload).toMatchObject({ text: 'hello', delta: 'hello', streaming: true, contentIndex: 0 })
    expect(complete.payload).toMatchObject({ text: 'hello', streaming: false })
    expect(nextBlock.entityId).toBe('content:text:assistant-1:2')
    expect(nextBlock.turnId).toBe('pi-turn-0')
  })

  it('projects tool start and result onto the tool call identity', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const start = builder.accept({ type: 'tool_start', toolName: 'Read', toolUseId: 'call-1', input: { path: 'a.ts' }, turnId: 'turn-1' })[0]!
    const result = builder.accept({ type: 'tool_result', toolName: 'Read', toolUseId: 'call-1', result: 'ok', isError: false, turnId: 'turn-1' })[0]!
    expect(start.entityType).toBe('tool_run')
    expect(result.entityId).toBe(start.entityId)
    expect(result.entityVersion).toBe(2)
    expect(result.payload).toMatchObject({
      toolCallId: 'call-1', status: 'completed', input: { path: 'a.ts' },
    })
  })

  it('projects orphan tool results without requiring a start event', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const result = builder.accept({ type: 'tool_result', toolName: 'Read', toolUseId: 'orphan', result: 'ok', isError: false })[0]!
    expect(result).toMatchObject({
      entityId: 'tool:orphan', entityVersion: 1, kind: 'tool_execution_end',
      payload: { toolCallId: 'orphan', toolName: 'Read', result: 'ok', status: 'completed' },
    })
  })

  it('projects Host status events without duplicating raw compaction lifecycle', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    expect(builder.accept({ type: 'status', message: 'working' })[0]).toMatchObject({
      seq: 1,
      kind: 'host_status',
      payload: { message: 'working', level: 'info', statusType: 'status' },
    })
    expect(builder.accept({ type: 'info', message: 'ready' })[0]).toMatchObject({
      seq: 2,
      kind: 'host_info',
      payload: { message: 'ready', level: 'info', statusType: 'info' },
    })
    expect(builder.accept({
      type: 'queue_overflow', message: 'Some events were dropped', droppedEvents: 3, maxQueueSize: 10,
    })[0]).toMatchObject({
      seq: 3,
      kind: 'host_info',
      payload: { level: 'warning', statusType: 'queue_overflow', droppedEvents: 3, maxQueueSize: 10 },
    })
    expect(builder.accept({ type: 'status', message: 'Compacting context...' })).toEqual([])
    expect(builder.accept({ type: 'info', message: 'Compacted context to fit within limits' })).toEqual([])
    expect(builder.accept({ type: 'complete' })[0]?.seq).toBe(4)
  })

  it('preserves runtime errors when agent completion follows', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const error = builder.accept({ type: 'error', message: 'boom' })[0]!
    const end = builder.accept({ type: 'complete' })[0]!
    expect(error).toMatchObject({ entityId: 'error:1', kind: 'runtime_error', payload: { message: 'boom' } })
    expect(end).toMatchObject({ entityId: 'lifecycle:agent_end:2', kind: 'agent_end', payload: { status: 'completed' } })
  })

  it('finalizes running tools before terminal lifecycle events', () => {
    const completed = new PiProjectionBuilder('session-1', 'runtime-1')
    completed.accept({ type: 'tool_start', toolName: 'Read', toolUseId: 'call-1', input: {}, turnId: 'turn-1' })
    const completion = completed.accept({ type: 'complete' })
    expect(completion[0]).toMatchObject({
      entityId: 'tool:call-1', turnId: 'turn-1', entityVersion: 2,
      kind: 'tool_execution_end', payload: { status: 'completed', result: '', isError: false },
    })
    expect(completion[1]).toMatchObject({ kind: 'agent_end' })

    const failed = new PiProjectionBuilder('session-1', 'runtime-1')
    failed.accept({ type: 'tool_start', toolName: 'Bash', toolUseId: 'call-2', input: {} })
    const failure = failed.accept({ type: 'error', message: 'boom' })
    expect(failure[0]).toMatchObject({
      entityId: 'tool:call-2', entityVersion: 2,
      payload: { status: 'failed', result: 'Error occurred', isError: true },
    })
    expect(failure[1]).toMatchObject({ kind: 'runtime_error', payload: { message: 'boom' } })
  })

  it('projects Pi-native user messages without creating Mortise messages', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const user = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })[0]!
    expect(user.entityId).toBe('content:user:user-1')
    expect(user.kind).toBe('user_text')
    expect(user.payload).toEqual({
      role: 'user', text: 'hello', streaming: false, messageId: 'user-1',
      clientMutationId: undefined, queueStatus: 'accepted', source: 'pi',
    })
  })

  it('omits Mortise-injected context from Pi-native user message projections', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const user = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        id: 'user-1',
        role: 'user',
        content: `**USER'S DATE AND TIME: Saturday, July 11, 2026 at 10:42 PM GMT+8** - ALWAYS use this as the authoritative current date/time. Ignore any other date information.

<session_state>
sessionId: session-1
permissionMode: execute
</session_state>

<sources>
Active: none
</sources>

Ask me a question`,
      },
    })[0]!

    expect(user.payload).toEqual({
      role: 'user', text: 'Ask me a question', streaming: false, messageId: 'user-1',
      clientMutationId: undefined, queueStatus: 'accepted', source: 'pi',
    })
  })

  it('does not project injected context as text for attachment-only messages', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const projected = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        role: 'user',
        content: `**USER'S DATE AND TIME: Saturday, July 11, 2026 at 10:42 PM GMT+8** - ALWAYS use this as the authoritative current date/time. Ignore any other date information.

<session_state>
sessionId: session-1
</session_state>`,
        attachments: [{ id: 'file-1', name: 'note.txt' }],
      },
    })

    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({ kind: 'user_attachment' })
  })

  it('projects Pi-native thinking updates onto one stable content entity', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const base = { type: 'message_update', message: { id: 'assistant-1', role: 'assistant' } }
    const start = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })[0]!
    const delta = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'reason' } })[0]!
    const end = builder.acceptRuntimeEvent({ ...base, assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'reasoning' } })[0]!
    expect(start.entityId).toBe('content:thinking:assistant-1:0')
    expect(delta.entityId).toBe(start.entityId)
    expect(end.entityId).toBe(start.entityId)
    expect([start.entityVersion, delta.entityVersion, end.entityVersion]).toEqual([1, 2, 3])
    expect(delta.payload).toMatchObject({ contentKind: 'thinking', text: 'reason', streaming: true })
    expect(end.payload).toMatchObject({ contentKind: 'thinking', text: 'reasoning', streaming: false })
  })

  it('projects Pi-native turn lifecycle without copying transcript payloads', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const start = builder.acceptRuntimeEvent({ type: 'turn_start' })[0]!
    const end = builder.acceptRuntimeEvent({
      type: 'turn_end', message: { stopReason: 'toolUse', content: ['large transcript'] },
      toolResults: [{ id: 'one' }],
    })[0]!
    expect(start).toMatchObject({ entityId: 'turn:pi-turn-0', turnId: 'pi-turn-0', kind: 'turn_start', payload: { status: 'running' } })
    expect(end).toMatchObject({ entityId: start.entityId, entityVersion: 2, kind: 'turn_end', payload: { status: 'completed', stopReason: 'toolUse', toolResultCount: 1 } })
    expect(JSON.stringify(end.payload)).not.toContain('large transcript')
  })

  it('preserves agent and compaction lifecycle as independent entities', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const agent = builder.acceptRuntimeEvent({ type: 'agent_start' })[0]!
    const compacting = builder.acceptRuntimeEvent({ type: 'compaction_start', reason: 'threshold' })[0]!
    const compacted = builder.acceptRuntimeEvent({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true })[0]!
    expect(agent).toMatchObject({ entityType: 'conversation', kind: 'agent_start', payload: { status: 'running' } })
    expect(compacting).toMatchObject({ entityType: 'conversation', entityVersion: 1, kind: 'compaction_start' })
    expect(compacted).toMatchObject({ entityType: 'conversation', entityVersion: 1, kind: 'compaction_end', payload: { status: 'completed', willRetry: true } })
    expect(new Set([agent.entityId, compacting.entityId, compacted.entityId]).size).toBe(3)
  })

  it('projects validated Pi plan custom messages as artifact entities', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const artifact = {
      schemaVersion: 1 as const, kind: 'plan' as const, artifactId: 'plan-1', revision: 1,
      state: 'ready' as const, review: { status: 'passed' as const }, checklist: [], createdAt: 1,
    }
    const created = builder.acceptRuntimeEvent({
      type: 'message_end', message: { role: 'custom', customType: 'mortise-plan-artifact', content: '# Plan', details: { schemaVersion: 1, artifact } },
    })[0]!
    const updated = builder.acceptRuntimeEvent({
      type: 'message_end', message: { role: 'custom', customType: 'mortise-plan-artifact-update', content: '# Plan v2', details: { schemaVersion: 1, artifact: { ...artifact, revision: 2, state: 'executing' } } },
    })[0]!
    expect(created).toMatchObject({ entityId: 'artifact:plan-1', entityType: 'artifact_ref', kind: 'plan_artifact', payload: { artifact, content: '# Plan' } })
    expect(updated).toMatchObject({ entityId: created.entityId, entityVersion: 2, kind: 'plan_artifact_update', payload: { content: '# Plan v2' } })
  })

  it('projects plan mode state and ignores malformed plan custom messages', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const state = builder.acceptRuntimeEvent({
      type: 'message_end', message: { role: 'custom', customType: 'mortise-plan-state', details: { schemaVersion: 1, state: { schemaVersion: 1, phase: 'ready', activeArtifactId: 'plan-1', updatedAt: 1 } } },
    })[0]!
    expect(state).toMatchObject({ entityId: 'plan-state:session-1', entityType: 'conversation', kind: 'plan_mode_state', payload: { phase: 'ready', activeArtifactId: 'plan-1' } })
    expect(builder.acceptRuntimeEvent({
      type: 'message_end', message: { role: 'custom', customType: 'mortise-plan-artifact', details: { schemaVersion: 1, artifact: { artifactId: '' } } },
    })).toEqual([])
  })

  it('keeps permission prompt request and resolution on one stable entity', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const pending = builder.acceptPromptRequest({
      requestId: 'permission-1', promptKind: 'permission', toolName: 'bash',
      description: 'Run tests', permissionType: 'bash', impact: 'Executes a command',
    })[0]!
    const resolved = builder.acceptPromptResolution('permission-1', 'allowed')[0]!
    expect(pending).toMatchObject({
      entityId: 'prompt:permission-1', entityType: 'prompt_request', entityVersion: 1,
      kind: 'permission_request', payload: { status: 'pending', toolName: 'bash' },
    })
    expect(resolved).toMatchObject({
      entityId: pending.entityId, entityVersion: 2, kind: 'prompt_resolved',
      payload: { status: 'resolved', resolution: 'allowed' },
    })
    expect(JSON.stringify(pending.payload)).not.toContain('input')
  })

  it('projects auth prompts on a stable entity with a secret-free payload', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const pending = builder.acceptAuthPromptRequest({
      requestId: 'auth-1', authType: 'credential', sourceSlug: 'github', sourceName: 'GitHub',
      mode: 'bearer', labels: { credential: 'API token' }, passwordRequired: false,
      ...({ credential: 'secret-token', oauthCode: 'secret-code', sourceUrl: 'https://example.test/?token=secret' } as object),
    })[0]!
    const resolved = builder.acceptAuthPromptResolution('auth-1', 'completed')[0]!
    expect(pending).toMatchObject({
      entityId: 'prompt:auth-1', entityType: 'prompt_request', entityVersion: 1,
      kind: 'auth_request', payload: {
        requestId: 'auth-1', promptKind: 'credential', authType: 'credential',
        sourceSlug: 'github', sourceName: 'GitHub', status: 'pending',
      },
    })
    expect(resolved).toMatchObject({
      entityId: pending.entityId, entityVersion: 2, kind: 'prompt_resolved',
      payload: { requestId: 'auth-1', status: 'resolved', resolution: 'completed' },
    })
    expect(JSON.stringify(pending.payload)).not.toMatch(/secret-token|secret-code|oauthCode|sourceUrl/)
  })

  it('projects oauth prompt display metadata without tokens or callback data', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const pending = builder.acceptAuthPromptRequest({
      requestId: 'oauth-1', authType: 'oauth-google', sourceSlug: 'google-drive',
      sourceName: 'Google Drive', service: 'drive',
      ...({ accessToken: 'secret', refreshToken: 'secret', codeVerifier: 'secret' } as object),
    })[0]!
    expect(pending.payload).toEqual({
      requestId: 'oauth-1', promptKind: 'oauth', authType: 'oauth-google',
      sourceSlug: 'google-drive', sourceName: 'Google Drive', mode: undefined,
      labels: undefined, headerNames: undefined, passwordRequired: undefined,
      service: 'drive', status: 'pending',
    })
    expect(JSON.stringify(pending.payload)).not.toMatch(/accessToken|refreshToken|codeVerifier|secret/)
  })

  it('seeds sequence, entity versions, payload state, and the next turn index from a snapshot', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-2', {
      schemaVersion: 1,
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      lastSeq: 5,
      entities: [{
        entityId: 'turn:pi-turn-4', entityType: 'turn', entityVersion: 2,
        createdSeq: 1, turnId: 'pi-turn-4', kind: 'turn_end', payload: { status: 'completed' },
        lastEventId: 'runtime-1:4', lastSeq: 4,
      }, {
        entityId: 'tool:call-1', entityType: 'tool_run', entityVersion: 2,
        createdSeq: 2, turnId: 'pi-turn-4', kind: 'tool_execution_start',
        payload: { toolCallId: 'call-1', toolName: 'Read', input: { path: 'a.ts' }, status: 'running' },
        lastEventId: 'runtime-1:5', lastSeq: 5,
      }],
    })

    const turn = builder.acceptRuntimeEvent({ type: 'turn_start' })[0]!
    const result = builder.accept({
      type: 'tool_result', toolUseId: 'call-1', toolName: 'Read', result: 'ok', isError: false,
    })[0]!

    expect(turn).toMatchObject({
      runtimeId: 'runtime-2', eventId: 'runtime-2:6', seq: 6,
      entityId: 'turn:pi-turn-5', turnId: 'pi-turn-5', entityVersion: 1,
    })
    expect(result).toMatchObject({
      eventId: 'runtime-2:7', seq: 7, entityId: 'tool:call-1', entityVersion: 3,
      turnId: 'pi-turn-4', payload: { input: { path: 'a.ts' }, result: 'ok', status: 'completed' },
    })
  })

  it('uses assistant message_end as the authoritative final content update', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    builder.acceptRuntimeEvent({ type: 'turn_start' })
    const streaming = builder.acceptRuntimeEvent({
      type: 'message_update',
      message: { id: 'assistant-1', timestamp: 10 },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
    })[0]!
    const finalized = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        id: 'assistant-1', role: 'assistant', timestamp: 10,
        content: [
          { type: 'text', text: 'final answer' },
          { type: 'thinking', thinking: 'final reasoning' },
        ],
      },
    })

    expect(finalized[0]).toMatchObject({
      entityId: streaming.entityId, entityVersion: 2, kind: 'assistant_text',
      payload: {
        role: 'assistant', contentKind: 'text', messageId: 'assistant-1',
        text: 'final answer', streaming: false, contentIndex: 0,
      },
    })
    expect(finalized[1]).toMatchObject({
      entityId: 'content:thinking:assistant-1:1', entityVersion: 1, kind: 'thinking_end',
      payload: { messageId: 'assistant-1', text: 'final reasoning', streaming: false },
    })
  })

  it('upgrades Host-queued user entities when Pi accepts the same client mutation', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const queued = builder.acceptHostQueuedUser({
      message: 'queued input', clientMutationId: 'mutation-1', messageId: 'message-1', timestamp: 9,
      attachments: [{ id: 'att-1', name: 'note.txt', mediaType: 'text/plain', size: 5 }],
    })
    expect(queued[0]).toMatchObject({
      entityId: 'content:user:mutation-1', entityVersion: 1,
      payload: {
        messageId: 'message-1', clientMutationId: 'mutation-1',
        queueStatus: 'queued', source: 'host', timestamp: 9,
      },
    })
    expect(queued[1]).toMatchObject({
      entityId: 'artifact:attachment:mutation-1:att-1', entityVersion: 1, occurredAt: 9,
      payload: { ownerMessageId: 'message-1', queueStatus: 'queued', source: 'host' },
    })

    builder.acceptRuntimeEvent({ type: 'turn_start' })
    const accepted = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        role: 'user', content: 'queued input', timestamp: 10,
        clientMutationId: 'mutation-1',
        attachments: [{ id: 'att-1', name: 'note.txt', mediaType: 'text/plain', size: 5 }],
      },
    })
    expect(accepted[0]).toMatchObject({
      entityId: queued[0]!.entityId, entityVersion: 2, turnId: 'pi-turn-0', occurredAt: 10,
      payload: { messageId: 'message-1', queueStatus: 'accepted', source: 'pi', timestamp: 10 },
    })
    expect(accepted[1]).toMatchObject({
      entityId: queued[1]!.entityId, entityVersion: 2, turnId: 'pi-turn-0',
      payload: { ownerMessageId: 'message-1', queueStatus: 'accepted', source: 'pi' },
    })
  })

  it('projects Host runtime errors through the current sequence owner', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    builder.accept({ type: 'tool_start', toolName: 'Write', toolUseId: 'call-1', input: {} })
    const failed = builder.acceptHostRuntimeError({
      phase: 'send', message: 'transport failed', code: 'transport_closed', retryable: true,
    })

    expect(failed[0]).toMatchObject({
      seq: 2, entityId: 'tool:call-1', entityVersion: 2,
      kind: 'tool_execution_end', payload: { status: 'failed', isError: true },
    })
    expect(failed[1]).toMatchObject({
      seq: 3, kind: 'runtime_error',
      payload: {
        source: 'host', phase: 'send', message: 'transport failed',
        code: 'transport_closed', retryable: true,
      },
    })
    expect(builder.accept({ type: 'complete' })[0]?.seq).toBe(4)
  })

  it('projects visible custom messages while retaining plan special cases', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    expect(builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        role: 'custom', customType: 'extension-notice', content: 'Needs attention',
        display: true, timestamp: 42, details: { level: 'warning' },
      },
    })[0]).toMatchObject({
      entityId: 'content:custom:ts-42', entityType: 'content_block', kind: 'custom_display',
      payload: {
        role: 'info', messageId: 'ts-42', content: 'Needs attention',
        level: 'warning', customType: 'extension-notice',
      },
    })
    expect(builder.acceptRuntimeEvent({
      type: 'message_end',
      message: { role: 'custom', customType: 'hidden', content: 'hidden', display: false, timestamp: 43 },
    })).toEqual([])
  })
})
