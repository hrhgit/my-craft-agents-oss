import { describe, expect, it } from 'bun:test'
import type { AgentEvent as PiAgentEvent } from '@craft-agent/core/types'
import { PiProjectionBuilder } from '../../../../../../packages/shared/src/agent/backend/pi/projection-builder'
import { applyPiProjectionEvent, createPiProjectionState } from '../../atoms/pi-projection'
import { selectPiRuntimeState } from '../../components/app-shell/pi-timeline-model'
import { buildPiTurns } from '../../components/app-shell/pi-turn-model'
import { processEvent } from '../processor'
import type { AgentEvent as LegacyEvent, SessionState } from '../types'

type VisibleItem =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed'; result?: unknown; isError: boolean }
  | { type: 'error'; message: string }

interface ParityResult {
  legacy: { items: VisibleItem[]; isProcessing: boolean }
  projection: { items: VisibleItem[]; isProcessing: boolean }
}

function initialLegacyState(): SessionState {
  return {
    session: {
      id: 'session-1', workspaceId: 'workspace-1', workspaceName: 'Workspace',
      messages: [], isProcessing: true, lastMessageAt: 0,
    } as SessionState['session'],
    streaming: null,
  }
}

function visibleLegacy(state: SessionState): VisibleItem[] {
  return state.session.messages.flatMap((message): VisibleItem[] => {
    if (message.role === 'assistant' && message.content) {
      return [{ type: 'text', text: message.content }]
    }
    if (message.role === 'tool') {
      const status = message.toolStatus === 'executing' || message.toolStatus === 'backgrounded'
        ? 'running'
        : message.toolStatus === 'error' ? 'failed' : 'completed'
      return [{
        type: 'tool', toolCallId: message.toolUseId ?? '', toolName: message.toolName ?? 'tool',
        status, result: message.toolResult, isError: message.isError === true,
      }]
    }
    if (message.role === 'error') return [{ type: 'error', message: message.content }]
    return []
  })
}

function visibleProjection(state: ReturnType<typeof createPiProjectionState>): VisibleItem[] {
  const entities = state.entityIds.map(id => state.entitiesById[id]!).filter(Boolean)
  return buildPiTurns(entities).flatMap((turn): VisibleItem[] => {
    if (turn.type === 'system' && turn.message.role === 'error') {
      return [{ type: 'error', message: turn.message.content }]
    }
    if (turn.type !== 'assistant') return []
    const tools = turn.activities.flatMap((activity): VisibleItem[] => activity.type === 'tool' ? [{
      type: 'tool', toolCallId: activity.toolUseId ?? '', toolName: activity.toolName ?? 'tool',
      status: activity.status === 'error' ? 'failed'
        : activity.status === 'running' || activity.status === 'pending' || activity.status === 'backgrounded' ? 'running'
        : 'completed',
      result: activity.content,
      isError: activity.status === 'error',
    }] : [])
    return turn.response?.text
      ? [...tools, { type: 'text', text: turn.response.text }]
      : tools
  })
}

function runParity(steps: Array<{ legacy: LegacyEvent; projection: PiAgentEvent }>): ParityResult {
  let legacy = initialLegacyState()
  let projection = createPiProjectionState('session-1')
  const builder = new PiProjectionBuilder('session-1', 'runtime-1')

  for (const step of steps) {
    legacy = processEvent(legacy, step.legacy).state
    const projectedEvents = step.projection.type === 'text_delta'
      ? builder.acceptRuntimeEvent({
          type: 'message_update',
          message: { id: 'assistant-1', role: 'assistant' },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: step.projection.text },
        })
      : step.projection.type === 'text_complete'
        ? builder.acceptRuntimeEvent({
            type: 'message_update',
            message: { id: 'assistant-1', role: 'assistant' },
            assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: step.projection.text },
          })
        : builder.accept(step.projection)
    for (const event of projectedEvents) {
      projection = applyPiProjectionEvent(projection, event)
    }
  }

  const entities = projection.entityIds.map(id => projection.entitiesById[id]!).filter(Boolean)
  return {
    legacy: { items: visibleLegacy(legacy), isProcessing: legacy.session.isProcessing === true },
    projection: { items: visibleProjection(projection), isProcessing: selectPiRuntimeState(entities).isProcessing },
  }
}

