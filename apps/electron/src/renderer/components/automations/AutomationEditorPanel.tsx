import * as React from 'react'
import { ArrowLeft, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import * as storage from '@/lib/local-storage'
import type { AutomationDefinitionV3UI } from './types'

type TriggerKind = 'interval' | 'cron' | 'once' | 'event'
type ActionKind = 'prompt' | 'webhook'

export interface AutomationEditorDraft {
  name: string
  description: string
  triggerKind: TriggerKind
  triggerValue: string
  eventSource: 'mortise' | 'agent' | 'extension' | 'external'
  actionKind: ActionKind
  actionValue: string
  enabled: boolean
}

interface AutomationEditorPanelProps {
  automation?: AutomationDefinitionV3UI
  workspaceId: string
  onCancel: () => void
  onSave: (definition: AutomationDefinitionV3UI) => Promise<void>
  onSaved: (automationId: string) => void
}

export function draftFromDefinition(definition?: AutomationDefinitionV3UI): AutomationEditorDraft {
  if (!definition) return {
    name: '',
    description: '',
    triggerKind: 'interval',
    triggerValue: '60',
    eventSource: 'mortise',
    actionKind: 'prompt',
    actionValue: '',
    enabled: true,
  }
  const trigger = definition.triggers[0]
  const action = definition.actions[0]
  let triggerKind: TriggerKind = 'event'
  let triggerValue = ''
  let eventSource: AutomationEditorDraft['eventSource'] = 'mortise'
  if (trigger?.type === 'time') {
    triggerKind = trigger.schedule.kind
    if (trigger.schedule.kind === 'interval') triggerValue = String(Math.max(1, Math.round(trigger.schedule.everyMs / 60_000)))
    else if (trigger.schedule.kind === 'cron') triggerValue = trigger.schedule.expression
    else triggerValue = trigger.schedule.at.slice(0, 16)
  } else if (trigger?.type === 'event') {
    triggerKind = 'event'
    triggerValue = trigger.eventType
    eventSource = trigger.source
  }
  return {
    name: definition.name,
    description: definition.description ?? '',
    triggerKind,
    triggerValue,
    eventSource,
    actionKind: action?.type === 'webhook' ? 'webhook' : 'prompt',
    actionValue: action?.type === 'webhook' ? action.url : action?.prompt ?? '',
    enabled: definition.enabled,
  }
}

export function buildAutomationDefinition(
  draft: AutomationEditorDraft,
  automation?: AutomationDefinitionV3UI,
  now = new Date().toISOString(),
): AutomationDefinitionV3UI {
  const id = automation?.id ?? `aut_${crypto.randomUUID().replaceAll('-', '')}`
  const triggerId = automation?.triggers[0]?.id ?? `trg_${crypto.randomUUID().replaceAll('-', '')}`
  const actionId = automation?.actions[0]?.id ?? `act_${crypto.randomUUID().replaceAll('-', '')}`
  const trigger = draft.triggerKind === 'event'
    ? { id: triggerId, type: 'event' as const, source: draft.eventSource, eventType: draft.triggerValue.trim() }
    : {
        id: triggerId,
        type: 'time' as const,
        schedule: draft.triggerKind === 'interval'
          ? { kind: 'interval' as const, everyMs: Math.max(1, Number(draft.triggerValue)) * 60_000, anchorAt: now }
          : draft.triggerKind === 'cron'
            ? { kind: 'cron' as const, expression: draft.triggerValue.trim() }
            : { kind: 'once' as const, at: new Date(draft.triggerValue).toISOString() },
      }
  const existingAction = automation?.actions[0]
  const action = draft.actionKind === 'webhook'
    ? {
        ...(existingAction?.type === 'webhook' ? existingAction : {}),
        id: actionId,
        type: 'webhook' as const,
        url: draft.actionValue.trim(),
        method: existingAction?.type === 'webhook' ? existingAction.method : 'POST' as const,
      }
    : {
        ...(existingAction?.type === 'prompt' ? existingAction : {}),
        id: actionId,
        type: 'prompt' as const,
        prompt: draft.actionValue.trim(),
        target: existingAction?.type === 'prompt' ? existingAction.target : { kind: 'new-session' as const },
      }
  return {
    ...automation,
    id,
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    enabled: draft.enabled,
    triggers: [trigger, ...(automation?.triggers.slice(1) ?? [])],
    actions: [action, ...(automation?.actions.slice(1) ?? [])],
    createdAt: automation?.createdAt ?? now,
    updatedAt: now,
  }
}

export function AutomationEditorPanel({ automation, workspaceId, onCancel, onSave, onSaved }: AutomationEditorPanelProps) {
  const { t } = useTranslation()
  const storageScope = `workspace_${workspaceId}_${automation?.id ?? 'new'}`
  const initialDraft = React.useMemo(() => automation
    ? draftFromDefinition(automation)
    : storage.get(storage.KEYS.automationEditorDraft, draftFromDefinition(), storageScope), [automation, storageScope])
  const [draft, setDraft] = React.useState(initialDraft)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!automation) storage.set(storage.KEYS.automationEditorDraft, draft, storageScope)
  }, [automation, draft, storageScope])

  const update = <K extends keyof AutomationEditorDraft>(key: K, value: AutomationEditorDraft[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }
  const canSave = draft.name.trim() && draft.triggerValue.trim() && draft.actionValue.trim()

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      const definition = buildAutomationDefinition(draft, automation)
      await onSave(definition)
      storage.remove(storage.KEYS.automationEditorDraft, storageScope)
      onSaved(definition.id)
    } catch (error) {
      toast.error(t('common.error'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  const selectClass = 'h-9 w-full min-w-0 rounded-md border border-[var(--surface-border)] bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring'

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-mortise-semantic-id="automations.editor">
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--surface-border)] px-5 py-2">
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label={t('common.cancel')}><ArrowLeft /></Button>
        <div className="min-w-0 flex-1">
          <h1 className="line-clamp-2 break-words text-base font-semibold leading-5">{automation?.name ?? t('automations.addAutomation')}</h1>
          <p className="truncate text-[13px] text-muted-foreground">{t('automations.sectionWhenDescription')}</p>
        </div>
        <Button type="button" onClick={handleSave} disabled={!canSave || saving} semanticId="automations.editor.save">
          <Save />{t('common.save')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <form className="mx-auto grid max-w-3xl gap-7 px-6 py-7" onSubmit={(event) => { event.preventDefault(); void handleSave() }}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-5">
            <label className="grid min-w-0 gap-2 text-sm font-medium">{t('common.name')}<Input semanticId="automations.editor.name" value={draft.name} onChange={event => update('name', event.target.value)} autoFocus /></label>
            <label className="grid min-w-0 gap-2 text-sm font-medium">{t('common.description')}<Input semanticId="automations.editor.description" value={draft.description} onChange={event => update('description', event.target.value)} /></label>
          </div>

          <fieldset className="grid gap-4 border-t border-[var(--surface-border)] pt-6">
            <legend className="px-1 text-sm font-semibold">{t('automations.sectionWhen')}</legend>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-4">
              <label className="grid min-w-0 gap-2 text-sm font-medium">
                {t('automations.labelEvent')}
                <select className={selectClass} value={draft.triggerKind} onChange={event => update('triggerKind', event.target.value as TriggerKind)} data-mortise-semantic-id="automations.editor.trigger-kind">
                  <option value="interval">Interval</option><option value="cron">Cron</option><option value="once">Once</option><option value="event">Event</option>
                </select>
              </label>
              {draft.triggerKind === 'event' && (
                <label className="grid min-w-0 gap-2 text-sm font-medium">
                  {t('common.source')}
                  <select className={selectClass} value={draft.eventSource} onChange={event => update('eventSource', event.target.value as AutomationEditorDraft['eventSource'])}>
                    <option value="mortise">Mortise</option><option value="agent">Agent</option><option value="extension">Extension</option><option value="external">External</option>
                  </select>
                </label>
              )}
            </div>
            <label className="grid gap-2 text-sm font-medium">
              {draft.triggerKind === 'cron' ? t('automations.labelScheduleExpression') : draft.triggerKind === 'event' ? t('automations.labelEvent') : t('automations.labelRepeats')}
              <Input
                semanticId="automations.editor.trigger-value"
                type={draft.triggerKind === 'once' ? 'datetime-local' : draft.triggerKind === 'interval' ? 'number' : 'text'}
                min={draft.triggerKind === 'interval' ? 1 : undefined}
                value={draft.triggerValue}
                onChange={event => update('triggerValue', event.target.value)}
              />
            </label>
          </fieldset>

          <fieldset className="grid gap-4 border-t border-[var(--surface-border)] pt-6">
            <legend className="px-1 text-sm font-semibold">{t('automations.sectionThen')}</legend>
            <select className={selectClass} value={draft.actionKind} onChange={event => update('actionKind', event.target.value as ActionKind)} data-mortise-semantic-id="automations.editor.action-kind">
              <option value="prompt">{t('automations.badgePrompt')}</option><option value="webhook">{t('automations.badgeWebhook')}</option>
            </select>
            {draft.actionKind === 'prompt' ? (
              <Textarea semanticId="automations.editor.action-value" value={draft.actionValue} onChange={event => update('actionValue', event.target.value)} className="min-h-48 resize-y" />
            ) : (
              <Input semanticId="automations.editor.action-value" type="url" value={draft.actionValue} onChange={event => update('actionValue', event.target.value)} />
            )}
          </fieldset>

          <label className="flex min-h-11 items-center gap-3 border-t border-[var(--surface-border)] pt-6 text-sm font-medium">
            <input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} className="size-4 accent-foreground" />
            {t('automations.statusActive')}
          </label>
        </form>
      </div>
    </section>
  )
}
