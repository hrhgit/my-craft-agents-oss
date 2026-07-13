import type { Message } from '../../../shared/types'
import type {
  RemoteUIEditorResult,
  RemoteUIOption,
  RemoteUIRequest,
  RemoteUIResult,
  RemoteUISelectResult,
} from './RemoteUIModal'

const QUESTION_PROGRESS_PATTERN = /^\s*\[(\d+)\/(\d+)\]\s*/
const FREEFORM_SENTINEL = '\u270f\uFE0F Write my own answer...'
const ANSWER_PLACEHOLDER = 'Type your answer...'
const COMMENT_PLACEHOLDER = 'Optional comment (press Enter to skip)...'

export interface RemoteUIQuestionProgress {
  current: number
  total: number
  title: string
}

export type RemoteUIQuestionSpec =
  | {
      kind: 'select'
      title: string
      message?: string
      options: RemoteUIOption[]
      allowMultiple: boolean
      allowFreeform: boolean
      allowComment: boolean
    }
  | {
      kind: 'editor'
      title: string
      message?: string
      placeholder?: string
    }

export interface RemoteUIBatch {
  id: string
  sessionId: string
  runtimeId: string
  extensionId: string
  questions: RemoteUIQuestionSpec[]
}

export interface RemoteUIBatchAnswer {
  question: RemoteUIQuestionSpec
  result: RemoteUIResult
}

export interface RemoteUIBatchSubmission {
  batchId: string
  sessionId: string
  runtimeId: string
  extensionId: string
  answers: RemoteUIBatchAnswer[]
}

export interface RemoteUIBatchReplayState extends RemoteUIBatchSubmission {
  questionIndex: number
  phase: 'primary' | 'freeform_followup' | 'comment_followup'
  seenRequestIds: string[]
}

export interface RemoteUIBatchReplayStep {
  payload: RemoteUIResult
  nextState: RemoteUIBatchReplayState | null
}

interface AskUserQuestionInput {
  question: string
  context?: string
  options: Array<string | RemoteUIOption>
  allowMultiple: boolean
  allowComment: boolean
}

export function parseRemoteUIQuestionProgress(title: string): RemoteUIQuestionProgress | null {
  const match = QUESTION_PROGRESS_PATTERN.exec(title)
  if (!match) return null

  const current = Number(match[1])
  const total = Number(match[2])
  if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || total < 1 || current > total) {
    return null
  }

  return {
    current,
    total,
    title: title.slice(match[0].length).trim(),
  }
}

export function isRemoteUIBatchReplayScope(
  state: Pick<RemoteUIBatchReplayState, 'sessionId' | 'runtimeId' | 'extensionId'>,
  request: RemoteUIRequest,
): boolean {
  return request.sessionId === state.sessionId
    && request.runtimeId === state.runtimeId
    && isAskUserName(request.extensionId)
    && isAskUserName(state.extensionId)
}

export function isRemoteUIBatchReplayStage(
  state: Pick<RemoteUIBatchReplayState, 'sessionId' | 'runtimeId' | 'extensionId' | 'questionIndex' | 'answers'>,
  request: RemoteUIRequest,
): boolean {
  if (!isRemoteUIBatchReplayScope(state, request)) return false
  const progress = parseRemoteUIQuestionProgress(request.title)
  return progress?.current === state.questionIndex + 1 && progress.total === state.answers.length
}

function isAskUserName(value: string | undefined): boolean {
  return value?.trim().toLowerCase().replaceAll('-', '_') === 'ask_user'
}

function normalizeQuestionInput(value: unknown): AskUserQuestionInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (typeof input.question !== 'string' || !input.question.trim()) return null

  const options: AskUserQuestionInput['options'] = []
  if (Array.isArray(input.options)) {
    for (const option of input.options) {
      if (typeof option === 'string' && option.trim()) {
        options.push(option.trim())
        continue
      }
      if (!option || typeof option !== 'object') continue
      const record = option as Record<string, unknown>
      if (typeof record.title !== 'string' || !record.title.trim()) continue
      options.push({
        title: record.title.trim(),
        ...(typeof record.description === 'string' && record.description.trim()
          ? { description: record.description.trim() }
          : {}),
      })
    }
  }

  return {
    question: input.question.trim(),
    ...(typeof input.context === 'string' && input.context.trim() ? { context: input.context.trim() } : {}),
    options,
    allowMultiple: input.allowMultiple === true,
    allowComment: input.allowComment === true,
  }
}

