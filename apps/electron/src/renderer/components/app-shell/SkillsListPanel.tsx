import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { toast } from 'sonner'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { Button } from '@/components/ui/button'
import { skillSelection } from '@/hooks/useEntitySelection'
import { SkillMenu } from './SkillMenu'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { isPrimaryWorkspaceLocal } from '@/lib/workspace-info'
import type { LoadedSkill } from '../../../shared/types'

export interface SkillsListPanelProps {
  skills: LoadedSkill[]
  onSkillClick: (skill: LoadedSkill) => void
  selectedSkillSlug?: string | null
  workspaceId?: string
  onAddSkill: () => void
  className?: string
}

export function SkillsListPanel({
  skills,
  onSkillClick,
  selectedSkillSlug,
  workspaceId,
  onAddSkill,
  className,
}: SkillsListPanelProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const isElectron = window.electronAPI.getRuntimeEnvironment() === 'electron'
  const canRevealWorkspaceSkill = activeWorkspace ? isPrimaryWorkspaceLocal(activeWorkspace) : false

  return (
    <EntityPanel<LoadedSkill>
      items={skills}
      getId={(s) => s.slug}
      selection={skillSelection}
      selectedId={selectedSkillSlug}
      onItemClick={onSkillClick}
      className={className}
      containerProps={{ 'data-list-role': 'skills' }}
      emptyState={
        <EntityListEmptyScreen
          icon={<Zap />}
          title={t('skillsList.noSkillsConfigured')}
          description={t('skillsList.emptyDescription')}
          docKey="skills"
        >
          <Button type="button" onClick={onAddSkill} semanticId="skills.add.empty">
            {t('skillsList.addSkill')}
          </Button>
        </EntityListEmptyScreen>
      }
      mapItem={(skill) => ({
        icon: <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />,
        title: skill.metadata.name,
        badges: (
          <span className="flex items-center gap-1.5 min-w-0">
            {skill.source === 'project' && (
              <span className="shrink-0 rounded-[4px] border border-[var(--surface-border)] bg-foreground/5 px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground">
                {t('skillsList.projectBadge')}
              </span>
            )}
            <span className="truncate">{skill.metadata.description}</span>
          </span>
        ),
        menu: (
          <SkillMenu
            skillSlug={skill.slug}
            skillName={skill.metadata.name}
            onOpenInNewWindow={() => window.electronAPI.openUrl(`mortise://skills/skill/${skill.slug}?window=focused`)}
            onShowInFinder={async () => {
              if (!isElectron || (skill.source === 'project' && !canRevealWorkspaceSkill)) return
              try {
                await window.electronAPI.showInFolder(skill.path)
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
                  description: message,
                })
              }
            }}
            canShowInFinder={isElectron && (skill.source === 'global' || canRevealWorkspaceSkill)}
            canDelete={false}
            deleteLabel={t('skillsList.managedByProject')}
          />
        ),
      })}
    />
  )
}
