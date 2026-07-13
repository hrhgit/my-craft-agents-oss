import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@craft-agent/shared/labels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { SessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import type { PlanArtifactV1, PlanModeStateV1 } from '@craft-agent/core/types'
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
  const appShellContext = useOptionalAppShellContext()
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(null)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`
  const remoteUIRequest = appShellContext?.remoteUIRequest?.sessionId === sessionId
    ? appShellContext.remoteUIRequest
    : null
  const remoteUIBatch = appShellContext?.remoteUIBatch?.sessionId === sessionId
    ? appShellContext.remoteUIBatch
    : null

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

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
          conversationMode="normal"
          showDiscussionMode={false}
          showPlanMode={false}
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

      {remoteUIRequest && appShellContext?.respondRemoteUI ? (
        <RemoteUIComposer
          request={remoteUIRequest}
          batch={remoteUIBatch}
          onRespond={appShellContext.respondRemoteUI}
          onRespondBatch={appShellContext.respondRemoteUIBatch}
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
