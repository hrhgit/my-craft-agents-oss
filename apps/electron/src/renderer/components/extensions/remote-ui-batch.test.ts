import { describe, expect, it } from 'bun:test'
import type { Message } from '../../../shared/types'
import type { RemoteUIRequest } from './RemoteUIModal'
import {
  buildRemoteUIBatch,
  consumeRemoteUIBatchRequest,
  isRemoteUIBatchReplayScope,
  isRemoteUIBatchReplayStage,
  parseRemoteUIQuestionProgress,
  startRemoteUIBatchReplay,
  type RemoteUIBatchSubmission,
} from './remote-ui-batch'

const baseRequest = {
  type: 'remoteui_request',
  requestId: 'live-request-1',
  source: 'ask-user',
  sessionId: 'session-1',
  extensionId: 'ask-user',
  runtimeId: 'runtime-1',
} as const

function firstRequest(): RemoteUIRequest {
  return {
    ...baseRequest,
    kind: 'select',
    title: '[1/3] Choose a theme',
    message: 'Pick one.',
    options: [{ title: 'Light' }, { title: 'Dark' }],
    allowFreeform: true,
  }
}

const toolMessage: Message = {
  id: 'tool-message',
  role: 'tool',
  content: '',
  timestamp: 1,
  toolUseId: 'ask-call-1',
  toolName: 'ask_user',
  toolStatus: 'executing',
  toolInput: {
    questions: [
      { question: 'Choose a theme', context: 'Pick one.', options: [{ title: 'Light', description: 'Bright palette' }, { title: 'Dark', description: 'Dim palette' }] },
      { question: 'Choose tools', options: ['VS Code', 'Git'], allowMultiple: true },
      { question: 'Describe the issue' },
    ],
  },
}