function findMatchingAskUserTool(
  messages: Message[],
  progress: RemoteUIQuestionProgress,
): { id: string; questions: AskUserQuestionInput[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message.role !== 'tool'
      || message.toolStatus !== 'executing'
      || !isAskUserName(message.toolName)
    ) continue

    const rawQuestions = message.toolInput?.questions
    if (!Array.isArray(rawQuestions) || rawQuestions.length !== progress.total) continue
    const questions = rawQuestions.map(normalizeQuestionInput)
    if (questions.some(question => question === null)) continue
    const normalized = questions as AskUserQuestionInput[]
    if (normalized[progress.current - 1]?.question !== progress.title) continue

    return {
      id: message.toolUseId || message.id,
      questions: normalized,
    }
  }
  return null
}

export function buildRemoteUIBatch(messages: Message[], request: RemoteUIRequest | null): RemoteUIBatch | null {
  if (!request || !isAskUserName(request.extensionId)) return null
  // Pi enforces dialog timeouts outside the renderer. Holding the first timed
  // request while editing a whole batch would let the backend expire first.
  if (request.timeout && request.timeout > 0) return null
  const progress = parseRemoteUIQuestionProgress(request.title)
  if (!progress || progress.current !== 1 || progress.total < 2) return null

  const tool = findMatchingAskUserTool(messages, progress)
  if (!tool) return null

  const questions = tool.questions.map<RemoteUIQuestionSpec>((question) => {
    if (question.options.length === 0) {
      return {
        kind: 'editor',
        title: question.question,
        message: question.context,
        placeholder: ANSWER_PLACEHOLDER,
      }
    }
    return {
      kind: 'select',
      title: question.question,
      message: question.context,
      options: question.options.map(option => typeof option === 'string' ? { title: option } : option),
      allowMultiple: question.allowMultiple,
      allowFreeform: true,
      allowComment: question.allowComment,
    }
  })

  return {
    id: tool.id,
    sessionId: request.sessionId,
    runtimeId: request.runtimeId,
    extensionId: request.extensionId,
    questions,
  }
}

function selectResult(result: RemoteUIResult): RemoteUISelectResult | null {
  return 'selections' in result ? result : null
}

function editorResult(result: RemoteUIResult): RemoteUIEditorResult | null {
  return 'text' in result ? result : null
}

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n').trim()
}

function displayQuestion(question: RemoteUIQuestionSpec, index: number, total: number): string {
  return `[${index + 1}/${total}] ${question.title}`
}

function questionPrompt(question: RemoteUIQuestionSpec, index: number, total: number): string {
  const title = displayQuestion(question, index, total)
  return question.message ? `${title}\n\nContext:\n${question.message}` : title
}

function requestPrompt(request: RemoteUIRequest): string {
  const message = 'message' in request ? request.message : undefined
  return message ? `${request.title}\n\nContext:\n${message}` : request.title
}

function effectiveSelections(result: RemoteUISelectResult): string[] {
  const freeform = result.freeformText?.trim()
  return freeform ? [freeform] : result.selections
}

function commentPrompt(
  question: RemoteUIQuestionSpec,
  result: RemoteUISelectResult,
  index: number,
  total: number,
): string {
  const selections = effectiveSelections(result)
  const label = selections.length === 1 ? 'Selected option' : 'Selected options'
  return `${questionPrompt(question, index, total)}\n\n${label}:\n${selections.map(value => `- ${value}`).join('\n')}`
}

