import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Check, PencilLine, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface RemoteUIOption {
  title: string
  description?: string
}

export interface RemoteUISelectRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'select'
  title: string
  message?: string
  options: RemoteUIOption[]
  allowMultiple?: boolean
  allowFreeform?: boolean
  allowComment?: boolean
  source: string
  sessionId: string
  extensionId: string
  runtimeId: string
  timeout?: number
}

export interface RemoteUIConfirmRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'confirm'
  title: string
  message: string
  source: string
  sessionId: string
  extensionId: string
  runtimeId: string
  timeout?: number
}

export interface RemoteUIEditorRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'editor'
  title: string
  message?: string
  prefill?: string
  placeholder?: string
  source: string
  sessionId: string
  extensionId: string
  runtimeId: string
  timeout?: number
}

export type RemoteUIRequest = RemoteUISelectRequest | RemoteUIConfirmRequest | RemoteUIEditorRequest

export interface RemoteUISelectResult {
  selections: string[]
  freeformText?: string
  comment?: string
}

export interface RemoteUIEditorResult {
  text: string
}

export interface RemoteUIConfirmResult {
  confirmed: boolean
}

export type RemoteUIResult = RemoteUISelectResult | RemoteUIConfirmResult | RemoteUIEditorResult
export type RemoteUICancelReason = 'cancelled'

