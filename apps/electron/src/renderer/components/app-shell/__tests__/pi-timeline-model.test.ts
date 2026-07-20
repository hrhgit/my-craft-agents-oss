import { describe, expect, it } from 'bun:test'
import type { PiProjectionEntityV1 } from '@mortise/shared/protocol'
import { buildPiTimelineItems, findPiTimelineMatches, getPiTimelinePageStart, selectPendingPiPermission, selectPiProcessingStatusMessage, selectPiRuntimeState } from '../pi-timeline-model'

function entity(overrides: Partial<PiProjectionEntityV1>): PiProjectionEntityV1 {
  return {
    entityId: 'entity-1', entityType: 'content_block', entityVersion: 1,
    kind: 'assistant_text', payload: { text: 'hello' }, createdSeq: 1, lastEventId: 'event-1', lastSeq: 1,
    ...overrides,
  }
}

describe('buildPiTimelineItems', () => {
  it('preserves normalized-store insertion order when entity versions advance', () => {
    const items = buildPiTimelineItems([
      entity({ entityId: 'text-1', lastSeq: 3, payload: { role: 'assistant', text: 'First', streaming: true } }),
      entity({ entityId: 'tool-1', entityType: 'tool_run', lastSeq: 2, payload: { toolCallId: 'call-1', toolName: 'read', status: 'running', input: { path: 'a' } } }),
    ])
    expect(items.map(item => item.id)).toEqual(['text-1', 'tool-1'])
    expect(items[0]).toMatchObject({ type: 'content', contentKind: 'text', text: 'First', streaming: true })
    expect(items[1]).toMatchObject({ type: 'tool', toolName: 'read', status: 'running' })
  })

  it('keeps Pi thinking blocks distinct from assistant text', () => {
    expect(buildPiTimelineItems([entity({
      kind: 'thinking_end', payload: { role: 'assistant', contentKind: 'thinking', text: 'Reasoning', streaming: false },
    })])[0]).toMatchObject({ type: 'content', contentKind: 'thinking', text: 'Reasoning' })
  })

  it('uses the latest tool result payload and preserves failures', () => {
    expect(buildPiTimelineItems([entity({
      entityType: 'tool_run', kind: 'tool_execution_end',
      payload: { toolCallId: 'call-1', toolName: 'bash', result: 'exit 1', status: 'failed', isError: true },
    })])[0]).toMatchObject({ type: 'tool', status: 'failed', result: 'exit 1', isError: true })
  })

  it('projects validated plan artifacts without rebuilding Mortise messages', () => {
    const artifact = {
      schemaVersion: 1 as const,
      kind: 'plan' as const,
      artifactId: 'plan-1',
      revision: 2,
      state: 'ready' as const,
      createdAt: 100,
      review: { status: 'passed' as const, body: 'Looks good.' },
      checklist: [{ id: 'step-1', title: 'Ship it', status: 'pending' as const }],
    }
    expect(buildPiTimelineItems([entity({
      entityId: 'artifact:plan-1', entityType: 'artifact_ref', kind: 'plan_artifact_update', lastSeq: 8,
      payload: { artifact, content: '# Updated plan' },
    })])[0]).toEqual({
      type: 'artifact', id: 'artifact:plan-1', turnId: undefined, seq: 8,
      artifact, content: '# Updated plan',
    })
  })

  it('renders sanitized user attachment refs in projection order', () => {
    expect(buildPiTimelineItems([entity({
      entityId: 'artifact:attachment:mutation-1:att-1', entityType: 'artifact_ref', kind: 'user_attachment',
      lastSeq: 4, turnId: 'turn-1',
      payload: {
        attachment: { id: 'att-1', name: 'photo.png', mediaType: 'image/png', size: 42 },
        clientMutationId: 'mutation-1', order: 0,
      },
    })])[0]).toEqual({
      type: 'attachment', id: 'artifact:attachment:mutation-1:att-1', turnId: 'turn-1', seq: 4,
      attachmentId: 'att-1', name: 'photo.png', mediaType: 'image/png', size: 42,
      clientMutationId: 'mutation-1',
    })
  })

  it('ignores malformed artifact payloads', () => {
    expect(buildPiTimelineItems([entity({
      entityType: 'artifact_ref', kind: 'plan_artifact',
      payload: { artifact: { schemaVersion: 1, kind: 'plan', artifactId: '' }, content: '# Invalid' },
    })])).toEqual([])
  })

  it('ignores unsupported and malformed entities', () => {
    expect(buildPiTimelineItems([
      entity({ entityType: 'conversation', payload: { usage: {} } }),
      entity({ entityId: 'empty', payload: { text: '' } }),
    ])).toEqual([])
  })

  it('selects only pending Host permission prompt entities', () => {
    const pending = entity({
      entityId: 'prompt:one', entityType: 'prompt_request', kind: 'permission_request',
      payload: { requestId: 'one', toolName: 'bash', description: 'Run tests', command: 'bun test', permissionType: 'bash', status: 'pending' },
    })
    expect(selectPendingPiPermission([pending], 'session-1')).toMatchObject({
      sessionId: 'session-1', requestId: 'one', command: 'bun test', type: 'bash',
    })
    expect(selectPendingPiPermission([{ ...pending, kind: 'prompt_resolved', payload: { requestId: 'one', status: 'resolved' } }], 'session-1')).toBeUndefined()
  })

  it('derives processing from the latest Pi lifecycle event and preserves errors', () => {
    const start = entity({ entityId: 'turn', entityType: 'turn', kind: 'turn_start', payload: { status: 'running' }, lastSeq: 2 })
    expect(selectPiRuntimeState([start])).toEqual({ isProcessing: true, isCompacting: false })
    const end = entity({ entityId: 'conversation', entityType: 'conversation', kind: 'agent_end', payload: { status: 'completed' }, lastSeq: 4 })
    expect(selectPiRuntimeState([start, end])).toEqual({ isProcessing: false, isCompacting: false })
    expect(buildPiTimelineItems([entity({ entityId: 'error:3', entityType: 'conversation', kind: 'runtime_error', payload: { message: 'boom' }, lastSeq: 3 })]))
      .toEqual([{ type: 'error', id: 'error:3', turnId: undefined, seq: 3, message: 'boom' }])
  })

  it('keeps retry attempts processing until logical settlement', () => {
    const start = entity({ entityId: 'agent-start', entityType: 'conversation', kind: 'agent_start', payload: { status: 'running' }, lastSeq: 1 })
    const attemptEnd = entity({
      entityId: 'agent-attempt-end', entityType: 'conversation', kind: 'agent_end',
      payload: { status: 'failed', willRetry: true, settlementPending: true }, lastSeq: 2,
    })
    const settled = entity({ entityId: 'agent-settled', entityType: 'conversation', kind: 'agent_settled', payload: { status: 'completed' }, lastSeq: 3 })

    expect(selectPiRuntimeState([start, attemptEnd])).toEqual({ isProcessing: true, isCompacting: false })
    expect(selectPiRuntimeState([start, attemptEnd, settled])).toEqual({ isProcessing: false, isCompacting: false })
  })

  it('selects processing status only from the current projected runtime', () => {
    const oldStatus = entity({ entityId: 'status-old', kind: 'host_status', payload: { message: 'Old status' }, lastSeq: 1 })
    const start = entity({ entityId: 'agent-start', entityType: 'conversation', kind: 'agent_start', payload: { status: 'running' }, lastSeq: 2 })
    const currentStatus = entity({ entityId: 'status-current', kind: 'host_status', payload: { message: 'Reading files' }, lastSeq: 3 })
    const end = entity({ entityId: 'agent-end', entityType: 'conversation', kind: 'agent_end', payload: { status: 'completed' }, lastSeq: 4 })

    expect(selectPiProcessingStatusMessage([oldStatus, start])).toBeUndefined()
    expect(selectPiProcessingStatusMessage([oldStatus, start, currentStatus])).toBe('Reading files')
    expect(selectPiProcessingStatusMessage([oldStatus, start, currentStatus, end])).toBeUndefined()
  })
})

describe('projection-native search and pagination', () => {
  const items = buildPiTimelineItems([
    entity({ entityId: 'user-1', payload: { role: 'user', text: 'Find auth handler' } }),
    entity({ entityId: 'tool-1', entityType: 'tool_run', payload: { toolCallId: 'call-1', toolName: 'grep', status: 'completed', input: { pattern: 'auth' }, result: 'auth.ts' } }),
    entity({ entityId: 'answer-1', payload: { role: 'assistant', text: 'Found auth twice: auth' } }),
  ])

  it('searches normalized content and tool entities without Mortise messages', () => {
    expect(findPiTimelineMatches(items, 'auth').map(match => match.itemId)).toEqual([
      'user-1', 'tool-1', 'tool-1', 'answer-1', 'answer-1',
    ])
    expect(findPiTimelineMatches(items, 'a')).toEqual([])
  })

  it('opens pagination at the earliest match and otherwise shows the tail', () => {
    expect(getPiTimelinePageStart(100, 20)).toBe(80)
    expect(getPiTimelinePageStart(100, 20, [{ matchId: 'm', itemId: 'i', itemIndex: 42, matchIndexInItem: 0 }])).toBe(37)
  })
})
