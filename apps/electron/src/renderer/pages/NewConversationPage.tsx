import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  Folder,
  Loader2,
} from 'lucide-react'
import { InputContainer } from '@/components/app-shell/input/InputContainer'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import { navigate } from '@/lib/navigate'
import * as storage from '@/lib/local-storage'
import { coerceInputText } from '@/lib/input-text'
import {
  getNewConversationDraftStorageKey,
  getNewConversationOptionsStorageScope,
  type NewConversationDraftOptions,
} from '@/lib/new-conversation'
import { cn } from '@/lib/utils'
import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '@mortise/shared/agent/thinking-levels'
import { parsePermissionMode } from '@mortise/shared/agent/mode-types'
import type { FileAttachment } from '../../shared/types'
import type { CreateAndSendFirstTurnResult } from '@mortise/shared/protocol'

export interface NewConversationPageProps {
  draftId: string
}

export async function runFirstTurnDraftSubmission(
  createAndSendFirstTurn: () => Promise<CreateAndSendFirstTurnResult>,
  commitPublishedSession: (result: CreateAndSendFirstTurnResult) => void,
  preserveDraft: () => void,
): Promise<CreateAndSendFirstTurnResult> {
  let result: CreateAndSendFirstTurnResult
  try {
    result = await createAndSendFirstTurn()
  } catch (error) {
    preserveDraft()
    throw error
  }

  commitPublishedSession(result)
  return result
}

function normalizeDraftOptions(
  value: unknown,
  defaults: NewConversationDraftOptions,
): NewConversationDraftOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const candidate = value as Partial<NewConversationDraftOptions>
  return {
    provider: typeof candidate.provider === 'string' ? candidate.provider : defaults.provider,
    model: typeof candidate.model === 'string' ? candidate.model : defaults.model,
    thinkingLevel: normalizeThinkingLevel(candidate.thinkingLevel) ?? defaults.thinkingLevel,
    permissionMode: typeof candidate.permissionMode === 'string'
      ? parsePermissionMode(candidate.permissionMode) ?? defaults.permissionMode
      : defaults.permissionMode,
    workingDirectory: typeof candidate.workingDirectory === 'string'
      ? candidate.workingDirectory
      : defaults.workingDirectory,
  }
}

