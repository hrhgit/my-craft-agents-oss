import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, Check, ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ExtensionInteractionAnswerV1,
  ExtensionInteractionBridgeRequestV1,
  ExtensionInteractionFieldV1,
  ExtensionInteractionResponseV1,
} from '@mortise/shared/protocol'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export type InteractionDraft =
  | { kind: 'confirm'; value: boolean }
  | { kind: 'choice'; selectedOptionIds: string[]; otherText: string; comment: string }
  | { kind: 'text'; value: string }

export interface ExtensionInteractionComposerProps {
  event: ExtensionInteractionBridgeRequestV1
  onRespond: (response: ExtensionInteractionResponseV1) => void
}

function interactionSemanticPart(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return value
  const readable = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'item'
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${readable}.${(hash >>> 0).toString(36)}`
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

export function skippedInteractionAnswer(field: ExtensionInteractionFieldV1): ExtensionInteractionAnswerV1 {
  if (field.kind === 'confirm') return { fieldId: field.id, kind: 'confirm', value: false }
  if (field.kind === 'text') return { fieldId: field.id, kind: 'text', value: '' }
  return { fieldId: field.id, kind: 'choice', selectedOptionIds: [] }
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

export function shouldAutoAdvanceChoice(
  field: ExtensionInteractionFieldV1,
  isLast: boolean,
  enabled: boolean,
): boolean {
  return enabled && !isLast && field.kind === 'choice' && !field.multiple && !field.allowComment
}

export function shouldCancelInteraction(key: string, isComposing: boolean, compositionActive: boolean): boolean {
  return key === 'Escape' && !isComposing && !compositionActive
}

export function ExtensionInteractionComposer({ event, onRespond }: ExtensionInteractionComposerProps) {
  const { t } = useTranslation()
  const { request } = event
  const isWizard = request.presentation?.mode === 'wizard'
  const [drafts, setDrafts] = useState<Record<string, InteractionDraft>>(() => Object.fromEntries(
    request.fields.map(field => [field.id, createInteractionDraft(field)]),
  ))
  const [skipped, setSkipped] = useState<Record<string, boolean>>({})
  const [currentStep, setCurrentStep] = useState(0)
  const compositionActiveRef = useRef(false)
  const activeField = request.fields[Math.min(currentStep, request.fields.length - 1)]!
  const activeDraft = drafts[activeField.id] ?? createInteractionDraft(activeField)
  const canSubmit = useMemo(() => request.fields.every(field => {
    if (isWizard && skipped[field.id]) return true
    const draft = drafts[field.id]
    return draft ? isInteractionDraftValid(field, draft) : false
  }), [drafts, isWizard, request.fields, skipped])

  useEffect(() => {
    setDrafts(Object.fromEntries(request.fields.map(field => [field.id, createInteractionDraft(field)])))
    setSkipped({})
    setCurrentStep(0)
  }, [event.requestId, request.fields])

  const updateDraft = (fieldId: string, update: (draft: InteractionDraft) => InteractionDraft) => {
    setSkipped(current => current[fieldId] ? { ...current, [fieldId]: false } : current)
    setDrafts(current => ({ ...current, [fieldId]: update(current[fieldId]!) }))
  }

  const cancel = () => onRespond({ schemaVersion: 1, status: 'cancelled', reason: 'user' })
  const submit = () => {
    if (!canSubmit) return
    onRespond({
      schemaVersion: 1,
      status: 'submitted',
      answers: request.fields.map(field => skipped[field.id]
        ? skippedInteractionAnswer(field)
        : interactionDraftAnswer(field, drafts[field.id]!)),
    })
  }
  const goToStep = (nextStep: number) => setCurrentStep(Math.max(0, Math.min(request.fields.length - 1, nextStep)))
  const skipCurrent = () => {
    setSkipped(current => ({ ...current, [activeField.id]: true }))
    if (currentStep < request.fields.length - 1) goToStep(currentStep + 1)
  }

  return (
    <section
      aria-label={request.title ?? request.description ?? event.extensionId}
      className="overflow-hidden rounded-lg border border-border/70 bg-background shadow-middle"
      data-extension-interaction
      data-extension-interaction-mode={isWizard ? 'wizard' : 'form'}
      data-mortise-semantic-id="extension.interaction"
    >
      <form
        onCompositionStart={() => { compositionActiveRef.current = true }}
        onCompositionEnd={() => { compositionActiveRef.current = false }}
        onSubmit={(formEvent) => { formEvent.preventDefault(); submit() }}
        onKeyDown={(keyEvent) => {
          if (shouldCancelInteraction(keyEvent.key, keyEvent.nativeEvent.isComposing, compositionActiveRef.current)) cancel()
        }}
      >
        {isWizard ? (
          <WizardHeader
            currentStep={currentStep}
            totalSteps={request.fields.length}
            onPrevious={() => goToStep(currentStep - 1)}
            onNext={() => goToStep(currentStep + 1)}
            onCancel={cancel}
          />
        ) : (request.title || request.description) && (
          <header className="flex items-start gap-3 border-b border-border/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              {request.title && <h2 className="text-sm font-semibold leading-5 text-foreground">{request.title}</h2>}
              {request.description && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{request.description}</p>}
            </div>
            <CloseButton label={request.cancelLabel ?? t('common.cancel')} onClick={cancel} />
          </header>
        )}

        <div className={cn('overflow-y-auto px-3 py-3', isWizard ? 'max-h-[min(58vh,560px)]' : 'max-h-[min(52vh,520px)] space-y-4')}>
          {isWizard ? (
            <WizardField
              key={activeField.id}
              field={activeField}
              semanticId={`extension.interaction.field.${interactionSemanticPart(activeField.id)}`}
              draft={activeDraft}
              skipped={Boolean(skipped[activeField.id])}
              isLast={currentStep === request.fields.length - 1}
              autoAdvance={request.presentation?.autoAdvanceSingleChoice === true}
              onChange={update => updateDraft(activeField.id, update)}
              onAutoAdvance={() => goToStep(currentStep + 1)}
            />
          ) : request.fields.map(field => (
            <InteractionField
              key={field.id}
              field={field}
              semanticId={`extension.interaction.field.${interactionSemanticPart(field.id)}`}
              draft={drafts[field.id] ?? createInteractionDraft(field)}
              onChange={update => updateDraft(field.id, update)}
            />
          ))}
        </div>

        {isWizard ? (
          <WizardFooter
            currentStep={currentStep}
            totalSteps={request.fields.length}
            allowSkip={request.presentation?.allowSkip === true}
            canContinue={Boolean(skipped[activeField.id]) || isInteractionDraftValid(activeField, activeDraft)}
            canSubmit={canSubmit}
            onPrevious={() => goToStep(currentStep - 1)}
            onNext={() => goToStep(currentStep + 1)}
            onSkip={skipCurrent}
          />
        ) : (
          <footer className="flex min-h-12 items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
            <button type="button" onClick={cancel} data-mortise-semantic-id="extension.interaction.cancel.footer" className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {request.cancelLabel ?? t('common.cancel')}
            </button>
            <SubmitButton label={request.submitLabel ?? t('extensionInteraction.submitAnswer')} disabled={!canSubmit} />
          </footer>
        )}
      </form>
    </section>
  )
}

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-mortise-semantic-id="extension.interaction.cancel.header" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={label} title={label}>
      <X className="h-3.5 w-3.5" />
    </button>
  )
}

function WizardHeader({ currentStep, totalSteps, onPrevious, onNext, onCancel }: { currentStep: number; totalSteps: number; onPrevious: () => void; onNext: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  return (
    <header className="flex min-h-11 items-center justify-end border-b border-border/60 px-3 py-2">
      {totalSteps > 1 && (
        <nav aria-label={t('extensionInteraction.questionNavigation')} className="mr-1 flex items-center gap-1">
          <button type="button" onClick={onPrevious} disabled={currentStep === 0} data-mortise-semantic-id="extension.interaction.previous" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25" aria-label={t('extensionInteraction.previousQuestion')} title={t('extensionInteraction.previousQuestion')}><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">{currentStep + 1} / {totalSteps}</span>
          <button type="button" onClick={onNext} disabled={currentStep === totalSteps - 1} data-mortise-semantic-id="extension.interaction.next" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25" aria-label={t('extensionInteraction.nextQuestion')} title={t('extensionInteraction.nextQuestion')}><ChevronRight className="h-4 w-4" /></button>
        </nav>
      )}
      <CloseButton label={t('common.cancel')} onClick={onCancel} />
    </header>
  )
}

function WizardFooter({ currentStep, totalSteps, allowSkip, canContinue, canSubmit, onPrevious, onNext, onSkip }: { currentStep: number; totalSteps: number; allowSkip: boolean; canContinue: boolean; canSubmit: boolean; onPrevious: () => void; onNext: () => void; onSkip: () => void }) {
  const { t } = useTranslation()
  const isLast = currentStep === totalSteps - 1
  return (
    <footer className="flex min-h-12 items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
      <div>{allowSkip && <button type="button" onClick={onSkip} data-mortise-semantic-id="extension.interaction.skip" className="h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('extensionInteraction.skip')}</button>}</div>
      <div className="flex items-center gap-2">
        {totalSteps > 1 && currentStep > 0 && <button type="button" onClick={onPrevious} className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronLeft className="h-3.5 w-3.5" />{t('extensionInteraction.previous')}</button>}
        {!isLast ? <button type="button" onClick={onNext} disabled={!canContinue} className="inline-flex h-8 items-center gap-1 rounded-md bg-foreground px-3 text-xs font-medium text-background hover:opacity-90 disabled:cursor-default disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">{t('extensionInteraction.next')}<ChevronRight className="h-3.5 w-3.5" /></button> : <SubmitButton label={t('extensionInteraction.submitAnswer')} disabled={!canSubmit} />}
      </div>
    </footer>
  )
}

function SubmitButton({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <button type="submit" disabled={disabled} data-mortise-semantic-id="extension.interaction.submit" className="inline-flex h-8 min-w-8 items-center justify-center gap-2 rounded-md bg-foreground px-3 text-xs font-medium text-background transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:cursor-default disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      <ArrowUp className="h-3.5 w-3.5" /><span>{label}</span>
    </button>
  )
}

function WizardField({ field, semanticId, draft, skipped, isLast, autoAdvance, onChange, onAutoAdvance }: { field: ExtensionInteractionFieldV1; semanticId: string; draft: InteractionDraft; skipped: boolean; isLast: boolean; autoAdvance: boolean; onChange: (update: (draft: InteractionDraft) => InteractionDraft) => void; onAutoAdvance: () => void }) {
  const { t } = useTranslation()
  const fieldsetRef = useRef<HTMLFieldSetElement>(null)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      fieldsetRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [field.id])
  const selectOption = (optionId: string) => {
    onChange(current => selectInteractionOption(current, optionId, Boolean(field.kind === 'choice' && field.multiple)))
    if (shouldAutoAdvanceChoice(field, isLast, autoAdvance)) window.setTimeout(onAutoAdvance, 120)
  }
  return (
    <fieldset ref={fieldsetRef} className="min-w-0" data-interaction-field={field.id} data-interaction-skipped={skipped || undefined} data-mortise-semantic-id={semanticId}>
      <legend className="max-w-3xl text-[15px] font-semibold leading-6 text-foreground">{field.label}</legend>
      {field.description && <p className="mt-1 max-w-3xl whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{field.description}</p>}
      {skipped && <p className="mt-2 text-xs font-medium text-muted-foreground" role="status">{t('extensionInteraction.skipped')}</p>}
      {field.kind === 'choice' && draft.kind === 'choice' && (
        <div className="mt-3 flex flex-col gap-1.5" role={field.multiple ? 'group' : 'radiogroup'}>
          {field.options.map((option, index) => {
            const selected = draft.selectedOptionIds.includes(option.id)
            return <label key={option.id} className={cn('group flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring/35', selected ? 'border-foreground/25 bg-muted/80' : 'border-border/60 hover:border-border hover:bg-muted/40')}>
              <input type={field.multiple ? 'checkbox' : 'radio'} data-mortise-semantic-id={`${semanticId}.option.${interactionSemanticPart(option.id)}`} name={field.multiple ? undefined : `interaction-${field.id}`} checked={selected} onChange={() => selectOption(option.id)} className="peer sr-only" />
              <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums', selected ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground')}>{index + 1}</span>
              <span className="min-w-0 flex-1 text-sm leading-5"><span className="font-medium text-foreground">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>}</span>
              {field.multiple ? <span data-choice-indicator="checkbox" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-transparent transition-colors peer-checked:border-black peer-checked:bg-black peer-checked:text-white"><Check className="h-3.5 w-3.5" aria-hidden="true" /></span> : selected && (isLast ? <Check className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" /> : <ArrowRight className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />)}
            </label>
          })}
          <label className={cn('flex min-h-12 cursor-text items-center gap-3 rounded-md border px-3 py-2 transition-colors focus-within:ring-2 focus-within:ring-ring/35', draft.otherText.trim() ? 'border-foreground/25 bg-muted/80' : 'border-border/60 hover:border-border hover:bg-muted/40')}>
            <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Input semanticId={`${semanticId}.other`} value={draft.otherText} onChange={event => onChange(current => setInteractionOtherText(current, event.target.value, Boolean(field.multiple)))} placeholder={t('extensionInteraction.writeOwnAnswer')} aria-label={t('extensionInteraction.writeOwnAnswer')} className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0" />
            {draft.otherText.trim() && <Check className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />}
          </label>
          {field.allowComment && <Textarea semanticId={`${semanticId}.comment`} value={draft.comment} onChange={event => onChange(current => current.kind === 'choice' ? { ...current, comment: event.target.value } : current)} rows={1} placeholder={t('extensionInteraction.optionalComment')} aria-label={t('extensionInteraction.optionalComment')} className="mt-1 max-h-24 min-h-10 w-full resize-none rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" />}
        </div>
      )}
      {field.kind === 'text' && draft.kind === 'text' && (field.multiline && !field.sensitive ? <Textarea autoFocus aria-label={field.label} semanticId={`${semanticId}.input`} value={draft.value} onChange={event => onChange(() => ({ kind: 'text', value: event.target.value }))} rows={3} minLength={field.minLength} maxLength={field.maxLength} placeholder={field.placeholder ?? t('extensionInteraction.writeAnswer')} className="mt-3 max-h-40 min-h-20 w-full resize-none rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" /> : <Input autoFocus aria-label={field.label} semanticId={`${semanticId}.input`} type={field.sensitive ? 'password' : 'text'} value={draft.value} onChange={event => onChange(() => ({ kind: 'text', value: event.target.value }))} minLength={field.minLength} maxLength={field.maxLength} placeholder={field.placeholder ?? t('extensionInteraction.writeAnswer')} className="mt-3 h-10 w-full rounded-md border border-border/70 bg-muted/35 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" />)}
      {field.kind === 'confirm' && draft.kind === 'confirm' && <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-sm hover:bg-muted/45 focus-within:ring-2 focus-within:ring-ring/35"><input type="checkbox" data-mortise-semantic-id={`${semanticId}.confirm`} checked={draft.value} onChange={event => onChange(() => ({ kind: 'confirm', value: event.target.checked }))} className="h-4 w-4 shrink-0 accent-foreground" /><span>{t('extensionInteraction.confirm')}</span></label>}
    </fieldset>
  )
}

function InteractionField({ field, semanticId, draft, onChange }: { field: ExtensionInteractionFieldV1; semanticId: string; draft: InteractionDraft; onChange: (update: (draft: InteractionDraft) => InteractionDraft) => void }) {
  const { t } = useTranslation()
  return (
    <fieldset className="min-w-0" data-interaction-field={field.id} data-mortise-semantic-id={semanticId}>
      {field.kind !== 'confirm' && <><legend className="text-sm font-medium leading-5 text-foreground">{field.label}{field.required && <span className="ml-1 text-destructive" aria-hidden="true">*</span>}</legend>{field.description && <p className="mt-0.5 whitespace-pre-wrap text-xs leading-4 text-muted-foreground">{field.description}</p>}</>}
      {field.kind === 'confirm' && draft.kind === 'confirm' && <label className="mt-2 flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-sm transition-colors hover:bg-muted/45 focus-within:ring-2 focus-within:ring-ring/35"><input type="checkbox" data-mortise-semantic-id={`${semanticId}.confirm`} checked={draft.value} onChange={event => onChange(() => ({ kind: 'confirm', value: event.target.checked }))} className="h-4 w-4 shrink-0 accent-foreground" /><span className="min-w-0 flex-1"><span className="block font-medium text-foreground">{field.label}</span>{field.description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{field.description}</span>}</span></label>}
      {field.kind === 'choice' && draft.kind === 'choice' && <div className="mt-2 flex flex-col gap-1" role={field.multiple ? 'group' : 'radiogroup'}>{field.options.map(option => { const selected = draft.selectedOptionIds.includes(option.id); return <label key={option.id} className={cn('flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-2.5 py-2 transition-colors focus-within:ring-2 focus-within:ring-ring/35', selected ? 'border-foreground/15 bg-muted/75' : 'border-transparent hover:border-border/70 hover:bg-muted/40')}><input type={field.multiple ? 'checkbox' : 'radio'} data-mortise-semantic-id={`${semanticId}.option.${interactionSemanticPart(option.id)}`} name={field.multiple ? undefined : `interaction-${field.id}`} checked={selected} onChange={() => onChange(current => selectInteractionOption(current, option.id, Boolean(field.multiple)))} className={field.multiple ? 'peer sr-only' : 'mt-0.5 h-4 w-4 shrink-0 accent-foreground'} /><span className="min-w-0 flex-1 text-sm leading-5"><span className="font-medium text-foreground">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>}</span>{field.multiple && <span data-choice-indicator="checkbox" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-transparent transition-colors peer-checked:border-black peer-checked:bg-black peer-checked:text-white"><Check className="h-3.5 w-3.5" aria-hidden="true" /></span>}</label> })}<Textarea semanticId={`${semanticId}.other`} value={draft.otherText} onChange={event => onChange(current => setInteractionOtherText(current, event.target.value, Boolean(field.multiple)))} rows={1} placeholder={t('extensionInteraction.writeOwnAnswer')} aria-label={t('extensionInteraction.writeOwnAnswer')} className="mt-1 max-h-28 min-h-10 w-full resize-none rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" />{field.allowComment && <Textarea semanticId={`${semanticId}.comment`} value={draft.comment} onChange={event => onChange(current => current.kind === 'choice' ? { ...current, comment: event.target.value } : current)} rows={1} placeholder={field.commentLabel} aria-label={field.commentLabel ?? field.label} className="mt-1 max-h-24 min-h-10 w-full resize-none rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" />}</div>}
      {field.kind === 'text' && draft.kind === 'text' && (field.multiline && !field.sensitive ? <Textarea aria-label={field.label} semanticId={`${semanticId}.input`} value={draft.value} onChange={event => onChange(() => ({ kind: 'text', value: event.target.value }))} rows={3} minLength={field.minLength} maxLength={field.maxLength} placeholder={field.placeholder} className="mt-2 max-h-40 min-h-20 w-full resize-none rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" /> : <Input aria-label={field.label} semanticId={`${semanticId}.input`} type={field.sensitive ? 'password' : 'text'} value={draft.value} onChange={event => onChange(() => ({ kind: 'text', value: event.target.value }))} minLength={field.minLength} maxLength={field.maxLength} placeholder={field.placeholder} className="mt-2 h-10 w-full rounded-md border border-border/70 bg-muted/35 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35" />)}
    </fieldset>
  )
}
