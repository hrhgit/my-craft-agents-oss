import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ExtensionInteractionAnswerV1,
  ExtensionInteractionBridgeRequestV1,
  ExtensionInteractionFieldV1,
  ExtensionInteractionResponseV1,
} from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'

export type InteractionDraft =
  | { kind: 'confirm'; value: boolean }
  | { kind: 'choice'; selectedOptionIds: string[]; otherText: string; comment: string }
  | { kind: 'text'; value: string }

export interface ExtensionInteractionComposerProps {
  event: ExtensionInteractionBridgeRequestV1
  onRespond: (response: ExtensionInteractionResponseV1) => void
}

export function createInteractionDraft(field: ExtensionInteractionFieldV1): InteractionDraft {
  if (field.kind === 'confirm') return { kind: 'confirm', value: field.defaultValue ?? false }
  if (field.kind === 'text') return { kind: 'text', value: field.defaultValue ?? '' }
  return { kind: 'choice', selectedOptionIds: [], otherText: '', comment: '' }
}

export function interactionDraftAnswer(field: ExtensionInteractionFieldV1, draft: InteractionDraft): ExtensionInteractionAnswerV1 {
  if (field.kind === 'confirm' && draft.kind === 'confirm') return { fieldId: field.id, kind: 'confirm', value: draft.value }
  if (field.kind === 'text' && draft.kind === 'text') return { fieldId: field.id, kind: 'text', value: draft.value }
  if (field.kind === 'choice' && draft.kind === 'choice') {
    return {
      fieldId: field.id,
      kind: 'choice',
      selectedOptionIds: draft.selectedOptionIds,
      ...(draft.otherText.trim() ? { otherText: draft.otherText.trim() } : {}),
      ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
    }
  }
  throw new Error(`Interaction draft kind does not match field ${field.id}`)
}

export function isInteractionDraftValid(field: ExtensionInteractionFieldV1, draft: InteractionDraft): boolean {
  if (field.kind === 'confirm') return draft.kind === 'confirm'
  if (field.kind === 'text') {
    if (draft.kind !== 'text') return false
    const length = draft.value.length
    if (field.required && draft.value.trim().length === 0) return false
    return length >= (field.minLength ?? 0) && length <= (field.maxLength ?? Number.POSITIVE_INFINITY)
  }
  if (draft.kind !== 'choice') return false
  const selectionCount = draft.selectedOptionIds.length + (draft.otherText.trim() ? 1 : 0)
  const minimum = field.minSelections ?? (field.required ? 1 : 0)
  const maximum = field.maxSelections ?? (field.multiple ? Number.POSITIVE_INFINITY : 1)
  return selectionCount >= minimum && selectionCount <= maximum
}

export function selectInteractionOption(draft: InteractionDraft, optionId: string, multiple: boolean): InteractionDraft {
  if (draft.kind !== 'choice') return draft
  const selected = draft.selectedOptionIds.includes(optionId)
  const selectedOptionIds = multiple
    ? selected
      ? draft.selectedOptionIds.filter(id => id !== optionId)
      : [...draft.selectedOptionIds, optionId]
    : [optionId]
  return { ...draft, selectedOptionIds, ...(multiple ? {} : { otherText: '' }) }
}

export function setInteractionOtherText(draft: InteractionDraft, otherText: string, multiple: boolean): InteractionDraft {
  if (draft.kind !== 'choice') return draft
  return {
    ...draft,
    otherText,
    ...(!multiple && otherText.trim() ? { selectedOptionIds: [] } : {}),
  }
}