describe('Pi projection parity with legacy visible state', () => {
  it('matches final streamed assistant text and completed tool state', () => {
    const result = runParity([
      {
        legacy: { type: 'text_delta', sessionId: 'session-1', delta: 'Hel', turnId: 'turn-1' },
        projection: { type: 'text_delta', text: 'Hel', turnId: 'turn-1' },
      },
      {
        legacy: { type: 'text_delta', sessionId: 'session-1', delta: 'lo', turnId: 'turn-1' },
        projection: { type: 'text_delta', text: 'lo', turnId: 'turn-1' },
      },
      {
        legacy: { type: 'text_complete', sessionId: 'session-1', text: 'Hello', turnId: 'turn-1' },
        projection: { type: 'text_complete', text: 'Hello', turnId: 'turn-1' },
      },
      {
        legacy: { type: 'tool_start', sessionId: 'session-1', toolUseId: 'call-1', toolName: 'Read', toolInput: { path: 'a.ts' }, turnId: 'turn-1' },
        projection: { type: 'tool_start', toolUseId: 'call-1', toolName: 'Read', input: { path: 'a.ts' }, turnId: 'turn-1' },
      },
      {
        legacy: { type: 'tool_result', sessionId: 'session-1', toolUseId: 'call-1', toolName: 'Read', result: 'contents', isError: false, turnId: 'turn-1' },
        projection: { type: 'tool_result', toolUseId: 'call-1', toolName: 'Read', result: 'contents', isError: false, turnId: 'turn-1' },
      },
      {
        legacy: { type: 'complete', sessionId: 'session-1' },
        projection: { type: 'complete' },
      },
    ])
    expect(result.projection).toEqual(result.legacy)
  })

  it('matches orphan tool results and failed tool results', () => {
    const result = runParity([
      {
        legacy: { type: 'tool_result', sessionId: 'session-1', toolUseId: 'orphan', toolName: 'Read', result: 'ok', isError: false },
        projection: { type: 'tool_result', toolUseId: 'orphan', toolName: 'Read', result: 'ok', isError: false },
      },
      {
        legacy: { type: 'tool_start', sessionId: 'session-1', toolUseId: 'failed', toolName: 'Bash', toolInput: {} },
        projection: { type: 'tool_start', toolUseId: 'failed', toolName: 'Bash', input: {} },
      },
      {
        legacy: { type: 'tool_result', sessionId: 'session-1', toolUseId: 'failed', toolName: 'Bash', result: 'exit 1', isError: true },
        projection: { type: 'tool_result', toolUseId: 'failed', toolName: 'Bash', result: 'exit 1', isError: true },
      },
      {
        legacy: { type: 'complete', sessionId: 'session-1' },
        projection: { type: 'complete' },
      },
    ])
    expect(result.projection).toEqual(result.legacy)
  })

  it('matches completion fail-safe for a tool result that never arrives', () => {
    const result = runParity([
      {
        legacy: { type: 'tool_start', sessionId: 'session-1', toolUseId: 'pending', toolName: 'Write', toolInput: {} },
        projection: { type: 'tool_start', toolUseId: 'pending', toolName: 'Write', input: {} },
      },
      {
        legacy: { type: 'complete', sessionId: 'session-1' },
        projection: { type: 'complete' },
      },
    ])
    expect(result.projection).toEqual(result.legacy)
  })

  it('matches runtime error visibility, failed running tools, and stopped lifecycle', () => {
    const result = runParity([
      {
        legacy: { type: 'tool_start', sessionId: 'session-1', toolUseId: 'pending', toolName: 'Bash', toolInput: {} },
        projection: { type: 'tool_start', toolUseId: 'pending', toolName: 'Bash', input: {} },
      },
      {
        legacy: { type: 'error', sessionId: 'session-1', error: 'runtime failed' },
        projection: { type: 'error', message: 'runtime failed' },
      },
    ])
    expect(result.projection).toEqual(result.legacy)
  })
})