function optionsMatch(request: RemoteUIRequest, question: RemoteUIQuestionSpec): boolean {
  if (request.kind !== 'select' || question.kind !== 'select') return false
  if (Boolean(request.allowMultiple) !== question.allowMultiple) return false
  if (request.options.length !== question.options.length) return false
  // Pi's select transport carries option titles only. Descriptions can still
  // be recovered from ask_user.toolInput for display, but are not replay keys.
  return request.options.every((option, index) => option.title === question.options[index]?.title)
}

function requestMatchesReplay(
  state: RemoteUIBatchReplayState,
  request: RemoteUIRequest,
  question: RemoteUIQuestionSpec,
): boolean {
  if (
    !isRemoteUIBatchReplayScope(state, request)
    || state.seenRequestIds.includes(request.requestId)
  ) return false

  const progress = parseRemoteUIQuestionProgress(request.title)
  if (
    !progress
    || progress.current !== state.questionIndex + 1
    || progress.total !== state.answers.length
  ) return false

  const expectedPrompt = state.phase === 'comment_followup'
    ? commentPrompt(question, selectResult(state.answers[state.questionIndex]!.result)!, state.questionIndex, state.answers.length)
    : questionPrompt(question, state.questionIndex, state.answers.length)

  if (normalizeNewlines(requestPrompt(request)) !== normalizeNewlines(expectedPrompt)) return false

  if (state.phase === 'freeform_followup') {
    return request.kind === 'editor' && request.placeholder === ANSWER_PLACEHOLDER
  }
  if (state.phase === 'comment_followup') {
    return request.kind === 'editor' && request.placeholder === COMMENT_PLACEHOLDER
  }
  if (question.kind === 'editor') {
    return request.kind === 'editor' && request.placeholder === ANSWER_PLACEHOLDER
  }
  return optionsMatch(request, question)
}

function markSeen(state: RemoteUIBatchReplayState, requestId: string): RemoteUIBatchReplayState {
  return { ...state, seenRequestIds: [...state.seenRequestIds, requestId] }
}

function advanceReplayState(state: RemoteUIBatchReplayState): RemoteUIBatchReplayState | null {
  const questionIndex = state.questionIndex + 1
  if (questionIndex >= state.answers.length) return null
  return { ...state, questionIndex, phase: 'primary' }
}

export function consumeRemoteUIBatchRequest(
  state: RemoteUIBatchReplayState,
  request: RemoteUIRequest,
): RemoteUIBatchReplayStep | null {
  const answer = state.answers[state.questionIndex]
  if (!answer || !requestMatchesReplay(state, request, answer.question)) return null
  const seenState = markSeen(state, request.requestId)
  const selected = selectResult(answer.result)

  if (state.phase === 'freeform_followup') {
    const value = selected?.freeformText?.trim()
    if (!value) return null
    return { payload: { text: value }, nextState: advanceReplayState(seenState) }
  }

  if (state.phase === 'comment_followup') {
    if (!selected) return null
    return {
      payload: { text: selected.comment ?? '' },
      nextState: advanceReplayState(seenState),
    }
  }

  const editor = editorResult(answer.result)
  if (answer.question.kind === 'editor') {
    if (!editor) return null
    return { payload: { text: editor.text }, nextState: advanceReplayState(seenState) }
  }

  if (!selected) return null
  const freeform = selected.freeformText?.trim()
  if (freeform && !answer.question.allowMultiple) {
    return {
      payload: { selections: [FREEFORM_SENTINEL] },
      nextState: { ...seenState, phase: 'freeform_followup' },
    }
  }

  const selections = freeform ? [freeform] : selected.selections
  return {
    payload: { selections },
    nextState: answer.question.allowComment
      ? { ...seenState, phase: 'comment_followup' }
      : advanceReplayState(seenState),
  }
}

export function startRemoteUIBatchReplay(
  submission: RemoteUIBatchSubmission,
  request: RemoteUIRequest,
): RemoteUIBatchReplayStep | null {
  if (submission.answers.length < 2) return null
  return consumeRemoteUIBatchRequest({
    ...submission,
    questionIndex: 0,
    phase: 'primary',
    seenRequestIds: [],
  }, request)
}
