import { useEffect, useRef, useState } from 'react'
import { Check, Send, X } from 'lucide-react'
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

export function RemoteUIComposer({ request, onRespond }: RemoteUIComposerProps) {
  return (
    <section
      aria-label={request.title}
      className="overflow-hidden rounded-[12px] bg-background shadow-middle"
      data-remote-ui-composer
    >
      {request.kind === 'select' && <SelectComposer request={request} onRespond={onRespond} />}
      {request.kind === 'confirm' && <ConfirmComposer request={request} onRespond={onRespond} />}
      {request.kind === 'editor' && <EditorComposer request={request} onRespond={onRespond} />}
    </section>
  )
}

function ComposerHeader({ title, message, onSkip }: { title: string; message?: string; onSkip: () => void }) {
  return (
    <div className="flex items-start gap-3 px-3.5 pb-2 pt-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium leading-5 text-foreground">{title}</h2>
        {message && <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{message}</p>}
      </div>
      <button
        type="button"
        onClick={onSkip}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Skip question"
        title="Skip"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function SelectComposer({ request, onRespond }: { request: RemoteUISelectRequest; onRespond: RemoteUIComposerProps['onRespond'] }) {
  const { options = [], allowMultiple = false, allowComment = false } = request
  // ask_user guarantees a direct freeform answer for every question. Older RPC
  // fallbacks also include a synthetic "Write my own answer" option, which the
  // inline composer replaces with the text field below.
  const allowFreeform = request.allowFreeform || request.extensionId === 'ask_user'
  const visibleOptions = options.filter(option =>
    request.extensionId !== 'ask_user' || !/write my own answer/i.test(option.title),
  )
  const [selected, setSelected] = useState<string[]>([])
  const [freeformText, setFreeformText] = useState('')
  const [comment, setComment] = useState('')
  const freeformRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setSelected([])
    setFreeformText('')
    setComment('')
  }, [request.requestId])

  const submitSelections = (selections = selected) => {
    if (selections.length === 0) return
    onRespond({
      selections,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    })
  }

  const chooseOption = (title: string) => {
    if (!allowMultiple && !allowComment) {
      submitSelections([title])
      return
    }
    setSelected(previous => {
      if (!allowMultiple) return previous.includes(title) ? [] : [title]
      return previous.includes(title)
        ? previous.filter(value => value !== title)
        : [...previous, title]
    })
  }

  const submitFreeform = () => {
    const value = freeformText.trim()
    if (!value) return
    onRespond({
      selections: [],
      freeformText: value,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    })
  }

  return (
    <div onKeyDown={(event) => {
      if (event.key === 'Escape') onRespond(null, 'cancelled')
    }}>
      <ComposerHeader title={request.title} message={request.message} onSkip={() => onRespond(null, 'cancelled')} />

      <div className="max-h-[min(46vh,420px)] overflow-y-auto px-2 pb-1">
        <div className="flex flex-col gap-1">
          {visibleOptions.map((option, index) => {
            const isSelected = selected.includes(option.title)
            const optionContent = (
              <span className="min-w-0 flex-1 text-sm leading-5">
                <span className="font-medium text-foreground">{option.title}</span>
                {option.description && <span className="ml-2 text-muted-foreground">{option.description}</span>}
              </span>
            )

            if (allowMultiple) {
              return (
                <label
                  key={`${option.title}-${index}`}
                  data-remote-ui-option
                  className={cn(
                    'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    isSelected ? 'bg-muted' : 'hover:bg-muted/70',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => chooseOption(option.title)}
                    className="h-4 w-4 shrink-0 accent-foreground"
                    aria-label={`Select ${option.title}`}
                  />
                  {optionContent}
                </label>
              )
            }

            return (
              <button
                key={`${option.title}-${index}`}
                type="button"
                data-remote-ui-option
                onClick={() => chooseOption(option.title)}
                className={cn(
                  'flex min-h-11 w-full items-center rounded-md px-2 py-1.5 text-left transition-colors',
                  isSelected ? 'bg-muted' : 'hover:bg-muted/70',
                )}
              >
                {optionContent}
              </button>
            )
          })}
        </div>

        {allowFreeform && (
          <div data-remote-ui-freeform className="mt-1 flex items-end gap-2 rounded-md px-2 py-1.5 focus-within:bg-muted/60">
            <textarea
              ref={freeformRef}
              value={freeformText}
              onChange={event => setFreeformText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submitFreeform()
                }
              }}
              rows={1}
              placeholder="Type your own answer..."
              className="max-h-28 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground"
              aria-label="Custom answer"
            />
            <button
              type="button"
              onClick={submitFreeform}
              disabled={!freeformText.trim()}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-30"
              aria-label="Send custom answer"
              title="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {allowComment && (
          <textarea
            value={comment}
            onChange={event => setComment(event.target.value)}
            rows={1}
            placeholder="Additional comment (optional)"
            className="mt-1 max-h-24 min-h-8 w-full resize-none rounded-md bg-muted/50 px-3 py-1.5 text-xs leading-5 outline-none placeholder:text-muted-foreground focus:bg-muted"
            aria-label="Additional comment"
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-3 pb-3 pt-1.5">
        {(allowMultiple || allowComment) && (
          <button
            type="button"
            onClick={() => submitSelections()}
            disabled={selected.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:opacity-30"
          >
            <Check className="h-3.5 w-3.5" />
            Confirm
          </button>
        )}
        <button
          type="button"
          onClick={() => onRespond(null, 'cancelled')}
          className="h-8 rounded-md border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

function ConfirmComposer({ request, onRespond }: { request: RemoteUIConfirmRequest; onRespond: RemoteUIComposerProps['onRespond'] }) {
  return (
    <div>
      <ComposerHeader title={request.title} message={request.message} onSkip={() => onRespond(null, 'cancelled')} />
      <div className="flex justify-end gap-2 px-3 pb-3">
        <button type="button" onClick={() => onRespond({ confirmed: false })} className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted">Cancel</button>
        <button type="button" onClick={() => onRespond({ confirmed: true })} className="h-8 rounded-md bg-foreground px-3 text-xs font-medium text-background">Confirm</button>
      </div>
    </div>
  )
}

function EditorComposer({ request, onRespond }: { request: RemoteUIEditorRequest; onRespond: RemoteUIComposerProps['onRespond'] }) {
  const [text, setText] = useState(request.prefill ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText(request.prefill ?? '')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [request.requestId, request.prefill])

  const submit = () => {
    const value = text.trim()
    if (value) onRespond({ text: value })
  }

  return (
    <div onKeyDown={event => {
      if (event.key === 'Escape') onRespond(null, 'cancelled')
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
      }
    }}>
      <ComposerHeader title={request.title} onSkip={() => onRespond(null, 'cancelled')} />
      <div className="flex items-end gap-2 px-3 pb-3">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={event => setText(event.target.value)}
          rows={2}
          placeholder={request.placeholder ?? 'Type your answer...'}
          className="max-h-40 min-h-16 flex-1 resize-none rounded-md bg-muted/60 px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus:bg-muted"
          aria-label="Answer"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-30"
          aria-label="Send answer"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/** @deprecated Remote UI is now rendered inline in the chat composer. */
export const RemoteUIModal = RemoteUIComposer