export function ExtensionInteractionComposer({ event, onRespond }: ExtensionInteractionComposerProps) {
  const { t } = useTranslation()
  const { request } = event
  const [drafts, setDrafts] = useState<Record<string, InteractionDraft>>(() => Object.fromEntries(
    request.fields.map(field => [field.id, createInteractionDraft(field)]),
  ))
  const compositionActiveRef = useRef(false)
  const canSubmit = useMemo(() => request.fields.every(field => {
    const draft = drafts[field.id]
    return draft ? isInteractionDraftValid(field, draft) : false
  }), [drafts, request.fields])

  useEffect(() => {
    setDrafts(Object.fromEntries(request.fields.map(field => [field.id, createInteractionDraft(field)])))
  }, [event.requestId, request.fields])

  const updateDraft = (fieldId: string, update: (draft: InteractionDraft) => InteractionDraft) => {
    setDrafts(current => ({ ...current, [fieldId]: update(current[fieldId]!) }))
  }

  const cancel = () => onRespond({ schemaVersion: 1, status: 'cancelled', reason: 'user' })
  const submit = () => {
    if (!canSubmit) return
    onRespond({
      schemaVersion: 1,
      status: 'submitted',
      answers: request.fields.map(field => interactionDraftAnswer(field, drafts[field.id]!)),
    })
  }

  return (
    <section
      aria-label={request.title ?? request.description ?? event.extensionId}
      className="overflow-hidden rounded-lg border border-border/70 bg-background shadow-middle"
      data-extension-interaction
    >
      <form
        onCompositionStart={() => { compositionActiveRef.current = true }}
        onCompositionEnd={() => { compositionActiveRef.current = false }}
        onSubmit={(formEvent) => { formEvent.preventDefault(); submit() }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Escape' && !compositionActiveRef.current && !keyEvent.nativeEvent.isComposing) cancel()
        }}
      >
        {(request.title || request.description) && (
          <header className="flex items-start gap-3 border-b border-border/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              {request.title && <h2 className="text-sm font-semibold leading-5 text-foreground">{request.title}</h2>}
              {request.description && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{request.description}</p>}
            </div>
            <button
              type="button"
              onClick={cancel}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={request.cancelLabel ?? t('common.cancel')}
              title={request.cancelLabel ?? t('common.cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
        )}

        <div className="max-h-[min(52vh,520px)] space-y-4 overflow-y-auto px-3 py-3">
          {request.fields.map(field => (
            <InteractionField
              key={field.id}
              field={field}
              draft={drafts[field.id] ?? createInteractionDraft(field)}
              onChange={update => updateDraft(field.id, update)}
            />
          ))}
        </div>

        <footer className="flex min-h-12 items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
          <button
            type="button"
            onClick={cancel}
            className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {request.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-8 min-w-8 items-center justify-center gap-2 rounded-md bg-foreground px-3 text-xs font-medium text-background transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:cursor-default disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <ArrowUp className="h-3.5 w-3.5" />
            <span>{request.submitLabel ?? t('remoteUI.submitAnswer')}</span>
          </button>
        </footer>
      </form>
    </section>
  )
}

function InteractionField({
  field,
  draft,
  onChange,
}: {
  field: ExtensionInteractionFieldV1
  draft: InteractionDraft
  onChange: (update: (draft: InteractionDraft) => InteractionDraft) => void
}) {
  return (
    <fieldset className="min-w-0" data-interaction-field={field.id}>
      {field.kind !== 'confirm' && (
        <>
          <legend className="text-sm font-medium leading-5 text-foreground">
            {field.label}
            {field.required && <span className="ml-1 text-destructive" aria-hidden="true">*</span>}
          </legend>
          {field.description && <p className="mt-0.5 whitespace-pre-wrap text-xs leading-4 text-muted-foreground">{field.description}</p>}
        </>
      )}

      {field.kind === 'confirm' && draft.kind === 'confirm' && (
        <label className="mt-2 flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-sm transition-colors hover:bg-muted/45 focus-within:ring-2 focus-within:ring-ring/35">
          <input
            type="checkbox"
            checked={draft.value}
            onChange={changeEvent => onChange(() => ({ kind: 'confirm', value: changeEvent.target.checked }))}
            className="h-4 w-4 shrink-0 accent-foreground"
          />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-foreground">{field.label}</span>
            {field.description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{field.description}</span>}
          </span>
        </label>
      )}

      {field.kind === 'choice' && draft.kind === 'choice' && (
        <div className="mt-2 flex flex-col gap-1" role={field.multiple ? 'group' : 'radiogroup'}>
          {field.options.map(option => {
            const selected = draft.selectedOptionIds.includes(option.id)
            return (
              <label
                key={option.id}
                className={cn(
                  'flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-2.5 py-2 transition-colors focus-within:ring-2 focus-within:ring-ring/35',
                  selected ? 'border-foreground/15 bg-muted/75' : 'border-transparent hover:border-border/70 hover:bg-muted/40',
                )}
              >
                <input
                  type={field.multiple ? 'checkbox' : 'radio'}
                  name={field.multiple ? undefined : `interaction-${field.id}`}
                  checked={selected}
                  onChange={() => onChange(current => selectInteractionOption(current, option.id, Boolean(field.multiple)))}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
                />
                <span className="min-w-0 flex-1 text-sm leading-5">
                  <span className="font-medium text-foreground">{option.label}</span>
                  {option.description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>}
                </span>
              </label>
            )
          })}
          {field.allowOther && (
            <textarea
              value={draft.otherText}
              onChange={changeEvent => onChange(current => setInteractionOtherText(current, changeEvent.target.value, Boolean(field.multiple)))}
              rows={1}
              placeholder={field.otherLabel}
              aria-label={field.otherLabel ?? field.label}
              className="mt-1 max-h-28 min-h-10 w-full resize-none rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35"
            />
          )}
          {field.allowComment && (
            <textarea
              value={draft.comment}
              onChange={changeEvent => onChange(current => current.kind === 'choice' ? { ...current, comment: changeEvent.target.value } : current)}
              rows={1}
              placeholder={field.commentLabel}
              aria-label={field.commentLabel ?? field.label}
              className="mt-1 max-h-24 min-h-10 w-full resize-none rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35"
            />
          )}
        </div>
      )}

      {field.kind === 'text' && draft.kind === 'text' && (
        field.multiline && !field.sensitive ? (
          <textarea
            aria-label={field.label}
            value={draft.value}
            onChange={changeEvent => onChange(() => ({ kind: 'text', value: changeEvent.target.value }))}
            rows={3}
            minLength={field.minLength}
            maxLength={field.maxLength}
            placeholder={field.placeholder}
            className="mt-2 max-h-40 min-h-20 w-full resize-none rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35"
          />
        ) : (
          <input
            aria-label={field.label}
            type={field.sensitive ? 'password' : 'text'}
            value={draft.value}
            onChange={changeEvent => onChange(() => ({ kind: 'text', value: changeEvent.target.value }))}
            minLength={field.minLength}
            maxLength={field.maxLength}
            placeholder={field.placeholder}
            className="mt-2 h-10 w-full rounded-md border border-border/70 bg-muted/35 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35"
          />
        )
      )}
    </fieldset>
  )
}