function WorkspaceDraftSwitcher() {
  const { t } = useTranslation()
  const { activeWorkspaceId, workspaces, workspaceNavigation } = useAppShellContext()
  const workspace = workspaces.find(item => item.id === activeWorkspaceId)
  const activeItem = workspaceNavigation?.items.find(item => item.workspace.id === activeWorkspaceId)
  if (!workspace) return null

  const TriggerIcon = activeItem?.isChecking
    ? Loader2
    : activeItem?.isDisconnected
      ? CloudOff
      : workspace.remoteServer
        ? Cloud
        : Folder
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) workspaceNavigation?.refreshRemoteHealth() }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('workspace.selectWorkspace')}
          data-mortise-semantic-id="workspace.empty-conversation.switcher"
          className="group flex min-w-0 max-w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TriggerIcon className={cn(
            'size-4 shrink-0 text-muted-foreground',
            activeItem?.isChecking && 'animate-spin',
            activeItem?.isDisconnected && 'text-destructive',
          )} />
          <span className="min-w-0 truncate text-xs font-medium leading-4">{workspace.name}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" side="top" sideOffset={8} className="min-w-[280px] max-w-[min(420px,calc(100vw-24px))]">
        {(workspaceNavigation?.items ?? []).map(item => {
          const ItemStatusIcon = item.isChecking
            ? Loader2
            : item.isDisconnected
              ? CloudOff
              : item.workspace.remoteServer
                ? Cloud
                : Folder
          return (
            <StyledDropdownMenuItem
              key={item.workspace.id}
              data-mortise-semantic-id={`workspace.empty-conversation.switch.${item.workspace.id}`}
              onSelect={() => { void workspaceNavigation?.selectWorkspace(item.workspace.id) }}
              className="min-w-0 gap-2 py-2"
            >
              <ItemStatusIcon className={cn(
                'size-4 shrink-0 text-muted-foreground',
                item.isChecking && 'animate-spin',
                item.isDisconnected && 'text-destructive',
              )} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.workspace.name}</span>
                {item.isDisconnected && (
                  <span className="mt-0.5 block truncate text-[11px] text-destructive">{item.disconnectLabel}</span>
                )}
              </span>
              {item.isActive && <Check className="size-4 shrink-0 text-foreground/60" />}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

const NewConversationPage = React.memo(function NewConversationPage({ draftId }: NewConversationPageProps) {
  const { t } = useTranslation()
  const appShell = useAppShellContext()
  const {
    activeWorkspaceId,
    workspaces,
    piGlobalSettings,
    piProviders,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    skills = [],
    enabledModes,
    isCompactMode,
    leadingAction,
    onCreateAndSendFirstTurn,
  } = appShell
  const workspace = workspaces.find(item => item.id === activeWorkspaceId)
  const workspaceId = workspace?.id ?? ''
  const draftStorageKey = React.useMemo(
    () => getNewConversationDraftStorageKey(workspaceId, draftId),
    [draftId, workspaceId],
  )
  const optionsScope = React.useMemo(
    () => getNewConversationOptionsStorageScope(workspaceId, draftId),
    [draftId, workspaceId],
  )
  const hadStoredOptions = React.useMemo(
    () => storage.getRaw(storage.KEYS.newConversationOptions, optionsScope) !== null,
    [optionsScope],
  )
  const defaultOptions = React.useMemo<NewConversationDraftOptions>(() => ({
    provider: piGlobalSettings.defaultProvider,
    model: piGlobalSettings.defaultModel,
    thinkingLevel: normalizeThinkingLevel(piGlobalSettings.defaultThinkingLevel) ?? DEFAULT_THINKING_LEVEL,
    permissionMode: 'allow-all',
    workingDirectory: workspace?.rootPath,
  }), [piGlobalSettings.defaultModel, piGlobalSettings.defaultProvider, piGlobalSettings.defaultThinkingLevel, workspace?.rootPath])
  const [options, setOptions] = React.useState<NewConversationDraftOptions>(() => normalizeDraftOptions(
    storage.get(storage.KEYS.newConversationOptions, defaultOptions, optionsScope),
    defaultOptions,
  ))
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(draftStorageKey)))
  const [attachmentsValue, setAttachmentsValue] = React.useState<FileAttachment[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [composerRevision, setComposerRevision] = React.useState(0)
  const submitInFlight = React.useRef(false)
  const persistedOptionsScope = React.useRef(optionsScope)

  React.useEffect(() => {
    const stored = storage.get<unknown>(storage.KEYS.newConversationOptions, null, optionsScope)
    setOptions(normalizeDraftOptions(stored, defaultOptions))
    setInputValue(coerceInputText(getDraft(draftStorageKey)))
    let cancelled = false
    void hydrateDraftAttachments(draftStorageKey).then(attachments => {
      if (!cancelled) setAttachmentsValue(attachments)
    })
    return () => { cancelled = true }
  }, [defaultOptions, draftStorageKey, getDraft, hydrateDraftAttachments, optionsScope])

  React.useEffect(() => {
    if (persistedOptionsScope.current !== optionsScope) {
      persistedOptionsScope.current = optionsScope
      return
    }
    storage.set(storage.KEYS.newConversationOptions, options, optionsScope)
  }, [options, optionsScope])

  React.useEffect(() => {
    if (!workspaceId || hadStoredOptions) return
    let cancelled = false
    void window.electronAPI.getWorkspaceSettings(workspaceId).then(settings => {
      if (cancelled || !settings) return
      setOptions(current => ({
        ...current,
        permissionMode: settings.permissionMode ?? current.permissionMode,
        workingDirectory: settings.workingDirectory ?? workspace?.rootPath ?? current.workingDirectory,
      }))
    })
    return () => { cancelled = true }
  }, [hadStoredOptions, workspace?.rootPath, workspaceId])

  const handleInputChange = React.useCallback((value: string) => {
    if (submitInFlight.current && value === '') return
    setInputValue(value)
    onInputChange(draftStorageKey, value)
  }, [draftStorageKey, onInputChange])

  const handleAttachmentsChange = React.useCallback((attachments: FileAttachment[]) => {
    if (submitInFlight.current && attachments.length === 0) return
    setAttachmentsValue(attachments)
    onAttachmentsChange(draftStorageKey, attachments)
  }, [draftStorageKey, onAttachmentsChange])

  const handleSubmit = React.useCallback((
    message: string,
    attachments?: FileAttachment[],
    skillSlugs?: string[],
  ) => {
    if (!workspaceId || submitInFlight.current) return
    const attachmentSnapshot = attachments ?? []
    const inputSnapshot = inputValue
    submitInFlight.current = true
    setSubmitting(true)
    // FreeFormInput clears its local value after invoking onSubmit. Remount it
    // from the still-authoritative draft while the first turn is unpublished.
    setComposerRevision(current => current + 1)
    void (async () => {
      try {
        await runFirstTurnDraftSubmission(
          () => onCreateAndSendFirstTurn({
            workspaceId,
            message,
            attachments: attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
            createOptions: options,
            sendOptions: skillSlugs?.length ? { skillSlugs } : undefined,
          }),
          ({ session }) => {
            setInputValue('')
            setAttachmentsValue([])
            onInputChange(draftStorageKey, '')
            onAttachmentsChange(draftStorageKey, [])
            navigate(routes.view.allSessions(session.id))
          },
          () => {
            setInputValue(inputSnapshot)
            setAttachmentsValue(attachmentSnapshot)
            onInputChange(draftStorageKey, inputSnapshot)
            onAttachmentsChange(draftStorageKey, attachmentSnapshot)
            setComposerRevision(current => current + 1)
          },
        )
      } catch (error) {
        console.error('[NewConversationPage] Failed to publish first turn:', error)
        toast.error(t('toast.failedToCreateSession', 'Failed to create session'))
      } finally {
        submitInFlight.current = false
        setSubmitting(false)
      }
    })()
  }, [draftStorageKey, inputValue, onAttachmentsChange, onCreateAndSendFirstTurn, onInputChange, options, t, workspaceId])

  if (!workspace) return null
  const providerUnavailable = !!options.provider && !piProviders.some(entry => entry.key === options.provider)

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-mortise-semantic-id="workspace.empty-conversation"
      data-mortise-workspace-id={workspaceId}
    >
      {isCompactMode && (
        <PanelHeader leadingAction={leadingAction} />
      )}
      <div className="min-h-0 flex-1" />
      <div className="mx-auto w-full max-w-3xl px-3 pb-4 @xs/panel:px-4">
        <div className="mb-1.5 px-1">
          <WorkspaceDraftSwitcher />
        </div>
        <InputContainer
          key={`${draftStorageKey}:${composerRevision}`}
          disabled={submitting}
          isProcessing={false}
          onSubmit={handleSubmit}
          currentModel={options.model ?? piGlobalSettings.defaultModel ?? ''}
          onModelChange={(model, provider) => setOptions(current => ({
            ...current,
            model,
            provider: provider ?? current.provider,
          }))}
          currentProvider={options.provider ?? piGlobalSettings.defaultProvider}
          onProviderChange={provider => setOptions(current => ({ ...current, provider }))}
          providerUnavailable={providerUnavailable}
          thinkingLevel={options.thinkingLevel}
          onThinkingLevelChange={thinkingLevel => setOptions(current => ({ ...current, thinkingLevel }))}
          permissionMode={options.permissionMode}
          onPermissionModeChange={permissionMode => setOptions(current => ({ ...current, permissionMode }))}
          enabledModes={enabledModes}
          inputValue={inputValue}
          onInputChange={handleInputChange}
          attachmentsValue={attachmentsValue}
          onAttachmentsChange={handleAttachmentsChange}
          skills={skills}
          workspaceId={workspaceId}
          workingDirectory={options.workingDirectory ?? workspace.rootPath}
          isEmptySession
          compactMode={!!isCompactMode}
          enableCompactModelPicker={!!isCompactMode}
        />
      </div>
    </div>
  )
})

export default NewConversationPage
