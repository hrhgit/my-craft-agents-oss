import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Pencil, RotateCcw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@mortise/ui'
import type { AgentSettingsSnapshot, MainAgentSettings } from '@mortise/shared/config'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingsCard, SettingsCardContent, SettingsCardFooter, SettingsSection } from '@/components/settings'
import { routes } from '@/lib/navigate'
import { getRaw, KEYS, remove, setRaw, type StorageKey } from '@/lib/local-storage'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'agents',
}

const SYSTEM_DRAFT_KEY = KEYS.agentSystemPromptDraft
const COMPACTION_DRAFT_KEY = KEYS.agentCompactionPromptDraft

type PromptKind = 'systemPrompt' | 'compactionPrompt'
function readDraft(key: StorageKey, suffix?: string): string | null {
  return getRaw(key, suffix)
}

function writeDraft(key: StorageKey, value: string, suffix?: string): void {
  try {
    setRaw(key, value, suffix)
  } catch {
    // Saved configuration remains available even when local draft storage is blocked.
  }
}

function clearDraft(key: StorageKey, suffix?: string): void {
  try {
    remove(key, suffix)
  } catch {
    // Ignore unavailable local storage.
  }
}

function buildMainUpdate(main: MainAgentSettings, overrides?: Partial<Record<PromptKind, string | null>>) {
  return {
    schemaVersion: 1 as const,
    systemPrompt: overrides?.systemPrompt !== undefined
      ? overrides.systemPrompt
      : main.systemPromptSource === 'custom' ? main.systemPrompt : null,
    compactionPrompt: overrides?.compactionPrompt !== undefined
      ? overrides.compactionPrompt
      : main.compactionPromptSource === 'custom' ? main.compactionPrompt : null,
    disabledTools: main.tools.filter((tool) => !tool.enabled).map((tool) => tool.name),
  }
}

interface PromptEditorProps {
  kind: PromptKind
  title: string
  description: string
  value: string
  source: MainAgentSettings['systemPromptSource']
  editing: boolean
  draft: string
  saving: boolean
  onBeginEdit: () => void
  onDraftChange: (value: string) => void
  onCancel: () => void
  onSave: () => void
  onReset: () => void
}

