import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Loader2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@mortise/ui'
import type {
  AgentSettingsSnapshot,
  MainAgentSettings,
  SubagentDefinition,
} from '@mortise/shared/config'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
type SubagentDraft = Omit<SubagentDefinition, 'id'> & { id: string }

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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function subagentDraftScope(id: string): string {
  return id || 'new'
}

function readSubagentDraft(scope: string, fallback: SubagentDraft): SubagentDraft {
  try {
    const raw = readDraft(KEYS.agentSubagentDraft, scope)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<SubagentDraft>
    if (
      typeof parsed.id !== 'string'
      || typeof parsed.name !== 'string'
      || typeof parsed.description !== 'string'
      || typeof parsed.systemPrompt !== 'string'
      || !Array.isArray(parsed.tools)
      || parsed.tools.some((tool) => typeof tool !== 'string')
    ) return fallback
    return parsed as SubagentDraft
  } catch {
    return fallback
  }
}

function writeSubagentDraft(scope: string, draft: SubagentDraft): void {
  try {
    writeDraft(KEYS.agentSubagentDraft, JSON.stringify(draft), scope)
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

function SubagentDialog({
  open,
  agent,
  availableTools,
  saving,
  onOpenChange,
  onSave,
  onDelete,
}: {
  open: boolean
  agent: SubagentDefinition | null
  availableTools: MainAgentSettings['tools']
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: SubagentDraft) => void
  onDelete: (agent: SubagentDefinition) => void
}) {
  const { t } = useTranslation()
  const fallback = useMemo<SubagentDraft>(() => agent ?? {
    id: '',
    name: '',
    description: '',
    systemPrompt: '',
    tools: availableTools.filter((tool) => tool.enabled).map((tool) => tool.name),
  }, [agent, availableTools])
  const draftScope = subagentDraftScope(agent?.id ?? 'new')
  const [draft, setDraft] = useState<SubagentDraft>(fallback)
  const [idTouched, setIdTouched] = useState(Boolean(agent))

  useEffect(() => {
    if (!open) return
    setDraft(readSubagentDraft(draftScope, fallback))
    setIdTouched(Boolean(agent))
  }, [agent, draftScope, fallback, open])

  const updateDraft = useCallback((patch: Partial<SubagentDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch }
      writeSubagentDraft(draftScope, next)
      return next
    })
  }, [draftScope])

  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.id)
    && Boolean(draft.name.trim() && draft.description.trim() && draft.systemPrompt.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{agent ? t('settings.agents.editSubagent') : t('settings.agents.newSubagent')}</DialogTitle>
          <DialogDescription>{t('settings.agents.subagentDialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[68vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="subagent-name">{t('settings.agents.name')}</Label>
              <Input
                id="subagent-name"
                semanticId="settings.agents.subagent.name"
                value={draft.name}
                onChange={(event) => {
                  const name = event.target.value
                  updateDraft({ name, ...(!idTouched ? { id: slugify(name) } : {}) })
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subagent-id">{t('settings.agents.id')}</Label>
              <Input
                id="subagent-id"
                semanticId="settings.agents.subagent.id"
                value={draft.id}
                onChange={(event) => {
                  setIdTouched(true)
                  updateDraft({ id: slugify(event.target.value) })
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="subagent-description">{t('settings.agents.agentDescription')}</Label>
            <Input
              id="subagent-description"
              semanticId="settings.agents.subagent.description"
              value={draft.description}
              onChange={(event) => updateDraft({ description: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="subagent-prompt">{t('settings.agents.systemPrompt')}</Label>
            <Textarea
              id="subagent-prompt"
              semanticId="settings.agents.subagent.systemPrompt"
              className="min-h-48 resize-y font-mono text-xs leading-5"
              value={draft.systemPrompt}
              spellCheck={false}
              onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.agents.toolAccess')}</Label>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border/70">
              {availableTools.map((tool) => {
                const checked = draft.tools.includes(tool.name)
                return (
                  <div key={tool.name} className="flex min-h-12 items-center justify-between gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs font-medium">{tool.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{tool.description}</div>
                    </div>
                    <Switch
                      semanticId={`settings.agents.subagent.tool.${tool.name}`}
                      aria-label={tool.name}
                      checked={checked}
                      onCheckedChange={(enabled) => updateDraft({
                        tools: enabled
                          ? [...new Set([...draft.tools, tool.name])]
                          : draft.tools.filter((name) => name !== tool.name),
                      })}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        <DialogFooter className="justify-between sm:justify-between">
          <div>
            {agent && (
              <Button
                variant="destructive"
                size="sm"
                semanticId="settings.agents.subagent.delete"
                disabled={saving}
                onClick={() => onDelete(agent)}
              >
                <Trash2 />
                {t('common.delete')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              semanticId="settings.agents.subagent.cancel"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              semanticId="settings.agents.subagent.save"
              disabled={saving || !valid}
              onClick={() => onSave(draft)}
            >
              {saving && <Loader2 className="animate-spin" />}
              {t('common.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentDefinition | null>(null)
  const [subagentDialogOpen, setSubagentDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SubagentDefinition | null>(null)

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

  const openSubagent = (agent: SubagentDefinition | null) => {
    setSelectedSubagent(agent)
    setSubagentDialogOpen(true)
  }

  const saveSubagent = async (draft: SubagentDraft) => {
    setSaving(true)
    try {
      const result = await window.electronAPI.upsertSubagent({
        schemaVersion: 1,
        previousId: selectedSubagent?.id,
        agent: draft,
      })
      setSnapshot((current) => current ? {
        ...current,
        subagents: [
          ...current.subagents.filter((agent) => agent.id !== selectedSubagent?.id && agent.id !== result.agent.id),
          result.agent,
        ].sort((left, right) => left.name.localeCompare(right.name)),
      } : current)
      clearDraft(KEYS.agentSubagentDraft, subagentDraftScope(selectedSubagent?.id ?? 'new'))
      setSubagentDialogOpen(false)
      toast.success(t('settings.agents.saved'))
    } catch (error) {
      console.error('Failed to save subagent:', error)
      toast.error(t('settings.agents.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const deleteSubagent = async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      await window.electronAPI.deleteSubagent(deleteTarget.id)
      setSnapshot((current) => current ? {
        ...current,
        subagents: current.subagents.filter((agent) => agent.id !== deleteTarget.id),
      } : current)
      clearDraft(KEYS.agentSubagentDraft, subagentDraftScope(deleteTarget.id))
      setDeleteTarget(null)
      setSubagentDialogOpen(false)
      toast.success(t('settings.agents.deleted'))
    } catch (error) {
      console.error('Failed to delete subagent:', error)
      toast.error(t('settings.agents.deleteFailed'))
    } finally {
      setSaving(false)
    }
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
              <Tabs defaultValue="main">
                <TabsList className="mb-5">
                  <TabsTrigger semanticId="settings.agents.tab.main" value="main">{t('settings.agents.mainTab')}</TabsTrigger>
                  <TabsTrigger semanticId="settings.agents.tab.subagents" value="subagents">{t('settings.agents.subagentsTab')}</TabsTrigger>
                </TabsList>
                <TabsContent value="main" className="mt-0 space-y-8">
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
                </TabsContent>
                <TabsContent value="subagents" className="mt-0">
                  <SettingsSection
                    title={t('settings.agents.subagentsTitle')}
                    description={t('settings.agents.subagentsDesc')}
                    action={
                      <Button variant="outline" size="sm" semanticId="settings.agents.subagent.add" onClick={() => openSubagent(null)}>
                        <Plus />
                        {t('common.add')}
                      </Button>
                    }
                  >
                    <SettingsCard>
                      {snapshot.subagents.length === 0 ? (
                        <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                          <Bot className="size-5" />
                          <div className="text-sm">{t('settings.agents.emptySubagents')}</div>
                        </div>
                      ) : snapshot.subagents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          data-mortise-semantic-id={`settings.agents.subagent.${agent.id}`}
                          className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-foreground/3"
                          onClick={() => openSubagent(agent)}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{agent.name}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{agent.description}</div>
                          </div>
                          <Badge variant="secondary" className="shrink-0 font-mono font-normal">{agent.tools.length}</Badge>
                        </button>
                      ))}
                    </SettingsCard>
                  </SettingsSection>
                </TabsContent>
              </Tabs>
            )}
          </div>
        </ScrollArea>
      </div>
      {snapshot && (
        <SubagentDialog
          open={subagentDialogOpen}
          agent={selectedSubagent}
          availableTools={snapshot.mainAgent.tools}
          saving={saving}
          onOpenChange={(open) => { setSubagentDialogOpen(open); if (!open) setSelectedSubagent(null) }}
          onSave={(draft) => void saveSubagent(draft)}
          onDelete={(agent) => setDeleteTarget(agent)}
        />
      )}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.agents.deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('settings.agents.deleteConfirmDescription', { name: deleteTarget?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              semanticId="settings.agents.subagent.delete.cancel"
              disabled={saving}
              onClick={() => setDeleteTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              semanticId="settings.agents.subagent.delete.confirm"
              disabled={saving}
              onClick={() => void deleteSubagent()}
            >
              {saving && <Loader2 className="animate-spin" />}
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
