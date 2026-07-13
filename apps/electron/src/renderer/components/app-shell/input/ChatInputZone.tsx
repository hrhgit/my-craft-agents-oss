import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { RemoteUIComposer } from '@/components/extensions/RemoteUIModal'
import { ExtensionInteractionComposer } from '@/components/extensions/ExtensionInteractionComposer'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  readOnly?: boolean
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
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
  className,
  inputProps,
}: ChatInputZoneProps) {
  const appShellContext = useOptionalAppShellContext()
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`
  const remoteUIRequest = appShellContext?.remoteUIRequest?.sessionId === sessionId
    ? appShellContext.remoteUIRequest
    : null

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

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
          tasks={tasks}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          onKillTask={onKillTask}
          onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
        />
      )}

      {readOnly && (
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          此会话来自 Pi CLI（只读）。发送消息将创建新的 Craft 会话。
        </div>
      )}

      {remoteUIRequest?.type === 'extension_interaction_request' && appShellContext?.respondRemoteUI ? (
        <ExtensionInteractionComposer
          event={remoteUIRequest}
          onRespond={appShellContext.respondRemoteUI}
        />
      ) : remoteUIRequest?.type === 'remoteui_request' && appShellContext?.respondRemoteUI ? (
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
            sessionFolderPath={sessionFolderPath}
            sessionId={sessionId}
          />
        </InputErrorBoundary>
      )}
    </div>
  )
}