function PromptEditor({
  kind,
  title,
  description,
  value,
  source,
  editing,
  draft,
  saving,
  onBeginEdit,
  onDraftChange,
  onCancel,
  onSave,
  onReset,
}: PromptEditorProps) {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={title}
      description={description}
      action={
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{source === 'custom' ? t('settings.agents.custom') : t('settings.agents.piDefault')}</Badge>
          {source === 'custom' && !editing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('settings.agents.resetDefault')}
                  semanticId={`settings.agents.${kind}.reset`}
                  disabled={saving}
                  onClick={onReset}
                >
                  <RotateCcw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('settings.agents.resetDefault')}</TooltipContent>
            </Tooltip>
          )}
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              semanticId={`settings.agents.${kind}.edit`}
              disabled={saving}
              onClick={onBeginEdit}
            >
              <Pencil />
              {t('common.edit')}
            </Button>
          )}
        </div>
      }
    >
      <SettingsCard divided={false}>
        <SettingsCardContent className="p-0">
          <Textarea
            semanticId={`settings.agents.${kind}.value`}
            className="min-h-56 max-h-[32rem] resize-y rounded-none border-0 bg-transparent px-4 py-3 font-mono text-xs leading-5 shadow-none focus-visible:ring-0"
            value={editing ? draft : value}
            readOnly={!editing}
            spellCheck={false}
            onChange={(event) => onDraftChange(event.target.value)}
          />
        </SettingsCardContent>
        {editing && (
          <SettingsCardFooter>
            <Button
              variant="outline"
              size="sm"
              semanticId={`settings.agents.${kind}.cancel`}
              disabled={saving}
              onClick={onCancel}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              semanticId={`settings.agents.${kind}.save`}
              disabled={saving || !draft.trim()}
              onClick={onSave}
            >
              {saving && <Loader2 className="animate-spin" />}
              {t('common.save')}
            </Button>
          </SettingsCardFooter>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

function ToolList({
  tools,
  disabled,
  onToggle,
}: {
  tools: MainAgentSettings['tools']
  disabled: boolean
  onToggle: (name: string, enabled: boolean) => void
}) {
  return (
    <SettingsCard>
      {tools.map((tool) => (
        <SettingsCardContent key={tool.name} className="flex min-h-14 items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-medium">{tool.name}</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tool.description}</div>
          </div>
          <Switch
            semanticId={`settings.agents.tool.${tool.name}`}
            aria-label={tool.name}
            checked={tool.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(tool.name, checked)}
          />
        </SettingsCardContent>
      ))}
    </SettingsCard>
  )
}

export default function AgentSettingsPage() {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<PromptKind | null>(null)
  const [systemDraft, setSystemDraft] = useState('')
  const [compactionDraft, setCompactionDraft] = useState('')

  const loadSettings = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await window.electronAPI.getAgentSettings())
    } catch (error) {
      console.error('Failed to load agent settings:', error)
      toast.error(t('settings.agents.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void loadSettings() }, [loadSettings])

  const saveMain = useCallback(async (
    overrides?: Partial<Record<PromptKind, string | null>>,
    optimisticMain?: MainAgentSettings,
    completedPrompt?: PromptKind,
  ) => {
    if (!snapshot) return
    const main = optimisticMain ?? snapshot.mainAgent
    setSaving(true)
    try {
      const next = await window.electronAPI.updateMainAgentSettings(buildMainUpdate(main, overrides))
      setSnapshot(next)
      if (completedPrompt) {
        setEditingPrompt((current) => current === completedPrompt ? null : current)
        clearDraft(completedPrompt === 'systemPrompt' ? SYSTEM_DRAFT_KEY : COMPACTION_DRAFT_KEY)
      }
      toast.success(t('settings.agents.saved'))
    } catch (error) {
      if (optimisticMain) setSnapshot(snapshot)
      console.error('Failed to save agent settings:', error)
      toast.error(t('settings.agents.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [snapshot, t])

  const beginPromptEdit = (kind: PromptKind) => {
    if (!snapshot) return
    const key = kind === 'systemPrompt' ? SYSTEM_DRAFT_KEY : COMPACTION_DRAFT_KEY
    const value = readDraft(key) ?? snapshot.mainAgent[kind]
    if (kind === 'systemPrompt') setSystemDraft(value)
    else setCompactionDraft(value)
    setEditingPrompt(kind)
  }

  const cancelPromptEdit = (kind: PromptKind) => {
    clearDraft(kind === 'systemPrompt' ? SYSTEM_DRAFT_KEY : COMPACTION_DRAFT_KEY)
    setEditingPrompt(null)
  }

  const toggleTool = async (name: string, enabled: boolean) => {
    if (!snapshot) return
    const mainAgent = {
      ...snapshot.mainAgent,
      tools: snapshot.mainAgent.tools.map((tool) => tool.name === name ? { ...tool, enabled } : tool),
    }
    setSnapshot({ ...snapshot, mainAgent })
    await saveMain(undefined, mainAgent)
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t('settings.agents.title')} actions={<HeaderMenu route={routes.view.settings('agents')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-7">
            {loading || !snapshot ? (
              <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-8">
                  <PromptEditor
                    kind="systemPrompt"
                    title={t('settings.agents.systemPrompt')}
                    description={t('settings.agents.systemPromptDesc')}
                    value={snapshot.mainAgent.systemPrompt}
                    source={snapshot.mainAgent.systemPromptSource}
                    editing={editingPrompt === 'systemPrompt'}
                    draft={systemDraft}
                    saving={saving}
                    onBeginEdit={() => beginPromptEdit('systemPrompt')}
                    onDraftChange={(value) => { setSystemDraft(value); writeDraft(SYSTEM_DRAFT_KEY, value) }}
                    onCancel={() => cancelPromptEdit('systemPrompt')}
                    onSave={() => void saveMain({ systemPrompt: systemDraft }, undefined, 'systemPrompt')}
                    onReset={() => void saveMain({ systemPrompt: null }, undefined, 'systemPrompt')}
                  />
                  <SettingsSection title={t('settings.agents.tools')} description={t('settings.agents.toolsDesc')}>
                    <ToolList tools={snapshot.mainAgent.tools} disabled={saving} onToggle={(name, enabled) => void toggleTool(name, enabled)} />
                  </SettingsSection>
                  <PromptEditor
                    kind="compactionPrompt"
                    title={t('settings.agents.compactionPrompt')}
                    description={t('settings.agents.compactionPromptDesc')}
                    value={snapshot.mainAgent.compactionPrompt}
                    source={snapshot.mainAgent.compactionPromptSource}
                    editing={editingPrompt === 'compactionPrompt'}
                    draft={compactionDraft}
                    saving={saving}
                    onBeginEdit={() => beginPromptEdit('compactionPrompt')}
                    onDraftChange={(value) => { setCompactionDraft(value); writeDraft(COMPACTION_DRAFT_KEY, value) }}
                    onCancel={() => cancelPromptEdit('compactionPrompt')}
                    onSave={() => void saveMain({ compactionPrompt: compactionDraft }, undefined, 'compactionPrompt')}
                    onReset={() => void saveMain({ compactionPrompt: null }, undefined, 'compactionPrompt')}
                  />
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