describe('remote UI batch adapter', () => {
  it('parses progress without leaking it into the visible title', () => {
    expect(parseRemoteUIQuestionProgress('[2/3] Choose tools')).toEqual({
      current: 2,
      total: 3,
      title: 'Choose tools',
    })
    expect(parseRemoteUIQuestionProgress('Choose tools')).toBeNull()
  })

  it('builds a navigable batch only from the matching active ask-user tool', () => {
    const batch = buildRemoteUIBatch([toolMessage], firstRequest())

    expect(batch).toMatchObject({
      id: 'ask-call-1',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'ask-user',
    })
    expect(batch?.questions).toHaveLength(3)
    expect(batch?.questions[0]).toMatchObject({
      kind: 'select',
      title: 'Choose a theme',
      options: [{ title: 'Light', description: 'Bright palette' }, { title: 'Dark', description: 'Dim palette' }],
    })
    expect(batch?.questions[1]).toMatchObject({
      kind: 'select',
      title: 'Choose tools',
      allowMultiple: true,
      options: [{ title: 'VS Code' }, { title: 'Git' }],
    })
    expect(batch?.questions[2]).toMatchObject({ kind: 'editor', title: 'Describe the issue' })
    expect(buildRemoteUIBatch([toolMessage], { ...firstRequest(), title: '[2/3] Choose tools' })).toBeNull()
    expect(buildRemoteUIBatch([toolMessage], { ...firstRequest(), timeout: 30_000 })).toBeNull()
    expect(buildRemoteUIBatch([{ ...toolMessage, toolStatus: 'completed' }], firstRequest())).toBeNull()
    expect(buildRemoteUIBatch([toolMessage], { ...firstRequest(), extensionId: 'other-extension' })).toBeNull()
  })

  it('matches replay scope without treating other sessions or runtimes as failures', () => {
    const state = {
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'ask-user',
    }

    expect(isRemoteUIBatchReplayScope(state, firstRequest())).toBe(true)
    expect(isRemoteUIBatchReplayScope(state, { ...firstRequest(), sessionId: 'session-2' })).toBe(false)
    expect(isRemoteUIBatchReplayScope(state, { ...firstRequest(), runtimeId: 'runtime-2' })).toBe(false)
    expect(isRemoteUIBatchReplayScope(state, { ...firstRequest(), extensionId: 'other-extension' })).toBe(false)
  })

  it('distinguishes concurrent ask-user stages in the same session and runtime', () => {
    const questions = buildRemoteUIBatch([toolMessage], firstRequest())!.questions
    const selectRequest = firstRequest()
    if (selectRequest.kind !== 'select') throw new Error('Expected select fixture')
    const state = {
      batchId: 'ask-call-1',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'ask-user',
      answers: questions.map(question => ({
        question,
        result: question.kind === 'editor' ? { text: 'Text' } : { selections: [question.options[0]!.title] },
      })),
      questionIndex: 1,
      phase: 'primary' as const,
      seenRequestIds: [],
    }

    expect(isRemoteUIBatchReplayStage(state, {
      ...selectRequest,
      requestId: 'expected-stage',
      title: '[2/3] Choose tools',
      message: undefined,
      options: [{ title: 'VS Code' }, { title: 'Git' }],
      allowMultiple: true,
    })).toBe(true)
    expect(isRemoteUIBatchReplayStage(state, {
      ...selectRequest,
      requestId: 'concurrent-call',
      title: '[1/2] Another question',
    })).toBe(false)
  })

  it('replays selection, optional comment, multi-select and editor answers in exact RPC order', () => {
    const questions = buildRemoteUIBatch([toolMessage], firstRequest())!.questions
    questions[0] = { ...questions[0], allowComment: true } as (typeof questions)[number]
    const submission: RemoteUIBatchSubmission = {
      batchId: 'ask-call-1',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'ask-user',
      answers: [
        { question: questions[0]!, result: { selections: ['Dark'], comment: 'Use at night' } },
        { question: questions[1]!, result: { selections: ['VS Code', 'Git'] } },
        { question: questions[2]!, result: { text: 'Spacing is wrong' } },
      ],
    }

    const first = startRemoteUIBatchReplay(submission, firstRequest())
    expect(first?.payload).toEqual({ selections: ['Dark'] })
    expect(first?.nextState?.phase).toBe('comment_followup')

    const comment = consumeRemoteUIBatchRequest(first!.nextState!, {
      ...baseRequest,
      requestId: 'comment-1',
      kind: 'editor',
      title: '[1/3] Choose a theme',
      message: 'Pick one.\n\nSelected option:\n- Dark',
      placeholder: 'Optional comment (press Enter to skip)...',
    })
    expect(comment?.payload).toEqual({ text: 'Use at night' })
    expect(comment?.nextState?.questionIndex).toBe(1)

    const multiple = consumeRemoteUIBatchRequest(comment!.nextState!, {
      ...baseRequest,
      requestId: 'live-request-2',
      kind: 'select',
      title: '[2/3] Choose tools',
      options: [{ title: 'VS Code' }, { title: 'Git' }],
      allowMultiple: true,
    })
    expect(multiple?.payload).toEqual({ selections: ['VS Code', 'Git'] })

    const editor = consumeRemoteUIBatchRequest(multiple!.nextState!, {
      ...baseRequest,
      requestId: 'live-request-3',
      kind: 'editor',
      title: '[3/3] Describe the issue',
      placeholder: 'Type your answer...',
    })
    expect(editor?.payload).toEqual({ text: 'Spacing is wrong' })
    expect(editor?.nextState).toBeNull()
  })

  it('preserves single-select freeform semantics through the sentinel follow-up', () => {
    const questions = buildRemoteUIBatch([toolMessage], firstRequest())!.questions
    const submission: RemoteUIBatchSubmission = {
      batchId: 'ask-call-1',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'ask-user',
      answers: [
        { question: questions[0]!, result: { selections: [], freeformText: 'OLED mode' } },
        { question: questions[1]!, result: { selections: ['Git'] } },
        { question: questions[2]!, result: { text: 'No issue' } },
      ],
    }

    const select = startRemoteUIBatchReplay(submission, firstRequest())
    expect(select?.payload).toEqual({ selections: ['\u270f\uFE0F Write my own answer...'] })
    expect(select?.nextState?.phase).toBe('freeform_followup')

    const freeform = consumeRemoteUIBatchRequest(select!.nextState!, {
      ...baseRequest,
      requestId: 'freeform-1',
      kind: 'editor',
      title: '[1/3] Choose a theme',
      message: 'Pick one.',
      placeholder: 'Type your answer...',
    })
    expect(freeform?.payload).toEqual({ text: 'OLED mode' })
    expect(freeform?.nextState?.questionIndex).toBe(1)
  })

  it('fails closed for runtime, progress, prompt, placeholder and duplicate mismatches', () => {
    const questions = buildRemoteUIBatch([toolMessage], firstRequest())!.questions
    const submission: RemoteUIBatchSubmission = {
      batchId: 'ask-call-1',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'ask-user',
      answers: questions.map((question, index) => ({
        question,
        result: question.kind === 'editor' ? { text: 'Text' } : { selections: [question.options[index % question.options.length]!.title] },
      })),
    }
    const state = startRemoteUIBatchReplay(submission, firstRequest())!.nextState!
    const next: RemoteUIRequest = {
      ...baseRequest,
      requestId: 'next',
      kind: 'select',
      title: '[2/3] Choose tools',
      options: [{ title: 'VS Code' }, { title: 'Git' }],
      allowMultiple: true,
    }

    expect(consumeRemoteUIBatchRequest(state, { ...next, runtimeId: 'runtime-2' })).toBeNull()
    expect(consumeRemoteUIBatchRequest(state, { ...next, title: '[3/3] Choose tools' })).toBeNull()
    expect(consumeRemoteUIBatchRequest(state, { ...next, title: '[2/3] Different' })).toBeNull()
    expect(consumeRemoteUIBatchRequest({ ...state, seenRequestIds: ['next'] }, next)).toBeNull()
  })
})
