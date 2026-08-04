import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import type { PermissionMode } from '@mortise/shared/agent/modes'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { ExtensionInteractionComposer } from '@/components/extensions/ExtensionInteractionComposer'
import { DegradedComposer } from './DegradedComposer'
import { QueuedMessageList, type QueuedMessageListItem } from './QueuedMessageList'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  readOnly?: boolean
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  className?: string
  queuedMessages?: QueuedMessageListItem[]
  pendingQueuedMessageId?: string | null
  onSteerQueuedMessage?: (messageId: string) => void
  onDeleteQueuedMessage?: (messageId: string) => void
  onEditQueuedMessage?: (messageId: string) => void
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
  onKillTask,
  onInsertMessage,
  className,
  queuedMessages = [],
  pendingQueuedMessageId,
  onSteerQueuedMessage,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  inputProps,
}: ChatInputZoneProps) {
  const appShellContext = useOptionalAppShellContext()
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`
  const extensionInteraction = appShellContext?.extensionInteraction?.sessionId === sessionId
    ? appShellContext.extensionInteraction
    : null

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const standardComposer = (
    <InputErrorBoundary
      sessionId={sessionId}
      resetKey={inputResetKey}
      section="composer-shell"
      onClearDraft={handleClearDraft}
      fallback={({ retry }) => (
        <DegradedComposer
          sessionId={sessionId}
          inputProps={inputProps}
          onRetry={retry}
        />
      )}
    >
      <InputContainer
        {...inputProps}
        attachedTop={queuedMessages.length > 0}
        compactMode={compactMode}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        sessionId={sessionId}
      />
    </InputErrorBoundary>
  )

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
      className,
    )}>
      {shouldShowOptionBadges && (
        <InputErrorBoundary
          sessionId={sessionId}
          resetKey={`${sessionId}::option-badges`}
          section="option-badges"
          fallback={null}
        >
          <ActiveOptionBadges
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            showPermissionModeBadge={false}
            tasks={tasks}
            sessionId={sessionId}
            onKillTask={onKillTask}
            onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
          />
        </InputErrorBoundary>
      )}

      {readOnly && (
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          此会话来自 Pi CLI（只读）。发送消息将创建新的 Mortise 会话。
        </div>
      )}

      {onSteerQueuedMessage && onDeleteQueuedMessage && onEditQueuedMessage && (
        <QueuedMessageList
          items={queuedMessages}
          pendingId={pendingQueuedMessageId}
          onSteer={onSteerQueuedMessage}
          onDelete={onDeleteQueuedMessage}
          onEdit={onEditQueuedMessage}
        />
      )}

      {extensionInteraction && appShellContext?.respondToExtensionInteraction ? (
        <InputErrorBoundary
          sessionId={sessionId}
          resetKey={`${sessionId}::extension-interaction::${extensionInteraction.requestId}`}
          section="extension-interaction"
          fallback={standardComposer}
        >
          <ExtensionInteractionComposer
            event={extensionInteraction}
            onRespond={appShellContext.respondToExtensionInteraction}
          />
        </InputErrorBoundary>
      ) : (
        standardComposer
      )}
    </div>
  )
}
