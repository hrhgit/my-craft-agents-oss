import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { AlertCircle, CheckCircle2, FileCheck2, LoaderCircle } from 'lucide-react'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@craft-agent/shared/labels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { SessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import type { ConversationMode } from '../ConversationModeSelector'
import { useExtensionCommands } from '@/hooks/useExtensionCommands'
import type { PlanArtifactV1, PlanModeStateV1 } from '@craft-agent/core/types'
import { canFinalizePlan, conversationModeFromPlanState } from './plan-mode-ui-state'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { RemoteUIComposer } from '@/components/extensions/RemoteUIModal'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  planModeState?: PlanModeStateV1
  activePlanArtifact?: PlanArtifactV1
  readOnly?: boolean
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  sessionLabels?: string[]
  labels?: LabelConfig[]
  onLabelsChange?: (labels: string[]) => void
  sessionStatuses?: SessionStatus[]
  currentSessionStatus?: string
  onSessionStatusChange?: (stateId: string) => void
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  planModeState,
  activePlanArtifact,
  readOnly = false,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  sessionLabels = [],
  labels = [],
  onLabelsChange,
  sessionStatuses = [],
  currentSessionStatus = 'todo',
  onSessionStatusChange,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const { t } = useTranslation()
  const appShellContext = useOptionalAppShellContext()
  const { triggerCommand: triggerExtensionCommand } = useExtensionCommands(sessionId)
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(null)
  const [planCommandError, setPlanCommandError] = React.useState<string | null>(null)
  const [planCommandPending, setPlanCommandPending] = React.useState<'mode' | 'finalize' | null>(null)
  const [piExtensionSettings, setPiExtensionSettings] = React.useState<import('../../../../shared/types').PiExtensionSettings | null>(null)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`
  const remoteUIRequest = appShellContext?.remoteUIRequest?.sessionId === sessionId
    ? appShellContext.remoteUIRequest
    : null

  const conversationMode = React.useMemo(() => conversationModeFromPlanState(planModeState), [planModeState])

  React.useEffect(() => {
    let disposed = false
    window.electronAPI?.getPiExtensionSettings?.()
      .then((settings) => {
        if (!disposed) setPiExtensionSettings(settings)
      })
      .catch(() => {
        if (!disposed) setPiExtensionSettings(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  const showConversationModes = piExtensionSettings?.enabled !== false
  const showDiscussionMode = showConversationModes && piExtensionSettings?.planMode?.showDiscussionButton !== false
  const showPlanMode = showConversationModes && piExtensionSettings?.planMode?.showPlanButton !== false

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const handleConversationModeChange = React.useCallback(async (mode: ConversationMode) => {
    const command = mode === 'normal' ? 'plan-off' : mode === 'plan' ? 'plan' : 'discuss'
    setPlanCommandPending('mode')
    setPlanCommandError(null)
    const result = await triggerExtensionCommand(command)
    if (!result.invoked) setPlanCommandError(result.error ?? `/${command} was rejected.`)
    setPlanCommandPending(null)
  }, [triggerExtensionCommand])

  const handleFinalize = React.useCallback(async () => {
    setPlanCommandPending('finalize')
    setPlanCommandError(null)
    const instructions = typeof inputProps.inputValue === 'string' ? inputProps.inputValue.trim() : ''
    const result = await triggerExtensionCommand('plan-finalize', instructions ? { instructions } : {})
    if (result.invoked) {
      if (instructions) inputProps.onInputChange?.('')
    } else {
      setPlanCommandError(result.error ?? '/plan-finalize was rejected.')
    }
    setPlanCommandPending(null)
  }, [inputProps, triggerExtensionCommand])

  const showFinalize = canFinalizePlan(planModeState)
  const completedSteps = activePlanArtifact?.checklist.filter(item => item.status === 'completed').length ?? 0
  const totalSteps = activePlanArtifact?.checklist.length ?? 0
  const currentStep = activePlanArtifact?.checklist.find(item => item.status === 'in_progress')?.title

  const handleLabelAdd = React.useCallback((labelId: string) => {
    const current = sessionLabels || []
    if (current.includes(labelId)) return

    onLabelsChange?.([...current, labelId])

    const config = flattenLabels(labels || []).find(label => label.id === labelId)
    if (config?.valueType) {
      setAutoOpenLabelId(labelId)
    }
  }, [labels, onLabelsChange, sessionLabels])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
      className,
    )}>
      {shouldShowOptionBadges && (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          showPermissionModeBadge={false}
          conversationMode={conversationMode}
          onConversationModeChange={handleConversationModeChange}
          showDiscussionMode={showDiscussionMode}
          showPlanMode={showPlanMode}
          tasks={tasks}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          onKillTask={onKillTask}
          onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
          sessionLabels={sessionLabels}
          labels={labels}
          onLabelsChange={onLabelsChange}
          onRemoveLabel={(labelId) => {
            const next = (sessionLabels || []).filter(entry => entry !== labelId && !entry.startsWith(`${labelId}::`))
            onLabelsChange?.(next)
          }}
          autoOpenLabelId={autoOpenLabelId}
          onAutoOpenConsumed={() => setAutoOpenLabelId(null)}
          sessionStatuses={sessionStatuses}
          currentSessionStatus={currentSessionStatus}
          onSessionStatusChange={onSessionStatusChange}
        />
      )}

      {readOnly && (
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          此会话来自 Pi CLI（只读）。发送消息将创建新的 Craft 会话。
        </div>
      )}

      {activePlanArtifact?.state === 'executing' && totalSteps > 0 && (
        <div className="mb-2 border border-sky-500/25 bg-sky-500/5 px-3 py-2" data-plan-progress>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-medium">{currentStep ?? 'Executing plan'}</span>
            <span className="shrink-0 text-muted-foreground">{completedSteps}/{totalSteps}</span>
          </div>
          <div className="h-1 overflow-hidden bg-muted">
            <div className="h-full bg-sky-500 transition-[width] duration-300" style={{ width: `${Math.round((completedSteps / totalSteps) * 100)}%` }} />
          </div>
        </div>
      )}

      {(showFinalize || planModeState?.phase === 'finalizing' || planModeState?.phase === 'reviewing') && (
        <div className="mb-2 flex min-h-9 items-center justify-between gap-3 border border-border/70 bg-muted/20 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {planModeState?.phase === 'reviewing' ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{planModeState?.phase === 'finalizing' ? t('plan.finalizing') : planModeState?.phase === 'reviewing' ? t('plan.reviewing') : t('plan.readyToFinalize')}</span>
          </div>
          {showFinalize && (
            <button type="button" disabled={planCommandPending !== null || inputProps.isProcessing} onClick={() => void handleFinalize()} className="inline-flex h-7 shrink-0 items-center gap-1.5 bg-foreground px-2.5 text-xs font-medium text-background disabled:opacity-50">
              {planCommandPending === 'finalize' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}{t('plan.finalize')}
            </button>
          )}
        </div>
      )}

      {(planCommandError || planModeState?.error) && (
        <div role="alert" className="mb-2 flex items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{planCommandError || planModeState?.error}</span>
        </div>
      )}

      {remoteUIRequest && appShellContext?.respondRemoteUI ? (
        <RemoteUIComposer
          request={remoteUIRequest}
          onRespond={appShellContext.respondRemoteUI}
        />
      ) : (
        <InputErrorBoundary
          sessionId={sessionId}
          resetKey={inputResetKey}
          onClearDraft={handleClearDraft}
        >
          <InputContainer
            {...inputProps}
            compactMode={compactMode}
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            labels={labels}
            sessionLabels={sessionLabels}
            onLabelAdd={handleLabelAdd}
            sessionFolderPath={sessionFolderPath}
            sessionId={sessionId}
            currentSessionStatus={currentSessionStatus}
          />
        </InputErrorBoundary>
      )}
    </div>
  )
}