export interface RemoteUIComposerProps {
  request: RemoteUIRequest
  onRespond: (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => void
}

export interface RemoteUIAnswerDraft {
  selections: string[]
  freeformText: string
  comment: string
  text: string
  confirmed?: boolean
}

type RemoteUIQuestion = RemoteUIRequest

export function isRemoteUICompositionKey(
  event: { nativeEvent: { isComposing?: boolean; keyCode?: number } },
  compositionActive: boolean,
): boolean {
  return compositionActive || Boolean(event.nativeEvent.isComposing) || event.nativeEvent.keyCode === 229
}

export function createRemoteUIAnswerDraft(question: RemoteUIQuestion): RemoteUIAnswerDraft {
  return {
    selections: [],
    freeformText: '',
    comment: '',
    text: question.kind === 'editor' && 'prefill' in question ? question.prefill ?? '' : '',
  }
}

export function selectRemoteUIOption(
  draft: RemoteUIAnswerDraft,
  title: string,
  allowMultiple: boolean,
): RemoteUIAnswerDraft {
  const selections = allowMultiple
    ? draft.selections.includes(title)
      ? draft.selections.filter(value => value !== title)
      : [...draft.selections, title]
    : [title]
  return { ...draft, selections, freeformText: '' }
}

export function setRemoteUIFreeform(
  draft: RemoteUIAnswerDraft,
  freeformText: string,
): RemoteUIAnswerDraft {
  return {
    ...draft,
    freeformText,
    ...(freeformText.trim() ? { selections: [] } : {}),
  }
}

export function remoteUIDraftResult(
  question: RemoteUIQuestion,
  draft: RemoteUIAnswerDraft,
): RemoteUIResult | null {
  if (question.kind === 'confirm') {
    return typeof draft.confirmed === 'boolean' ? { confirmed: draft.confirmed } : null
  }
  if (question.kind === 'editor') {
    const text = draft.text.trim()
    return text ? { text } : null
  }

  const freeformText = draft.freeformText.trim()
  if (freeformText) {
    return {
      selections: [],
      freeformText,
      ...(question.allowMultiple && draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
    }
  }
  if (draft.selections.length === 0) return null
  return {
    selections: draft.selections,
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
  }
}

function visibleSelectOptions(question: Extract<RemoteUIQuestion, { kind: 'select' }>): RemoteUIOption[] {
  return question.options
}

function questionMessage(question: RemoteUIQuestion): string | undefined {
  return 'message' in question ? question.message : undefined
}

export function RemoteUIComposer({
  request,
  onRespond,
}: RemoteUIComposerProps) {
  const { t } = useTranslation()
  const question = request
  const identity = request.requestId
  const [draft, setDraft] = useState<RemoteUIAnswerDraft>(() => createRemoteUIAnswerDraft(question))
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const compositionActiveRef = useRef(false)
  const displayTitle = question.title
  const result = remoteUIDraftResult(question, draft)
  const canSubmit = Boolean(result)

  useEffect(() => {
    setDraft(createRemoteUIAnswerDraft(question))
  }, [identity, question])

  useEffect(() => {
    if (question.kind !== 'editor') return
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [identity, question.kind])

  const updateDraft = (updater: (draft: RemoteUIAnswerDraft) => RemoteUIAnswerDraft) => {
    setDraft(updater)
  }

  const submit = () => {
    if (!canSubmit) return
    onRespond(result!)
  }

  const handleTextareaEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || isRemoteUICompositionKey(event, compositionActiveRef.current)) return
    event.preventDefault()
    const currentResult = remoteUIDraftResult(question, draft)
    if (!currentResult) return
    submit()
  }

  return (
    <section
      aria-label={displayTitle}
      className="overflow-hidden rounded-lg border border-border/70 bg-background shadow-middle"
      data-remote-ui-composer
    >
      <form
        onCompositionStart={() => { compositionActiveRef.current = true }}
        onCompositionEnd={() => { compositionActiveRef.current = false }}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !isRemoteUICompositionKey(event, compositionActiveRef.current)) {
            onRespond(null, 'cancelled')
          }
        }}
      >
        <header className="flex items-start gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={`remote-ui-title-${request.requestId}`} className="text-sm font-semibold leading-5 text-foreground">
              {displayTitle}
            </h2>
            {questionMessage(question) && (
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                {questionMessage(question)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onRespond(null, 'cancelled')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('remoteUI.skipQuestion')}
            title={t('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="max-h-[min(48vh,440px)] overflow-y-auto px-2.5 py-2">
          {question.kind === 'select' && (
            <SelectQuestion
              question={question}
              draft={draft}
              onChange={updateDraft}
              onTextareaEnter={handleTextareaEnter}
            />
          )}
          {question.kind === 'editor' && (
            <textarea
              ref={editorRef}
              data-mortise-semantic-id={`remote-ui.${request.requestId.replace(/[^A-Za-z0-9._:-]/g, '_')}.editor`}
              data-mortise-ui-interactions="shortcut clipboard ime rich-text"
              value={draft.text}
              onChange={event => updateDraft(draft => ({ ...draft, text: event.target.value }))}
              onKeyDown={handleTextareaEnter}
              rows={3}
              placeholder={question.placeholder ?? t('remoteUI.answerPlaceholder')}
              className="max-h-40 min-h-20 w-full resize-none rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/20 focus:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring/35"
              aria-label={t('remoteUI.answer')}
            />
          )}
          {question.kind === 'confirm' && (
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={displayTitle}>
              <button
                type="button"
                onClick={() => onRespond({ confirmed: false })}
                className="h-9 rounded-md border border-border/70 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => onRespond({ confirmed: true })}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-foreground text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Check className="h-4 w-4" />
                {t('common.ok')}
              </button>
            </div>
          )}
        </div>

        {question.kind !== 'confirm' && (
          <footer className="flex min-h-12 items-center justify-between gap-3 border-t border-border/60 px-3 py-2">
            <div />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:cursor-default disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={t('remoteUI.submitAnswer')}
                title={t('remoteUI.submitAnswer')}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </footer>
        )}
      </form>
    </section>
  )
}

function SelectQuestion({
  question,
  draft,
  onChange,
  onTextareaEnter,
}: {
  question: Extract<RemoteUIQuestion, { kind: 'select' }>
  draft: RemoteUIAnswerDraft
  onChange: (updater: (draft: RemoteUIAnswerDraft) => RemoteUIAnswerDraft) => void
  onTextareaEnter: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const { t } = useTranslation()
  const customAnswerRef = useRef<HTMLTextAreaElement>(null)
  const allowMultiple = Boolean(question.allowMultiple)
  const allowFreeform = Boolean(question.allowFreeform)
  const options = visibleSelectOptions(question)
  const customActive = Boolean(draft.freeformText.trim())
  const showComment = Boolean(question.allowComment) && (!customActive || allowMultiple)

  return (
    <div
      className="flex flex-col gap-1"
      role={allowMultiple ? 'group' : 'radiogroup'}
      aria-label={question.title}
    >
      {options.map((option, index) => {
        const selected = draft.selections.includes(option.title)
        return (
          <label
            key={`${option.title}-${index}`}
            data-remote-ui-option
            className={cn(
              'flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-md border px-2.5 py-2 text-left transition-colors',
              selected
                ? 'border-foreground/15 bg-muted/75'
                : 'border-transparent hover:border-border/70 hover:bg-muted/40',
              'focus-within:ring-2 focus-within:ring-ring/35',
            )}
          >
            <input
              type={allowMultiple ? 'checkbox' : 'radio'}
              name={allowMultiple ? undefined : `remote-ui-${question.title}`}
              checked={selected}
              onChange={() => onChange(current => selectRemoteUIOption(current, option.title, allowMultiple))}
              className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
              aria-label={option.title}
            />
            <span className="min-w-0 flex-1 text-sm leading-5">
              <span className="font-medium text-foreground">{option.title}</span>
              {option.description && (
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>
              )}
            </span>
          </label>
        )
      })}

      {allowFreeform && (
        <div
          data-remote-ui-custom-option
          data-remote-ui-freeform
          className={cn(
            'flex min-h-11 items-start gap-3 rounded-md border px-2.5 py-2 transition-colors focus-within:ring-2 focus-within:ring-ring/35',
            customActive ? 'border-foreground/15 bg-muted/75' : 'border-transparent hover:border-border/70 hover:bg-muted/40',
          )}
        >
          {allowMultiple ? (
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
              <PencilLine className="h-3.5 w-3.5" />
            </span>
          ) : (
            <input
              type="radio"
              name={`remote-ui-${question.title}`}
              checked={customActive}
              onChange={() => customAnswerRef.current?.focus()}
              className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
              aria-label={t('remoteUI.customAnswer')}
            />
          )}
          <textarea
            ref={customAnswerRef}
            value={draft.freeformText}
            onChange={event => onChange(current => setRemoteUIFreeform(current, event.target.value))}
            onKeyDown={onTextareaEnter}
            rows={1}
            placeholder={t('remoteUI.customAnswerPlaceholder')}
            className="max-h-28 min-h-5 flex-1 resize-none bg-transparent text-sm leading-5 outline-none placeholder:text-muted-foreground"
            aria-label={t('remoteUI.customAnswer')}
          />
        </div>
      )}

      {showComment && (
        <textarea
          value={draft.comment}
          onChange={event => onChange(current => ({ ...current, comment: event.target.value }))}
          onKeyDown={onTextareaEnter}
          rows={1}
          placeholder={t('remoteUI.commentPlaceholder')}
          className="mt-1 max-h-24 min-h-10 w-full resize-none rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/20 focus:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/35"
          aria-label={t('remoteUI.comment')}
        />
      )}
    </div>
  )
}
