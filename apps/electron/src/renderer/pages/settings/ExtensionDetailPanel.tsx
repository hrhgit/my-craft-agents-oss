/**
 * ExtensionDetailPanel — 扩展次级配置页面
 *
 * 根据 extensionId 渲染对应扩展的 craft GUI 配置字段。
 * 原先散落在 PiExtensionsSettingsPanel 分组卡片中的字段已按扩展归属移入此处。
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  SettingsCard,
  SettingsSection,
  SettingsSelectRow,
  SettingsToggle,
} from '@/components/settings'
import { getModelShortName, type ModelDefinition } from '@config/models'
import { getModelsForProviderType } from '@config/llm-connections'
import type { LlmConnectionWithStatus, PiExtensionSettings, StoredPiExtensionSettings } from '../../../shared/types'

// ---------------------------------------------------------------------------
// 模型选项工具（从旧 PiExtensionsSettingsPanel 迁移）
// ---------------------------------------------------------------------------

function getModelOptionsForConnection(
  connection: LlmConnectionWithStatus | undefined,
): Array<{ value: string; label: string; description?: string }> {
  if (!connection) return []

  if (connection.models && connection.models.length > 0) {
    return connection.models.map((m) => {
      if (typeof m === 'string') {
        return { value: m, label: getModelShortName(m), description: connection.name }
      }
      const def = m as ModelDefinition
      return { value: def.id, label: def.name, description: connection.name }
    })
  }

  return getModelsForProviderType(connection.providerType, connection.piAuthProvider).map((m) => ({
    value: m.id,
    label: m.name,
    description: connection.name,
  }))
}

function modelOptionsFromConnections(
  llmConnections: LlmConnectionWithStatus[],
): Array<{ value: string; label: string; description?: string }> {
  const seen = new Set<string>()
  const options: Array<{ value: string; label: string; description?: string }> = []
  for (const connection of llmConnections) {
    for (const option of getModelOptionsForConnection(connection)) {
      if (seen.has(option.value)) continue
      seen.add(option.value)
      options.push(option)
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

interface ExtensionDetailPanelProps {
  extensionId: string
  settings: PiExtensionSettings
  llmConnections: LlmConnectionWithStatus[]
  onPatch: (patch: StoredPiExtensionSettings) => Promise<void>
  onBack: () => void
}

export function ExtensionDetailPanel({
  extensionId,
  settings,
  llmConnections,
  onPatch,
  onBack,
}: ExtensionDetailPanelProps) {
  const { t } = useTranslation()
  const modelOptions = useMemo(() => modelOptionsFromConnections(llmConnections), [llmConnections])

  const descriptionKey = `settings.extensions.ext.${extensionId}.description`
  const description = t(descriptionKey)

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground -ml-2"
      >
        <ArrowLeft className="h-3.5 w-3.5 mr-1" />
        {t('common.backToList')}
      </Button>

      <SettingsSection title={extensionId} description={description}>
        {renderExtensionConfig(extensionId, settings, onPatch, modelOptions, t)}
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 按扩展 id 渲染对应配置字段
// ---------------------------------------------------------------------------

function renderExtensionConfig(
  extensionId: string,
  settings: PiExtensionSettings,
  onPatch: (patch: StoredPiExtensionSettings) => Promise<void>,
  modelOptions: Array<{ value: string; label: string; description?: string }>,
  t: ReturnType<typeof useTranslation>['t'],
): React.ReactNode {
  switch (extensionId) {
    case 'subagent':
      return <SubagentConfig settings={settings} onPatch={onPatch} modelOptions={modelOptions} t={t} />
    case 'trace-audit':
      return <TraceAuditConfig settings={settings} onPatch={onPatch} t={t} />
    case 'yourself':
      return <YourselfConfig settings={settings} onPatch={onPatch} t={t} />
    case 'repo-memory':
      return <RepoMemoryConfig settings={settings} onPatch={onPatch} t={t} />
    case 'prompt-automation':
      return <PromptAutomationConfig settings={settings} onPatch={onPatch} t={t} />
    case 'plan-mode':
      return <PlanModeConfig settings={settings} onPatch={onPatch} t={t} />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 各扩展配置组件
// ---------------------------------------------------------------------------

type ConfigProps = {
  settings: PiExtensionSettings
  onPatch: (patch: StoredPiExtensionSettings) => Promise<void>
  t: ReturnType<typeof useTranslation>['t']
}

type ModelConfigProps = ConfigProps & {
  modelOptions: Array<{ value: string; label: string; description?: string }>
}

function SubagentConfig({ settings, onPatch, modelOptions, t }: ModelConfigProps) {
  const modelSelectOptions = useMemo(() => {
    const fallbackModels = [
      settings.subagent.reviewModel,
      'stepfun/step-3.7-flash',
      'mimo/mimo-v2.5-pro',
    ].filter((value): value is string => Boolean(value))
    const seen = new Set(modelOptions.map(option => option.value))
    const extras = fallbackModels
      .filter(value => {
        if (seen.has(value)) return false
        seen.add(value)
        return true
      })
      .map(value => ({ value, label: getModelShortName(value) }))
    return [...modelOptions, ...extras]
  }, [modelOptions, settings.subagent.reviewModel])

  return (
    <div className="space-y-3">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.extensions.subagent.reviewEnabled')}
          description={t('settings.extensions.subagent.reviewEnabledDesc')}
          checked={settings.subagent.reviewEnabled}
          onCheckedChange={(reviewEnabled) => onPatch({ subagent: { reviewEnabled } })}
        />
        <SettingsSelectRow
          label={t('settings.extensions.subagent.reviewModel')}
          description={t('settings.extensions.subagent.reviewModelDesc')}
          value={settings.subagent.reviewModel}
          onValueChange={(reviewModel) => onPatch({ subagent: { reviewModel } })}
          options={modelSelectOptions}
          disabled={!settings.subagent.reviewEnabled}
        />
      </SettingsCard>
    </div>
  )
}

function TraceAuditConfig({ settings, onPatch, t }: ConfigProps) {
  return (
    <div className="space-y-3">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.extensions.traceAudit.reviewSubagent')}
          description={t('settings.extensions.traceAudit.reviewSubagentDesc')}
          checked={settings.traceAudit.reviewSubagentEnabled}
          onCheckedChange={(reviewSubagentEnabled) => onPatch({ traceAudit: { reviewSubagentEnabled } })}
        />
        <SettingsToggle
          label={t('settings.extensions.traceAudit.statusBadge')}
          description={t('settings.extensions.traceAudit.statusBadgeDesc')}
          checked={settings.traceAudit.showStatusBadge}
          onCheckedChange={(showStatusBadge) => onPatch({ traceAudit: { showStatusBadge } })}
        />
      </SettingsCard>
    </div>
  )
}

function YourselfConfig({ settings, onPatch, t }: ConfigProps) {
  return (
    <div className="space-y-3">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.extensions.yourself.statusBadge')}
          description={t('settings.extensions.yourself.statusBadgeDesc')}
          checked={settings.yourself.showStatusBadge}
          onCheckedChange={(showStatusBadge) => onPatch({ yourself: { showStatusBadge } })}
        />
      </SettingsCard>
    </div>
  )
}

function RepoMemoryConfig({ settings, onPatch, t }: ConfigProps) {
  return (
    <div className="space-y-3">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.extensions.repoMemory.statusBadge')}
          description={t('settings.extensions.repoMemory.statusBadgeDesc')}
          checked={settings.repoMemory.showStatusBadge}
          onCheckedChange={(showStatusBadge) => onPatch({ repoMemory: { showStatusBadge } })}
        />
      </SettingsCard>
    </div>
  )
}

function PromptAutomationConfig({ settings, onPatch, t }: ConfigProps) {
  return (
    <div className="space-y-3">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.extensions.delegatePromptAutomation')}
          description={t('settings.extensions.delegatePromptAutomationDesc')}
          checked={settings.delegatePromptAutomation}
          onCheckedChange={(delegatePromptAutomation) => onPatch({ delegatePromptAutomation })}
        />
        <SettingsToggle
          label={t('settings.extensions.promptAutomation.widget')}
          description={t('settings.extensions.promptAutomation.widgetDesc')}
          checked={settings.promptAutomation.widgetVisible}
          onCheckedChange={(widgetVisible) => onPatch({ promptAutomation: { widgetVisible } })}
        />
        <SettingsSelectRow
          label={t('settings.extensions.promptAutomation.jobScope')}
          description={t('settings.extensions.promptAutomation.jobScopeDesc')}
          value={settings.promptAutomation.defaultJobScope}
          onValueChange={(defaultJobScope) => onPatch({ promptAutomation: { defaultJobScope: defaultJobScope as 'session' | 'workdir' } })}
          options={[
            { value: 'session', label: t('settings.extensions.promptAutomation.scopeSession') },
            { value: 'workdir', label: t('settings.extensions.promptAutomation.scopeWorkdir') },
          ]}
        />
      </SettingsCard>
    </div>
  )
}

function PlanModeConfig({ settings, onPatch, t }: ConfigProps) {
  return (
    <div className="space-y-3">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.extensions.planMode.discussionButton')}
          description={t('settings.extensions.planMode.discussionButtonDesc')}
          checked={settings.planMode.showDiscussionButton}
          onCheckedChange={(showDiscussionButton) => onPatch({ planMode: { showDiscussionButton } })}
        />
        <SettingsToggle
          label={t('settings.extensions.planMode.planButton')}
          description={t('settings.extensions.planMode.planButtonDesc')}
          checked={settings.planMode.showPlanButton}
          onCheckedChange={(showPlanButton) => onPatch({ planMode: { showPlanButton } })}
        />
        <SettingsToggle
          label={t('settings.extensions.planMode.specialRendering')}
          description={t('settings.extensions.planMode.specialRenderingDesc')}
          checked={settings.planMode.renderPlanMarkdown}
          onCheckedChange={(renderPlanMarkdown) => onPatch({ planMode: { renderPlanMarkdown } })}
        />
      </SettingsCard>
    </div>
  )
}

export default ExtensionDetailPanel
