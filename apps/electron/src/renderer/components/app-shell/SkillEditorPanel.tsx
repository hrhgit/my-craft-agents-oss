import * as React from 'react'
import { ArrowLeft, Save, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import * as storage from '@/lib/local-storage'
import type { LoadedSkill } from '../../../shared/types'
import type { SkillSource } from '@mortise/shared/skills'

interface SkillEditorDraft {
  source: SkillSource
  slug: string
  name: string
  description: string
  content: string
}

interface SkillEditorPanelProps {
  skill?: LoadedSkill
  workspaceId?: string
  onCancel: () => void
  onSaved: (skill: LoadedSkill) => void
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function SkillEditorPanel({ skill, workspaceId, onCancel, onSaved }: SkillEditorPanelProps) {
  const { t } = useTranslation()
  const isEditing = Boolean(skill)
  const storageScope = `${workspaceId ? `workspace_${workspaceId}` : 'global'}_${skill?.slug ?? 'new'}`
  const initialDraft = React.useMemo<SkillEditorDraft>(() => skill ? {
    source: skill.source,
    slug: skill.slug,
    name: skill.metadata.name,
    description: skill.metadata.description,
    content: skill.content,
  } : storage.get(storage.KEYS.skillEditorDraft, {
    source: 'global',
    slug: '',
    name: '',
    description: '',
    content: '',
  }, storageScope), [skill, storageScope])
  const [draft, setDraft] = React.useState(initialDraft)
  const [slugEdited, setSlugEdited] = React.useState(Boolean(initialDraft.slug))
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!isEditing) storage.set(storage.KEYS.skillEditorDraft, draft, storageScope)
  }, [draft, isEditing, storageScope])

  const update = <K extends keyof SkillEditorDraft>(key: K, value: SkillEditorDraft[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }
  const handleNameChange = (name: string) => {
    setDraft(previous => ({
      ...previous,
      name,
      slug: slugEdited ? previous.slug : slugify(name),
    }))
  }
  const canSave = draft.name.trim() && draft.slug.trim() && draft.content.trim()

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      const saved = await window.electronAPI.saveSkill({
        schemaVersion: 1,
        workspaceId,
        source: draft.source,
        slug: draft.slug,
        name: draft.name,
        description: draft.description,
        content: draft.content,
      })
      storage.remove(storage.KEYS.skillEditorDraft, storageScope)
      onSaved(saved)
    } catch (error) {
      toast.error(t('common.error'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-mortise-semantic-id="skills.editor">
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--surface-border)] px-5 py-2">
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label={t('common.cancel')}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="line-clamp-2 break-words text-base font-semibold leading-5">{isEditing ? skill!.metadata.name : t('skillsList.addSkill')}</h1>
          <p className="truncate text-[13px] text-muted-foreground">
            {draft.source === 'global' ? t('skillInfo.sourceGlobal') : t('skillInfo.sourceProject')}
          </p>
        </div>
        <Button type="button" onClick={handleSave} disabled={!canSave || saving} semanticId="skills.editor.save">
          <Save />
          {t('common.save')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <form className="mx-auto grid max-w-3xl gap-6 px-6 py-7" onSubmit={(event) => { event.preventDefault(); void handleSave() }}>
          {!isEditing && (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-semibold">{t('common.source')}</legend>
              <div className="flex w-full flex-wrap rounded-[7px] border border-[var(--surface-border)] bg-[var(--surface-raised)] p-1">
                <Button type="button" size="sm" variant={draft.source === 'global' ? 'default' : 'ghost'} onClick={() => update('source', 'global')} className="min-w-0 max-w-full flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {t('skillInfo.sourceGlobal')}
                </Button>
                {workspaceId && (
                  <Button type="button" size="sm" variant={draft.source === 'project' ? 'default' : 'ghost'} onClick={() => update('source', 'project')} className="min-w-0 max-w-full flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {t('skillInfo.sourceWorkspace')}
                  </Button>
                )}
              </div>
            </fieldset>
          )}

          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-5">
            <label className="grid min-w-0 gap-2 text-sm font-medium">
              {t('common.name')}
              <Input semanticId="skills.editor.name" value={draft.name} onChange={event => handleNameChange(event.target.value)} autoFocus />
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-medium">
              {t('common.slug')}
              <Input
                semanticId="skills.editor.slug"
                value={draft.slug}
                disabled={isEditing}
                onChange={event => { setSlugEdited(true); update('slug', slugify(event.target.value)) }}
                className="font-mono"
              />
            </label>
          </div>

          <label className="grid gap-2 text-sm font-medium">
            {t('common.description')}
            <Input semanticId="skills.editor.description" value={draft.description} onChange={event => update('description', event.target.value)} />
          </label>

          <label className="grid gap-2 text-sm font-medium">
            <span className="flex items-center gap-2"><Zap className="size-4" />{t('skillInfo.instructions')}</span>
            <Textarea
              semanticId="skills.editor.instructions"
              value={draft.content}
              onChange={event => update('content', event.target.value)}
              className="min-h-[320px] resize-y font-mono leading-6"
            />
          </label>
        </form>
      </div>
    </section>
  )
}
