import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from 'cmdk'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import {
  Paperclip,
  ArrowUp,
  Square,
  Check,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Image as ImageIcon,
  Sparkles,
  X,
} from 'lucide-react'
import { Icon_Home, Icon_Folder, Spinner } from '@mortise/ui'

import * as storage from '@/lib/local-storage'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { Button } from '@/components/ui/button'
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
  type SlashCommand,
  type SlashSection,
} from '@/components/ui/slash-command-menu'
import { useExtensionCommands } from '@/hooks/useExtensionCommands'
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
  type MentionItemType,
} from '@/components/ui/mention-menu'
import { parseMentions } from '@/lib/mentions'
import { RichTextInput, type RichTextInputHandle } from '@/components/ui/rich-text-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@mortise/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { coerceInputText } from '@/lib/input-text'
import { isMac, PATH_SEP, getPathBasename } from '@/lib/platform'
import { applySmartTypography } from '@/lib/smart-typography'
import { AttachmentPreview } from '../AttachmentPreview'
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner'
import { ANTHROPIC_MODELS, getModelShortName, getModelDisplayName, type ModelDefinition } from '@config/models'
import { piProviderModelSupportsImages } from '@mortise/shared/config/pi-provider-models'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { CompactWorkingDirectorySelector } from '@/components/ui/CompactWorkingDirectorySelector'
import { ProviderIcon } from '@/components/icons/ProviderIcon'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { derivePickerMode } from './picker-mode'
import { matchExactExtensionCommand } from './extension-command-submit'
import type { FileAttachment, LoadedSkill } from '../../../../shared/types'
import type { MidStreamSendIntent } from '@mortise/shared/protocol'
import type { PermissionMode } from '@mortise/shared/agent/modes'
import { type ThinkingLevel, THINKING_LEVELS, getThinkingLevelNameKey } from '@mortise/shared/agent/thinking-levels'
import {
  ATTACHMENT_INLINE_RPC_LIMIT_BYTES,
  ATTACHMENT_SINGLE_FILE_LIMIT_BYTES,
} from '@mortise/shared/utils/attachment-limits'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { useUiSemanticNode } from '@/ui-validation/react'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { ToolbarStatusSlot } from './ToolbarStatusSlot'
import { shouldHandleScopedInputEvent } from './input-event-guards'
import { clearPendingFocusForSession, consumePendingFocusForSession } from './focus-input-events'
import {
  getRecentWorkingDirs,
  addRecentWorkingDir,
} from './working-directory-history'
import { useWorkingDirectoryState } from './use-working-directory-state'
import { CompactPermissionModeSelector } from './CompactPermissionModeSelector'
import { CompactModelSelector } from './CompactModelSelector'
import {
  formatTokenCount,
  groupProviders,
  resolveEffectiveProvider,
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import {
  getConnectionModelContextWindow,
  getContextUsagePercent,
} from './context-usage'
import { useModelVisionToggle } from './useModelVisionToggle'
import { resolveMidStreamSendIntent } from './midstream-shortcuts'

function formatFollowUpChipText(text: string, fallback: string, maxLength = 50): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}

function ContextUsageRing({
  contextStatus,
  currentModel,
  configuredContextWindow,
}: {
  contextStatus?: FreeFormInputProps['contextStatus']
  currentModel: string
  configuredContextWindow?: number
}) {
  const { t } = useTranslation()
  const usage = getContextUsagePercent(contextStatus, currentModel, configuredContextWindow)
  const percent = usage.percent ?? 0
  const radius = 5
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - percent / 100)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-full text-foreground/60"
          aria-label={usage.percent === null ? t('chat.context') : `${usage.percent}% ${t('chat.context')}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
            <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </svg>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {usage.inputTokens && usage.contextWindow
          ? `${formatTokenCount(usage.inputTokens)} / ${formatTokenCount(usage.contextWindow)} tokens (${usage.percent}%)`
          : 'Context usage unavailable'}
      </TooltipContent>
    </Tooltip>
  )
}

function CompactThinkingBadge({
  thinkingLevel,
  onThinkingLevelChange,
  disabled,
}: {
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const label = t(getThinkingLevelNameKey(thinkingLevel))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="h-7 px-1.5 shrink-0 inline-flex items-center gap-0.5 rounded-[6px] text-xs text-foreground/55 hover:bg-foreground/5 disabled:opacity-40"
          aria-label={`${t('chat.modelPicker.thinkingSection')}: ${label}`}
        >
          <span>{label}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" side="top" className="w-52">
        {THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => (
          <StyledDropdownMenuItem
            key={id}
            onSelect={() => onThinkingLevelChange?.(id)}
            className="flex items-center justify-between"
          >
            <div className="min-w-0">
              <div className="text-sm">{t(nameKey)}</div>
              <div className="text-xs text-muted-foreground truncate">{t(descriptionKey)}</div>
            </div>
            {thinkingLevel === id && <Check className="h-3 w-3 ml-2 shrink-0" />}
          </StyledDropdownMenuItem>
        ))}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}


/** Platform-specific modifier key for keyboard shortcuts */
const cmdKey = isMac ? '⌘' : 'Ctrl'

/** Default rotating placeholders are now generated inside FreeFormInput via useMemo + t() */

/** Fisher-Yates shuffle — returns a new array in random order */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export interface FollowUpInputItem {
  id: string
  messageId: string
  annotationId: string
  index?: number
  noteLabel: string
  selectedText: string
  color?: string
}

export interface FreeFormInputProps {
  /** Placeholder text(s) for the textarea - can be array for rotation */
  placeholder?: string | string[]
  /** Whether input is disabled */
  disabled?: boolean
  /** Whether the session is currently processing */
  isProcessing?: boolean
  /** Callback when message is submitted (skillSlugs from @mentions) */
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[], midStreamSendIntent?: MidStreamSendIntent) => void
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: (silent?: boolean) => void
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle>
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes provider key for proper persistence) */
  onModelChange: (model: string, provider?: string) => void
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'minimal', 'low', 'medium', 'high', 'xhigh') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // Advanced options
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Enabled permission modes for Shift+Tab cycling (min 2 modes) */
  enabledModes?: PermissionMode[]
  // Controlled input value (for persisting across mode switches and conversation changes)
  /** Current input value - if provided, component becomes controlled */
  inputValue?: string
  /** Callback when input value changes */
  onInputChange?: (value: string) => void
  /** Persisted attachment draft for this session (seeds local state on session switch) */
  attachmentsValue?: FileAttachment[]
  /** Callback when attachment list changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
  /** Callback when component height changes (for external animation sync) */
  onHeightChange?: (height: number) => void
  /** Callback when focus state changes */
  onFocusChange?: (focused: boolean) => void
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: LoadedSkill[]
  /** Workspace ID for loading skill icons */
  workspaceId?: string
  /** Current working directory path */
  workingDirectory?: string
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: (path: string) => void
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string
  /** Session ID for scoping session-bound events */
  sessionId?: string
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean
  /** Whether the session is empty (no messages yet) - affects context badge prominence */
  isEmptySession?: boolean
  /** Context status for showing compaction indicator and token usage */
  contextStatus?: {
    /** True when SDK is actively compacting the conversation */
    isCompacting?: boolean
    /** Input tokens used so far in this session */
    inputTokens?: number
    /** Model's context window size in tokens */
    contextWindow?: number
  }
  /** Follow-up annotations shown as context chips above the input */
  followUpItems?: FollowUpInputItem[]
  /** Callback when user clicks a follow-up chip body */
  onFollowUpClick?: (item: FollowUpInputItem, anchor?: { x: number; y: number }) => void
  /** Callback when user clicks the follow-up index badge */
  onFollowUpIndexClick?: (item: FollowUpInputItem) => void
  /**
   * Compact-footer layout. Used by EditPopover (popover embedding) and by
   * ChatPage in auto-compact / WebUI mobile mode. The popover case hides the
   * model picker; the auto-compact case opts the compact picker in via
   * `enableCompactModelPicker`.
   */
  compactMode?: boolean
  /**
   * When `compactMode` is true, render the compact (drawer-based) model
   * selector next to the permission-mode pill. Defaults to false so that
   * EditPopover (which has no use for a model picker) keeps its current
   * behavior.
   */
  enableCompactModelPicker?: boolean
  // Connection selection (hierarchical connection → model selector)
  /** Current provider key */
  currentProvider?: string
  /** Callback when connection changes */
  onProviderChange?: (providerKey: string) => void
  /** When true, the session's selected connection has been removed */
  providerUnavailable?: boolean
  /**
   * True when the input is collapsed because the agent is processing in
   * compact mode and the user hasn't expanded it yet. Owned by
   * `InputContainer`; toggle back via `onRequestExpand`.
   */
  isCollapsedInCompact?: boolean
  /** Callback fired when the user clicks or hovers the collapsed-input strip. */
  onRequestExpand?: () => void
}

/**
 * FreeFormInput - Self-contained textarea input with attachments and controls
 *
 * Features:
 * - Auto-growing textarea
 * - File attachments via button or drag-drop
 * - Slash commands menu
 * - Model selector
 * - Active option badges
 */
export function FreeFormInput({
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  onModelChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes = ['safe', 'ask', 'allow-all'],
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  skills = [],
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  sessionId,
  disableSend = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  enableCompactModelPicker = false,
  currentProvider,
  onProviderChange,
  providerUnavailable = false,
  isCollapsedInCompact = false,
  onRequestExpand,
}: FreeFormInputProps) {
  const { t } = useTranslation()

  // Default rotating placeholders for onboarding/empty state (i18n-aware)
  const defaultPlaceholders = React.useMemo(() => [
    t("chatInput.placeholder.workOn"),
    t("chatInput.placeholder.shiftTab"),
    t("chatInput.placeholder.mention"),
    t("chatInput.placeholder.newLine"),
    t("chatInput.placeholder.sidebar", { key: cmdKey }),
    t("chatInput.placeholder.focusMode", { key: cmdKey }),
  ], [t])

  const effectivePlaceholderProp = placeholder ?? defaultPlaceholders

  // Read connection default model, connections, and workspace info from context.
  // Uses optional variant so playground (no provider) doesn't crash.
  const appShellCtx = useOptionalAppShellContext()
  const providerItems = appShellCtx?.piProviders ?? []
  const defaultProvider = appShellCtx?.piGlobalSettings.defaultProvider

  // Derive providerDefaultModel per-session from the effective connection.
  // Only non-null for compat providers (custom endpoints with fixed models).
  // Standard providers (anthropic, pi) → null → normal model picker.
  const providerDefaultModel = React.useMemo(() => {
    const effectiveKey = resolveEffectiveProvider(currentProvider, defaultProvider, providerItems)
    const entry = providerItems.find(candidate => candidate.key === effectiveKey)
    if (!entry || (entry.provider.models?.length ?? 0) > 1) return null
    return entry.provider.models?.[0]?.id ?? null
  }, [currentProvider, defaultProvider, providerItems])

  // Decide which of the four picker UIs to render. The `switcher` branch
  // wins over `locked-single` so users with multiple providers can always
  // reach the connection list, including after a session has started.
  const pickerMode = derivePickerMode({
    providerUnavailable,
    providerDefaultModel,
    isEmptySession,
    providerCount: providerItems.length,
  })

  // Compute available models from the effective connection.
  // All connections have models populated by backfillAllConnectionModels().
  const availableModels = React.useMemo(() => {
    // Connection removed — don't fall through to another connection's models
    if (providerUnavailable) return []

    // Determine effective connection using the canonical fallback chain
    const effectiveKey = resolveEffectiveProvider(currentProvider, defaultProvider, providerItems)
    const provider = providerItems.find(entry => entry.key === effectiveKey)

    if (!provider) {
      return ANTHROPIC_MODELS // Safety net — shouldn't happen
    }

    return provider.provider.models || ANTHROPIC_MODELS
  }, [providerItems, currentProvider, defaultProvider, providerUnavailable])

  const availableThinkingLevels = THINKING_LEVELS

  // Disable thinking selector when the current model explicitly doesn't support it
  const thinkingDisabled = React.useMemo(() => {
    const model = availableModels.find(m => typeof m !== 'string' && m.id === currentModel)
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [availableModels, currentModel])

  // Get display name for current model (full name, not short name)
  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = providerDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) {
      // Fallback: use helper function to format unknown model IDs nicely
      return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    }
    if (typeof model === 'string') return stripPiPrefixForDisplay(model)
    // Defensive: partial entries (custom-endpoint user-config or vision-toggle
    // promotions) may lack `name`. Fall back to the id so the trigger button
    // never goes blank.
    return model.name ?? stripPiPrefixForDisplay(model.id)
  }, [availableModels, currentModel, providerDefaultModel])

  // Group connections by provider type for hierarchical dropdown.
  // Each provider (Anthropic, Pi) can have multiple connections (API Key, OAuth, etc.)
  const providerGroups = React.useMemo(
    () => groupProviders(providerItems),
    [providerItems],
  )

  // Find current connection details for display
  const currentProviderDetails = React.useMemo(() => {
    if (!currentProvider) return null
    return providerItems.find(entry => entry.key === currentProvider) ?? null
  }, [providerItems, currentProvider])

  // Effective connection: canonical fallback chain (session → global default → first)
  const effectiveProvider = resolveEffectiveProvider(currentProvider, defaultProvider, providerItems)

  // Effective connection details (with fallbacks) for model list
  // Unlike currentProviderDetails which is null when no explicit connection is set,
  // this resolves to the actual connection being used (including the global default)
  const effectiveProviderDetails = React.useMemo(() => {
    if (!effectiveProvider) return null
    return providerItems.find(entry => entry.key === effectiveProvider) ?? null
  }, [providerItems, effectiveProvider])

  const configuredContextWindow = React.useMemo(
    () => getConnectionModelContextWindow(effectiveProviderDetails?.provider.models, currentModel),
    [currentModel, effectiveProviderDetails?.provider.models],
  )

  // Workspace slug for SDK skill qualification (server-computed)
  // SDK expects "workspaceSlug:skillSlug" format, NOT UUID
  const workspaceSlug = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return workspaceId
    return appShellCtx.workspaces.find(w => w.id === workspaceId)?.slug ?? workspaceId
  }, [appShellCtx, workspaceId])

  // Read panel focus state from context (for multi-panel unfocused styling)
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // Shuffle placeholder order once per mount so each session feels fresh.
  // In compact mode, suppress desktop-keyboard guidance that is noisy or misleading
  // on narrow/mobile-like layouts.
  const placeholderOptions = React.useMemo(() => {
    if (!Array.isArray(placeholder)) return placeholder
    if (!compactMode) return placeholder
    return placeholder.filter((entry) => {
      const lower = entry.toLowerCase()
      return !lower.includes('shift + tab')
        && !lower.includes('shift + return')
        && !lower.includes('toggle the sidebar')
        && !lower.includes('focus mode')
        && !lower.includes('⌘')
        && !lower.includes('ctrl')
    })
  }, [placeholder, compactMode])

  // Hide placeholder entirely when panel is unfocused in multi-panel layout
  const shuffledPlaceholder = React.useMemo(
    () => Array.isArray(effectivePlaceholderProp) ? shuffleArray(effectivePlaceholderProp) : effectivePlaceholderProp,
    [] // eslint-disable-line react-hooks/exhaustive-deps -- intentionally shuffle only on mount
  )
  const effectivePlaceholder = isFocusedPanel ? shuffledPlaceholder : ''

  // Performance optimization: Always use internal state for typing to avoid parent re-renders
  // Sync FROM parent on mount/change (for restoring drafts)
  // Sync TO parent on blur/submit (debounced persistence)
  const [input, setInput] = React.useState(() => coerceInputText(inputValue))
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(attachmentsValue ?? [])

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)
  const attachmentsRef = React.useRef<FileAttachment[]>([])
  React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // Seed from parent when `attachmentsValue` changes (e.g., switching sessions).
  // `skipPersistRef` tells the save effect below that the next `attachments` change
  // is a prop-driven seed, not user intent — otherwise we'd echo the seed back to
  // the parent and risk persisting A's attachments under B's sessionId.
  const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return ''
    return attachmentsValue.map(a => a.path).join('|')
  }, [attachmentsValue])
  const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey)
  const skipPersistRef = React.useRef(true) // treat initial mount as a prop-seed
  React.useEffect(() => {
    if (attachmentsValue === undefined) return
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return
    prevAttachmentsRefsKey.current = attachmentsRefsKey
    skipPersistRef.current = true
    setAttachments(attachmentsValue)
  }, [attachmentsValue, attachmentsRefsKey])

  // Persist user-initiated attachment changes back to the parent. The parent stores
  // refs (path + name) and debounces the disk write, so we fire eagerly on every
  // change — add/remove/send-clear.
  const onAttachmentsChangeRef = React.useRef(onAttachmentsChange)
  onAttachmentsChangeRef.current = onAttachmentsChange
  React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    onAttachmentsChangeRef.current?.(attachments)
  }, [attachments])

  // Sync from parent when inputValue changes externally (e.g., switching sessions)
  const prevInputValueRef = React.useRef(coerceInputText(inputValue))
  React.useEffect(() => {
    if (inputValue === undefined) return
    const nextInputValue = coerceInputText(inputValue)
    if (nextInputValue !== prevInputValueRef.current) {
      setInput(nextInputValue)
      prevInputValueRef.current = nextInputValue
    }
  }, [inputValue])

  // Debounced sync to parent (saves draft without blocking typing)
  const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  const syncToParent = React.useCallback((value: string) => {
    if (!onInputChange) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      onInputChange(value)
      prevInputValueRef.current = value
    }, 300) // Debounce 300ms
  }, [onInputChange])

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  const inputRef = React.useRef(input)
  inputRef.current = input // Keep ref in sync with state

  React.useEffect(() => {
    return () => {
      // Cancel pending debounced sync
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
      // Immediately sync current value to parent on unmount
      // This preserves input when switching to structured input (e.g., permission request)
      if (onInputChange && inputRef.current !== prevInputValueRef.current) {
        onInputChange(inputRef.current)
      }
    }
  }, [onInputChange])

  const [isDraggingOver, setIsDraggingOver] = React.useState(false)
  const [loadingCount, setLoadingCount] = React.useState(0)
  const [isFocused, setIsFocused] = React.useState(false)
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540)
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // Input settings (loaded from config)
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(true)
  const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')
  const [spellCheck, setSpellCheck] = React.useState(false)

  // Load input settings on mount
  React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getSpellCheck(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSendMessageKey(sendKey ?? 'enter')
        setSpellCheck(spellCheckEnabled)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadInputSettings()
  }, [])

  // Double-Esc interrupt: show warning overlay on first Esc, interrupt on second
  const { showEscapeOverlay } = useEscapeInterrupt()

  // Calculate max height: min(66% of window height, 540px)
  React.useEffect(() => {
    const updateMaxHeight = () => {
      const maxFromWindow = Math.floor(window.innerHeight * 0.66)
      setInputMaxHeight(Math.min(maxFromWindow, 540))
    }
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    return () => window.removeEventListener('resize', updateMaxHeight)
  }, [])

  const dragCounterRef = React.useRef(0)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Merge refs for RichTextInput
  const internalInputRef = React.useRef<RichTextInputHandle>(null)
  const richInputRef = externalInputRef || internalInputRef

  // Track last caret position for focus restoration (e.g., after permission mode popover closes)
  const lastCaretPositionRef = React.useRef<number | null>(null)

  // Listen for mortise:insert-text events (generic mechanism for inserting text into input)
  // Used by components that want to pre-fill the input with text
  React.useEffect(() => {
    const handleInsertText = (e: CustomEvent<{ text: string; sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const text = coerceInputText(e.detail?.text)
      setInput(text)
      syncToParent(text)
      // Focus the input after inserting
      setTimeout(() => {
        richInputRef.current?.focus()
        // Move cursor to end
        richInputRef.current?.setSelectionRange(text.length, text.length)
      }, 0)
    }

    window.addEventListener('mortise:insert-text', handleInsertText as EventListener)
    return () => window.removeEventListener('mortise:insert-text', handleInsertText as EventListener)
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef])

  const handleToggleModelVision = useModelVisionToggle()

  // Listen for mortise:focus-input events (restore focus after popover/dropdown closes)
  React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId)
      }

      richInputRef.current?.focus()
      // Restore caret position if saved, then clear it (one-shot)
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current
        )
        lastCaretPositionRef.current = null
      }
    }

    window.addEventListener('mortise:focus-input', handleFocusInput)
    return () => window.removeEventListener('mortise:focus-input', handleFocusInput)
  }, [sessionId, isFocusedPanel, richInputRef])

  // Recover queued focus requests after session switch/mount races.
  React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return

    setTimeout(() => {
      richInputRef.current?.focus()
    }, 0)
  }, [sessionId, richInputRef])

  // Get the next available number for a pasted file prefix (e.g., pasted-image-1, pasted-image-2)
  const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[]
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`)
    let maxNum = 0
    for (const att of existingAttachments) {
      const match = att.name.match(pattern)
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    return maxNum + 1
  }

  // Listen for mortise:paste-files events (for global paste when input not focused)
  React.useEffect(() => {
    const handlePasteFiles = async (e: CustomEvent<{ files: File[]; sessionId?: string }>) => {
      if (disabled) return

      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const { files } = e.detail
      if (!files || files.length === 0) return

      setLoadingCount(prev => prev + files.length)

      // Pre-assign sequential names using ref to avoid race conditions
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
      const fileNames: string[] = files.map(file => {
        if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          return `pasted-image-${nextImageNum++}.${ext}`
        }
        return file.name
      })

      for (let i = 0; i < files.length; i++) {
        try {
          const attachment = await readFileAsAttachment(files[i], fileNames[i])
          if (attachment) {
            setAttachments(prev => [...prev, attachment])
          }
        } catch (error) {
          console.error('[FreeFormInput] Failed to process pasted file:', error)
        }
        setLoadingCount(prev => prev - 1)
      }

      // Focus the input after adding attachments
      richInputRef.current?.focus()
    }

    window.addEventListener('mortise:paste-files', handlePasteFiles as unknown as EventListener)
    return () => window.removeEventListener('mortise:paste-files', handlePasteFiles as unknown as EventListener)
  }, [disabled, sessionId, isFocusedPanel, richInputRef])

  // Permission selection remains in the composer footer; slash commands only
  // expose command-like actions that do not already have a dedicated control.
  const activeCommands = React.useMemo<SlashCommandId[]>(() => [], [])

  // pi 扩展命令：监听 extension_command_registered 事件并维护命令列表，
  // triggerCommand 通过 invokeExtensionCommand ElectronAPI 方法派发到子进程。
  const {
    commands: extensionCommands,
    refreshCommands: refreshExtensionCommands,
    triggerCommand: triggerExtensionCommand,
  } = useExtensionCommands(sessionId)

  // 将扩展命令转为 slash menu 可识别的 SlashCommand[]，id 使用 'ext:<name>' 前缀
  // 以便在 handleSlashCommand 中与内置命令区分。
  // 注：SlashCommand.id 受 SlashCommandId 联合类型约束，这里用类型断言注入。
  const extensionSections = React.useMemo<SlashSection[]>(() => {
    if (extensionCommands.length === 0) return []
    const items: SlashCommand[] = extensionCommands.map(cmd => ({
      id: `ext:${cmd.name}` as unknown as SlashCommandId,
      label: `/${cmd.name}`,
      description: cmd.description ?? cmd.source,
      icon: <Sparkles className="h-3.5 w-3.5" />,
    }))
    return [{
      id: 'pi-extensions',
      label: 'Pi Extensions',
      items,
    }]
  }, [extensionCommands])

  // Handle slash command selection (mode/feature commands)
  const handleSlashCommand = React.useCallback((commandId: SlashCommandId) => {
    // pi 扩展命令：id 形如 'ext:<name>'，触发后通过 invokeExtensionCommand 派发
    if (typeof commandId === 'string' && commandId.startsWith('ext:')) {
      const name = commandId.slice('ext:'.length)
      void triggerExtensionCommand(name).then(result => {
        if (!result.invoked) toast.error(`/${name} failed`, { description: result.error })
      })
      return
    }
    if (commandId === 'compact' && !isProcessing) onSubmit('/compact', undefined)
  }, [isProcessing, onSubmit, triggerExtensionCommand])

  // Handle folder selection from slash command menu
  const handleSlashFolderSelect = React.useCallback((path: string) => {
    if (onWorkingDirectoryChange) {
      setRecentFolders(addRecentWorkingDir(path, workspaceId))
      onWorkingDirectoryChange(path)
    }
  }, [onWorkingDirectoryChange, workspaceId])

  // Get recent folders and home directory for slash menu and mention menu
  const [recentFolders, setRecentFolders] = React.useState<string[]>([])
  const [homeDir, setHomeDir] = React.useState<string>('')

  React.useEffect(() => {
    setRecentFolders(getRecentWorkingDirs(workspaceId))
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

  // Inline slash command hook (modes, features, and folders)
  const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    onSelectFolder: handleSlashFolderSelect,
    activeCommands,
    recentFolders: onWorkingDirectoryChange ? recentFolders : [],
    homeDir,
    extraSections: extensionSections,
  })

  // Files and skills need no special handling beyond text insertion.
  const handleMentionSelect = React.useCallback((_item: MentionItem) => {}, [])

  // Inline mention hook (for skills and files)
  const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills,
    basePath: workingDirectory,
    onSelect: handleMentionSelect,
    // Use workspace slug (not UUID) for SDK skill qualification
    workspaceId: workspaceSlug,
  })

  // Report height changes to parent (for external animation sync)
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange])

  // In compact mode, immediately report collapsed height when the input is
  // collapsed during processing. This ensures smooth animation timing.
  // When the user expands (or processing ends), the ResizeObserver takes
  // over and reports the actual rendered height.
  React.useEffect(() => {
    if (!onHeightChange) return
    if (isCollapsedInCompact) {
      // Collapsed state - only bottom bar visible (~44px)
      onHeightChange(44)
    }
  }, [isCollapsedInCompact, onHeightChange])

  // Check if running in Electron environment (has electronAPI)
  const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

  // Shared helper: read a File, add as attachment, decrement loading count
  const processFileAttachment = async (file: File, overrideName?: string) => {
    try {
      const attachment = await readFileAsAttachment(file, overrideName)
      if (attachment) {
        setAttachments(prev => [...prev, attachment])
      }
    } catch (error) {
      console.error('[FreeFormInput] Failed to read file:', error)
    }
    setLoadingCount(prev => prev - 1)
  }

  // File attachment handlers
  const handleAttachClick = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setLoadingCount(prev => prev + fileList.length)

    for (const file of fileList) {
      await processFileAttachment(file)
    }

    // Reset input so re-selecting the same file triggers onChange again
    e.target.value = ''
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Helper to read a File using FileReader API
  const readFileAsAttachment = async (file: File, overrideName?: string): Promise<FileAttachment | null> => {
    // Capture the absolute OS path at attach time. Works for <input type="file"> and
    // OS drag-drop; returns null for clipboard paste and web-drag (no disk origin).
    // Local files are path-first so large attachments do not cross renderer RPC as base64.
    const realPath = hasElectronAPI ? window.electronAPI.getFilePath?.(file) ?? null : null

    if (file.size > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES) {
      console.warn(`[FreeFormInput] Attachment exceeds ${ATTACHMENT_SINGLE_FILE_LIMIT_BYTES} bytes: ${file.name}`)
      return null
    }

    let type: FileAttachment['type'] = 'unknown'
    const fileName = overrideName || file.name
    if (file.type.startsWith('image/')) type = 'image'
    else if (file.type === 'application/pdf') type = 'pdf'
    else if (file.type.includes('text') || fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)) type = 'text'
    else if (file.type.includes('officedocument') || fileName.match(/\.(docx?|xlsx?|pptx?)$/i)) type = 'office'

    const mimeType = file.type || 'application/octet-stream'

    if (realPath) {
      return {
        type,
        path: realPath,
        name: fileName,
        mimeType,
        size: file.size,
      }
    }

    if (file.size > ATTACHMENT_INLINE_RPC_LIMIT_BYTES) {
      console.info(`[FreeFormInput] Attachment without local path will use chunked upload: ${file.name}`)
    }

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer
        // Chunked base64 encoding — btoa + reduce fails on large files (>1MB)
        // due to O(n²) string concatenation and browser string-length limits
        const bytes = new Uint8Array(result)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
        }
        const base64 = btoa(binary)

        // For text files, decode the ArrayBuffer as UTF-8 text
        let text: string | undefined
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result))
        }

        let thumbnailBase64: string | undefined
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(base64, mimeType)
            if (thumb) thumbnailBase64 = thumb
          } catch {
            // Thumbnail generation is optional, continue without it
          }
        }

        resolve({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(file)
    })
  }

  // Clipboard paste handler for files/images
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return

    const clipboardItems = e.clipboardData?.files
    if (!clipboardItems || clipboardItems.length === 0) return

    // We have files to process - prevent default text paste behavior
    e.preventDefault()

    const files = Array.from(clipboardItems)
    setLoadingCount(prev => prev + files.length)

    // Pre-assign sequential names using ref to avoid race conditions
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
    const fileNames: string[] = files.map(file => {
      if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
        const ext = file.type.split('/')[1] || 'png'
        return `pasted-image-${nextImageNum++}.${ext}`
      }
      return file.name
    })

    for (let i = 0; i < files.length; i++) {
      await processFileAttachment(files[i], fileNames[i])
    }
  }

  // Handle long text paste - convert to file attachment
  const handleLongTextPaste = React.useCallback((text: string) => {
    const nextNum = getNextPastedNumber('text', attachmentsRef.current)
    const fileName = `pasted-text-${nextNum}.txt`
    const attachment: FileAttachment = {
      type: 'text',
      path: fileName,
      name: fileName,
      mimeType: 'text/plain',
      text: text,
      size: new Blob([text]).size,
    }
    setAttachments(prev => [...prev, attachment])
    // Focus input after adding attachment
    richInputRef.current?.focus()
  }, []) // No deps needed - uses ref

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingOver(false)
    if (disabled) return

    const files = Array.from(e.dataTransfer.files)
    setLoadingCount(files.length)

    for (const file of files) {
      await processFileAttachment(file)
    }
  }

  // Submit message - backend handles queueing and interruption
  const submitMessage = React.useCallback((midStreamSendIntent: MidStreamSendIntent = 'default') => {
    const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled) return false

    // Tutorial may disable sending to guide user through specific steps
    if (disableSend) return false

    const exactExtensionCommand = attachments.length === 0 && followUpItems.length === 0
      ? matchExactExtensionCommand(input, extensionCommands)
      : undefined
    if (exactExtensionCommand) {
      void triggerExtensionCommand(exactExtensionCommand.name).then(result => {
        if (!result.invoked) toast.error(`/${exactExtensionCommand.name} failed`, { description: result.error })
      })
      setInput('')
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
      onInputChange?.('')
      prevInputValueRef.current = ''
      requestAnimationFrame(() => richInputRef.current?.focus())
      return true
    }

    // Parse all @mentions (skills and folders)
    const skillSlugs = skills.map(s => s.slug)
    const mentions = parseMentions(input, skillSlugs)

    const attachmentSnapshot = attachments

    onSubmit(
      input.trim(),
      attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined,
      midStreamSendIntent,
    )
    setInput('')
    setAttachments([])
    // Clear draft immediately (cancel any pending debounced sync)
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    onAttachmentsChange?.([])
    prevInputValueRef.current = ''

    // Restore focus after state updates
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
    })

    return true
  }, [input, attachments, followUpItems, disabled, disableSend, extensionCommands, triggerExtensionCommand, onInputChange, onAttachmentsChange, onSubmit, skills, onWorkingDirectoryChange, homeDir])

  // Listen for mortise:submit-input events (simulate pressing the Send button)
  React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return
      submitMessage()
    }

    window.addEventListener('mortise:submit-input', handleSubmitInput as EventListener)
    return () => window.removeEventListener('mortise:submit-input', handleSubmitInput as EventListener)
  }, [sessionId, isFocusedPanel, submitMessage])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    submitMessage()
  }

  const handleStop = (silent = false) => {
    onStop?.(silent)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // During IME composition, ESC should cancel composition, not trigger app/menu ESC behavior.
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return
    }

    // Don't submit when mention menu is open AND has visible content
    if (inlineMention.isOpen) {
      // Only intercept navigation/selection keys if menu actually shows items or is loading
      const hasVisibleContent = inlineMention.sections.some(s => s.items.length > 0) || inlineMention.isSearching
      if (hasVisibleContent && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // These keys are handled by the InlineMentionMenu component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineMention.close()
        return
      }
    }

    // Don't submit when slash command menu is open - let it handle the Enter key
    if (inlineSlash.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // These keys are handled by the InlineSlashCommand component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineSlash.close()
        return
      }
    }

    const midStreamSendIntent = resolveMidStreamSendIntent(sendMessageKey, {
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      isComposing: e.nativeEvent.isComposing,
    })
    if (midStreamSendIntent) {
      e.preventDefault()
      submitMessage(midStreamSendIntent)
    }
    if (e.key === 'Escape') {
      // Skip blur if a popover/overlay is open — let the overlay handle ESC instead.
      // This prevents the input from consuming ESC when focus gets pulled back here
      // while a popover is still visible (portal DOM isolation means the event won't
      // reach the popover's DismissableLayer otherwise).
      if (!hasOpenOverlay()) {
        richInputRef.current?.blur()
      }
    }
  }

  // Handle input changes from RichTextInput
  const handleInputChange = React.useCallback((value: string) => {
    const nextValue = coerceInputText(value)
    setInput(nextValue)
    syncToParent(nextValue) // Debounced sync to parent for draft persistence
  }, [syncToParent])

  // Handle input with cursor position (for menu detection)
  const handleRichInput = React.useCallback((value: string, cursorPosition: number) => {
    const nextValue = coerceInputText(value)
    const textBeforeCursor = nextValue.slice(0, cursorPosition)

    if (/(?:^|\s)\/[\w:-]*$/.test(textBeforeCursor)) {
      refreshExtensionCommands()
    }

    // Update inline slash command state
    inlineSlash.handleInputChange(nextValue, cursorPosition)

    // Update inline mention state (for @mentions - skills, files, folders)
    inlineMention.handleInputChange(nextValue, cursorPosition)

    // Auto-capitalize first letter (but not for slash commands or @mentions)
    // Only if autoCapitalisation setting is enabled
    let newValue = nextValue
    if (autoCapitalisation && nextValue.length > 0 && nextValue.charAt(0) !== '/' && nextValue.charAt(0) !== '@' && nextValue.charAt(0) !== '#') {
      const capitalizedFirst = nextValue.charAt(0).toUpperCase()
      if (capitalizedFirst !== nextValue.charAt(0)) {
        newValue = capitalizedFirst + nextValue.slice(1)
        // Set cursor position BEFORE state update so it's used when useEffect syncs the value
        richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
        setInput(newValue)
        syncToParent(newValue)
        return
      }
    }

    // Apply smart typography (-> to →, etc.)
    const typography = applySmartTypography(nextValue, cursorPosition)
    if (typography.replaced) {
      newValue = typography.text
      // Set cursor position BEFORE state update so it's used when useEffect syncs the value
      richInputRef.current?.setSelectionRange(typography.cursor, typography.cursor)
      setInput(newValue)
      syncToParent(newValue)
    }
  }, [inlineSlash, inlineMention, syncToParent, autoCapitalisation, refreshExtensionCommands])

  // Handle inline slash command selection (removes the /command text)
  const handleInlineSlashCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    const newValue = inlineSlash.handleSelectCommand(commandId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline slash folder selection (inserts a directory badge)
  const handleInlineSlashFolderSelect = React.useCallback((path: string) => {
    const newValue = inlineSlash.handleSelectFolder(path)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline mention selection (inserts appropriate mention text)
  const handleInlineMentionSelect = React.useCallback((item: MentionItem) => {
    const { value: newValue, cursorPosition } = inlineMention.handleSelect(item)
    setInput(newValue)
    syncToParent(newValue)
    // Focus input and restore cursor position after badge renders
    setTimeout(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }, [inlineMention, syncToParent])

  const followUpLayoutKey = React.useMemo(
    () => followUpItems.map(item => [
      item.id,
      item.index ?? '',
      item.noteLabel,
      item.selectedText,
      item.color ?? '',
    ].join('::')).join('|'),
    [followUpItems]
  )
  const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null)
  const [animateFollowUpLayout, setAnimateFollowUpLayout] = React.useState(false)

  React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey

    if (previous == null || previous === followUpLayoutKey) return

    setAnimateFollowUpLayout(true)
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false)
    }, 220)

    return () => window.clearTimeout(timer)
  }, [followUpLayoutKey])

  const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
  const semanticSessionId = sessionId?.replace(/[^A-Za-z0-9._:-]/g, '_')
  const inputSemanticProps = useUiSemanticNode(semanticSessionId ? {
    id: `composer.${semanticSessionId}.input`,
    role: 'textbox',
    name: t('chatInput.placeholder.typeMessage'),
    value: input,
    sensitive: true,
    state: { disabled, readonly: disabled },
    actions: ['click', 'fill', 'clear', 'focus'],
    physicalActions: ['click', 'fill', 'press', 'shortcut', 'clipboard', 'ime', 'rich-text'],
    invoke: (action, payload) => {
      if (action === 'focus' || action === 'click') return richInputRef.current?.focus()
      handleInputChange(action === 'clear' ? '' : payload.value ?? '')
    },
  } : null)
  const sendSemanticProps = useUiSemanticNode(semanticSessionId ? {
    id: `composer.${semanticSessionId}.${isProcessing ? 'stop' : 'send'}`,
    role: 'button',
    name: isProcessing ? t('chat.stopResponse') : t('shortcuts.sendMessage'),
    state: { disabled: isProcessing ? false : !hasContent || disabled || disableSend, busy: isProcessing },
    actions: isProcessing ? ['click', 'stop'] : ['click', 'submit'],
    physicalActions: ['click', 'press'],
    invoke: action => {
      if (action === 'stop' || (action === 'click' && isProcessing)) handleStop(false)
      else submitMessage()
    },
  } : null)

  // Pre-flight image-support check: warn when staged images would be silently
  // stripped by Pi SDK because the active custom-endpoint model is text-only.
  // Gate on pi_compat — built-in catalogs (anthropic/pi) are owned by the SDK
  // and we can't repair them from the UI here.
  const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))
  const showVisionWarning =
    hasStagedImages
    && !!effectiveProviderDetails
    && true
    && !piProviderModelSupportsImages(effectiveProviderDetails!.provider, currentModel)

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden transition-all',
          // Container styling - only when not wrapped by InputContainer
          !unstyled && 'rounded-[16px] shadow-middle',
          !unstyled && 'bg-background',
          isDraggingOver && 'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-foreground/5'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Inline Slash Command Autocomplete */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          onSelectFolder={handleInlineSlashFolderSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
        />

        {/* Inline Mention Autocomplete (skills and files) */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          maxWidth={280}
          isSearching={inlineMention.isSearching}
        />

        {/* Pre-flight image-support warning — only for pi_compat connections
            where the renderer can both detect text-only models and offer to
            flip the per-model supportsImages override on the spot. */}
        {showVisionWarning && effectiveProviderDetails && (
          <ImageSupportWarningBanner
            modelName={currentModelDisplayName}
            onEnable={() => handleToggleModelVision(effectiveProviderDetails.key, currentModel, true)}
          />
        )}

        {/* Attachment Preview */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* Follow-up context chips */}
        <AnimatePresence initial={false}>
          {followUpItems.length > 0 && (
            <motion.div
              key="follow-up-chips"
              layout={animateFollowUpLayout}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <motion.div layout={animateFollowUpLayout} className="px-3 pt-3.5 pb-0">
                <motion.div layout={animateFollowUpLayout} className="flex flex-wrap gap-1">
                  <AnimatePresence initial={false}>
                    {followUpItems.map((item, idx) => {
                      const chipIndex = item.index ?? idx + 1
                      const tooltipText = item.selectedText.trim() || t('chat.selectedText')
                      const selectedExcerpt = formatFollowUpChipText(item.selectedText, t('chat.selectedText'), 50)
                      const noteExcerpt = formatFollowUpChipText(item.noteLabel, t('chat.followUp'), 50)

                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          layout={animateFollowUpLayout}
                          initial={{ opacity: 0, y: 6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.16, ease: [0.2, 0, 0.2, 1] }}
                          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[6px] bg-foreground/2 pl-1.5 pr-2 py-1 text-[13px] text-foreground/80 select-none transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            onFollowUpClick?.(item, {
                              x: rect.left + rect.width / 2,
                              y: rect.top - 8,
                            })
                          }}
                        >
                          <Tooltip delayDuration={250}>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-[4px] bg-background px-0.5 text-[10px] font-medium text-foreground shadow-minimal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  onFollowUpIndexClick?.(item)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onFollowUpIndexClick?.(item)
                                  }
                                }}
                              >
                                {chipIndex}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[420px] break-words text-xs">
                              {tooltipText}
                            </TooltipContent>
                          </Tooltip>
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap pr-0.5 text-left">
                            <span className="italic text-foreground/60">{selectedExcerpt}</span>
                            <span className="mx-1 text-foreground/40">·</span>
                            <span>{noteExcerpt}</span>
                          </span>
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rich Text Input with inline mention badges */}
        {/* In compact mode, hide input while the agent is processing — until the
            user clicks / hovers the collapsed bar to expand it back. */}
        {!isCollapsedInCompact && (
        <RichTextInput
          {...inputSemanticProps}
          data-mortise-ui-interactions="shortcut clipboard ime rich-text"
          ref={richInputRef}
          value={input}
          onChange={handleInputChange}
          onInput={handleRichInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onLongTextPaste={handleLongTextPaste}
          onFocus={() => { setIsFocused(true); onFocusChange?.(true) }}
          onBlur={() => {
            // Save caret position before losing focus (for restoration via mortise:focus-input)
            lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
            setIsFocused(false)
            onFocusChange?.(false)
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          skills={skills}
          workspaceId={workspaceSlug}
          className="pl-5 pr-4 pt-4 pb-3 overflow-y-auto min-h-[88px]"
          style={{ maxHeight: inputMaxHeight }}
          data-tutorial="chat-input"
          spellCheck={spellCheck}
        />
        )}

        {/* Bottom Row: Controls - wrapped in relative container for status slot overlay */}
        <div className="relative">
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          <div className={cn("flex items-center gap-1 px-2 py-2", !compactMode && "border-t border-border/50")}>
          {/* Hidden file input for attach button (shared by compact and desktop) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {/* Compact mode: standard icon badges plus the permission selector in the input footer.
              Wrapper absorbs all squeeze so the model label truncates first and the send button stays
              anchored to the right (mortise-oss#798). overflow-hidden is safe — Radix Drawer /
              dropdowns inside render via portals, so they aren't clipped. */}
          {compactMode && (
          <div className="flex items-center gap-1 min-w-0 shrink overflow-hidden">
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attach")
            }
            isExpanded={false}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />
          {onPermissionModeChange && (
            <CompactPermissionModeSelector
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
            />
          )}
          {enableCompactModelPicker && (
            <CompactModelSelector
              currentModel={currentModel}
              currentProvider={currentProvider}
              onModelChange={onModelChange}
              onProviderChange={onProviderChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={onThinkingLevelChange}
              isEmptySession={isEmptySession}
              providerUnavailable={providerUnavailable}
              contextStatus={contextStatus}
            />
          )}
          {onWorkingDirectoryChange && (
            <CompactWorkingDirectorySelector
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              isEmptySession={false}
              workspaceId={workspaceId}
            />
          )}
          </div>
          )}

          {/* Desktop: full badges row with labels and working directory */}
          {!compactMode && (
          <div className="flex items-center gap-1 min-w-32 shrink overflow-hidden">
          {/* 1. Attach Files Badge */}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attachFiles")
            }
            isExpanded={isEmptySession}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />

          {/* 2. Permission Mode Selector */}
          {onPermissionModeChange && (
            <CompactPermissionModeSelector
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
            />
          )}

          {/* 3. Working Directory Selector Badge */}
          {onWorkingDirectoryChange && (
            <WorkingDirectoryBadge
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              isEmptySession={isEmptySession}
              workspaceId={workspaceId}
            />
          )}
          </div>
          )}

          {/* Spacer — doubles as a tap / hover target while the input is
              collapsed during processing in compact mode, so the user can
              type a follow-up without waiting for the agent to finish. */}
          {isCollapsedInCompact ? (
            <button
              type="button"
              onClick={onRequestExpand}
              onMouseEnter={onRequestExpand}
              aria-label={t('chat.tapToType')}
              className="flex-1 h-7 mx-1 flex items-center justify-center text-foreground/30 hover:text-foreground/60 transition-colors cursor-pointer rounded-[6px] hover:bg-foreground/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex-1" />
          )}

          {/* Right side: Model + Send - never shrink so they're always visible */}
          <div className="flex items-center shrink-0">
          {/* Context usage ring - placed before model selector so it reads as
              "how full is the context" relative to the active model. */}
          <ContextUsageRing
            contextStatus={contextStatus}
            currentModel={currentModel}
            configuredContextWindow={configuredContextWindow}
          />
          {/* 5. Model/Connection Selector - Hidden in compact mode (EditPopover embedding) */}
          {!compactMode && (
          <DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "input-toolbar-btn inline-flex items-center h-7 px-1.5 gap-0.5 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none",
                      modelDropdownOpen && "bg-foreground/5",
                      providerUnavailable && "text-destructive",
                    )}
                  >
                    {providerUnavailable ? (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        {t('common.unavailable')}
                      </>
                    ) : (
                      <>
                        {effectiveProviderDetails && providerItems.length > 1 && storage.get(storage.KEYS.showProviderIcons, true) && <ProviderIcon provider={effectiveProviderDetails} size={14} showTooltip />}
                        {currentModelDisplayName}
                        {pickerMode !== 'locked-single' && <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />}
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('common.model')}
              </TooltipContent>
            </Tooltip>
            <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[260px]">
              {/* Connection unavailable message */}
              {pickerMode === 'unavailable' ? (
                <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                  <div className="font-medium text-sm mb-1">{t('chat.providerUnavailable')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('chat.providerUnavailableDescription')}
                  </div>
                </div>
              ) : pickerMode === 'locked-single' && providerDefaultModel ? (
                (() => {
                  // Single-model pi_compat connection on a non-empty session (or
                  // when there's only one connection, so no switcher to show).
                  // Model row is disabled (locked to this session); vision toggle
                  // remains interactive.
                  const showVisionToggle =
                    !!effectiveProviderDetails
                  const visionOn = showVisionToggle && piProviderModelSupportsImages(effectiveProviderDetails!.provider, providerDefaultModel)
                  return (
                    <StyledDropdownMenuItem
                      disabled
                      className="flex items-center justify-between px-2 py-2 rounded-lg"
                    >
                      <div className="text-left">
                        <div className="font-medium text-sm">{stripPiPrefixForDisplay(providerDefaultModel)}</div>
                        <div className="text-xs text-muted-foreground">{t('chat.providerDefault')}</div>
                      </div>
                      <div className="flex items-center gap-1 ml-3 shrink-0">
                        {showVisionToggle && effectiveProviderDetails && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                aria-label={visionOn
                                  ? t('chat.modelPicker.supportsImagesOn')
                                  : t('chat.modelPicker.supportsImagesOff')}
                                className="inline-flex items-center justify-center p-1 rounded pointer-events-auto opacity-100 hover:bg-foreground/5 cursor-pointer"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleToggleModelVision(effectiveProviderDetails.key, providerDefaultModel, !visionOn)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleToggleModelVision(effectiveProviderDetails.key, providerDefaultModel, !visionOn)
                                  }
                                }}
                              >
                                <ImageIcon className={cn(
                                  "h-3.5 w-3.5",
                                  visionOn ? "text-foreground/70" : "text-foreground/30"
                                )} />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {visionOn
                                ? t('chat.modelPicker.supportsImagesOn')
                                : t('chat.modelPicker.supportsImagesOff')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Check className="h-3 w-3 text-foreground" />
                      </div>
                    </StyledDropdownMenuItem>
                  )
                })()
              ) : pickerMode === 'switcher' ? (
                /* Hierarchical view: Provider → Connection → Models */
                providerGroups.map(([providerName, providers], index) => (
                  <React.Fragment key={providerName}>
                    {/* Provider group label */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide select-none">
                      {providerName}
                    </div>
                    {providers.map((conn) => {
                      const isCurrentProvider = effectiveProvider === conn.key
                      const isAuthenticated = true
                      return (
                        <DropdownMenuSub key={conn.key}>
                          <StyledDropdownMenuSubTrigger
                            disabled={!isAuthenticated}
                            className={cn(
                              "flex items-center justify-between px-2 py-2 rounded-lg",
                              isCurrentProvider && "bg-foreground/5"
                            )}
                          >
                            <div className="text-left flex-1">
                              <div className="font-medium text-sm flex items-center gap-1.5">
                                <ProviderIcon provider={conn} size={14} />
                                {conn.key}
                                {isCurrentProvider && <Check className="h-3 w-3 text-foreground" />}
                              </div>
                              {!isAuthenticated && (
                                <div className="text-xs text-muted-foreground">{t('settings.ai.notAuthenticated')}</div>
                              )}
                            </div>
                          </StyledDropdownMenuSubTrigger>
                          {isAuthenticated && (
                            <StyledDropdownMenuSubContent className="min-w-[220px]">
                              {/* Show models for this connection - use provider-specific models as fallback */}
                              {(conn.provider.models || ANTHROPIC_MODELS).map((model) => {
                                const modelId = typeof model === 'string' ? model : model.id
                                const modelName = typeof model === 'string'
                                  ? stripPiPrefixForDisplay(getModelShortName(model))
                                  : (model.name ?? stripPiPrefixForDisplay(model.id))
                                const isSelectedModel = isCurrentProvider && currentModel === modelId
                                const showVisionToggle = true
                                const visionOn = showVisionToggle && piProviderModelSupportsImages(conn.provider, modelId)
                                return (
                                  <StyledDropdownMenuItem
                                    key={modelId}
                                    onSelect={() => {
                                      // If selecting a different connection, update both connection and model
                                      if (!isCurrentProvider && onProviderChange) {
                                        onProviderChange(conn.key)
                                      }
                                      // Always pass connection with model for proper persistence
                                      onModelChange(modelId, conn.key)
                                    }}
                                    className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                                  >
                                    <div className="font-medium text-sm">{modelName}</div>
                                    <div className="flex items-center gap-1 ml-3 shrink-0">
                                      {showVisionToggle && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span
                                              role="button"
                                              tabIndex={0}
                                              aria-label={visionOn
                                                ? t('chat.modelPicker.supportsImagesOn')
                                                : t('chat.modelPicker.supportsImagesOff')}
                                              className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                                              onClick={(e) => {
                                                e.preventDefault()
                                                e.stopPropagation()
                                                handleToggleModelVision(conn.key, modelId, !visionOn)
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                  e.preventDefault()
                                                  e.stopPropagation()
                                                  handleToggleModelVision(conn.key, modelId, !visionOn)
                                                }
                                              }}
                                            >
                                              <ImageIcon className={cn(
                                                "h-3.5 w-3.5",
                                                visionOn ? "text-foreground/70" : "text-foreground/30"
                                              )} />
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            {visionOn
                                              ? t('chat.modelPicker.supportsImagesOn')
                                              : t('chat.modelPicker.supportsImagesOff')}
                                          </TooltipContent>
                                        </Tooltip>
                                      )}
                                      {isSelectedModel && (
                                        <Check className="h-3 w-3 text-foreground" />
                                      )}
                                    </div>
                                  </StyledDropdownMenuItem>
                                )
                              })}
                            </StyledDropdownMenuSubContent>
                          )}
                        </DropdownMenuSub>
                      )
                    })}
                    {index < providerGroups.length - 1 && (
                      <StyledDropdownMenuSeparator className="my-1" />
                    )}
                  </React.Fragment>
                ))
              ) : (
                /* Flat model list (single connection) */
                <>
                  {/* Indicator showing which connection is being used */}
                  {!isEmptySession && currentProviderDetails && providerItems.length > 1 && (
                    <>
                      <div className="flex items-center gap-2 px-2 py-1.5 text-xs select-none text-muted-foreground">
                        <span>{t('chat.usingProvider', { name: currentProviderDetails.key })}</span>
                      </div>
                      <StyledDropdownMenuSeparator className="my-1" />
                    </>
                  )}
                  {/* Model options based on effective connection's provider type */}
                  {availableModels.map((model) => {
                    const modelId = typeof model === 'string' ? model : model.id
                    const modelName = typeof model === 'string'
                      ? stripPiPrefixForDisplay(getModelShortName(model))
                      : (model.name ?? stripPiPrefixForDisplay(model.id))
                    const isSelected = currentModel === modelId
                    const descriptionKey = typeof model !== 'string' && 'descriptionKey' in model ? (model.descriptionKey as string) : undefined
                    const description = descriptionKey ? t(descriptionKey) : (typeof model !== 'string' && 'description' in model ? (model.description as string) : '')
                    const showVisionToggle =
                      !!effectiveProviderDetails
                    const visionOn = showVisionToggle && piProviderModelSupportsImages(effectiveProviderDetails!.provider, modelId)
                    return (
                      <StyledDropdownMenuItem
                        key={modelId}
                        onSelect={() => onModelChange(modelId, effectiveProvider)}
                        className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                      >
                        <div className="text-left">
                          <div className="font-medium text-sm">{modelName}</div>
                          {description && (
                            <div className="text-xs text-muted-foreground">{description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 ml-3 shrink-0">
                          {showVisionToggle && effectiveProviderDetails && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-label={visionOn
                                    ? t('chat.modelPicker.supportsImagesOn')
                                    : t('chat.modelPicker.supportsImagesOff')}
                                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleToggleModelVision(effectiveProviderDetails.key, modelId, !visionOn)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      handleToggleModelVision(effectiveProviderDetails.key, modelId, !visionOn)
                                    }
                                  }}
                                >
                                  <ImageIcon className={cn(
                                    "h-3.5 w-3.5",
                                    visionOn ? "text-foreground/70" : "text-foreground/30"
                                  )} />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {visionOn
                                  ? t('chat.modelPicker.supportsImagesOn')
                                  : t('chat.modelPicker.supportsImagesOff')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {isSelected && (
                            <Check className="h-3 w-3 text-foreground" />
                          )}
                        </div>
                      </StyledDropdownMenuItem>
                    )
                  })}
                </>
              )}

              {/* Thinking level selector — only shown when thinking levels are available
                  (Claude supports extended thinking, OpenAI backends may not) */}
              {availableThinkingLevels.length > 0 && (
                <>
                  <StyledDropdownMenuSeparator className="my-1" />

                  <DropdownMenuSub>
                    <StyledDropdownMenuSubTrigger disabled={thinkingDisabled} className={cn("flex items-center justify-between px-2 py-2 rounded-lg", thinkingDisabled && "opacity-50 cursor-not-allowed")}>
                      <div className="text-left flex-1">
                        <div className="font-medium text-sm">{t(getThinkingLevelNameKey(thinkingLevel))}</div>
                        <div className="text-xs text-muted-foreground">{thinkingDisabled ? t('thinking.notSupported') : t('thinking.extendedDesc')}</div>
                      </div>
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent className="min-w-[220px]">
                      {availableThinkingLevels.map(({ id, nameKey, descriptionKey }) => {
                        const isSelected = thinkingLevel === id
                        return (
                          <StyledDropdownMenuItem
                            key={id}
                            onSelect={() => onThinkingLevelChange?.(id)}
                            className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                          >
                            <div className="text-left">
                              <div className="font-medium text-sm">{t(nameKey)}</div>
                              <div className="text-xs text-muted-foreground">{t(descriptionKey)}</div>
                            </div>
                            {isSelected && (
                              <Check className="h-3 w-3 text-foreground shrink-0 ml-3" />
                            )}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}

              {/* Context usage footer - only show when we have token data */}
              {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
                <>
                  <StyledDropdownMenuSeparator className="my-1" />
                  <div className="px-2 py-1.5 select-none">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t('chat.context')}</span>
                      <span className="flex items-center gap-1.5">
                        {contextStatus.isCompacting && (
                          <Spinner className="h-3 w-3" />
                        )}
                        {t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </StyledDropdownMenuContent>
          </DropdownMenu>
          )}
          <CompactThinkingBadge
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={onThinkingLevelChange}
            disabled={thinkingDisabled}
          />

          {/* 5.5 Context Usage Warning Badge - shows when approaching auto-compaction threshold.
              Percentage matches the ring (full-window denominator); the trigger threshold
              is 80% of the compaction threshold (~62% of the full window) so the user is
              warned before the SDK auto-compacts at ~77.5% of the window. */}
          {(() => {
            const usage = getContextUsagePercent(
              contextStatus,
              currentModel,
              configuredContextWindow,
            )
            const usagePercent = usage.percent
            // Compaction triggers at ~77.5% of the window; warn at 80% of that.
            const warningThresholdPercent = Math.round(0.775 * 0.8 * 100) // ~62
            const showWarning = usagePercent !== null && usagePercent >= warningThresholdPercent && !contextStatus?.isCompacting

            if (!showWarning) return null

            const handleCompactClick = () => {
              if (!isProcessing) {
                onSubmit('/compact', [])
              }
            }

            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCompactClick}
                    disabled={isProcessing}
                    className="inline-flex items-center h-6 px-2 text-[12px] font-medium bg-info/10 rounded-[6px] shadow-tinted select-none cursor-pointer hover:bg-info/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      '--shadow-color': 'var(--info-rgb)',
                      color: 'color-mix(in oklab, var(--info) 30%, var(--foreground))',
                    } as React.CSSProperties}
                  >
                    {usagePercent}%
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isProcessing
                    ? `${usagePercent}% context used — wait for current operation`
                    : `${usagePercent}% context used — click to compact`
                  }
                </TooltipContent>
              </Tooltip>
            )
          })()}

          {/* 6. Send/Stop Button - Always show stop when processing */}
          {isProcessing ? (
            <Button
              {...sendSemanticProps}
              type="button"
              size="icon"
              variant="secondary"
              aria-label={t('chat.stopResponse')}
              className="send-btn h-7 w-7 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 ml-2"
              onClick={() => handleStop(false)}
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button
              {...sendSemanticProps}
              type="submit"
              size="icon"
              aria-label={t('shortcuts.sendMessage')}
              className="send-btn h-7 w-7 rounded-full shrink-0 ml-2"
              disabled={!hasContent || disabled || disableSend}
              data-tutorial="send-button"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          </div>
          </div>
        </div>
      </div>
    </form>
  )
}

/**
 * Format path for display, with home directory shortened
 */
function formatPathForDisplay(path: string | undefined, homeDir: string): string {
  if (!path) return ''
  let displayPath = path
  if (homeDir && path.startsWith(homeDir)) {
    const relativePath = path.slice(homeDir.length)
    // Remove leading separator if present, show root separator if empty
    displayPath = relativePath.startsWith(PATH_SEP)
      ? relativePath.slice(1)
      : (relativePath || PATH_SEP)
  }
  return `in ${displayPath}`
}

/**
 * WorkingDirectoryBadge - Context badge for selecting working directory
 * Uses cmdk for filterable folder list when there are more than 5 recent folders.
 */
function WorkingDirectoryBadge({
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  isEmptySession = false,
  workspaceId,
}: {
  workingDirectory?: string
  onWorkingDirectoryChange: (path: string) => void
  sessionFolderPath?: string
  isEmptySession?: boolean
  workspaceId?: string
}) {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const closePopover = React.useCallback(() => setPopoverOpen(false), [])

  const {
    homeDir,
    gitBranch,
    filter,
    setFilter,
    sortedRecent: filteredRecent,
    hasFolder,
    folderName,
    showReset,
    showFilter,
    handleSelectRecent,
    handleReset,
    handleRemoveRecent,
    handleChooseFolder,
    serverBrowser: {
      showServerBrowser,
      serverBrowserMode,
      cancelServerBrowser,
      confirmServerBrowser,
    },
  } = useWorkingDirectoryState({
    workingDirectory,
    onWorkingDirectoryChange,
    sessionFolderPath,
    workspaceId,
    isOpen: popoverOpen,
    onClose: closePopover,
  })

  // Autofocus the filter input on popover open. Lives in the consumer (not
  // the hook) because the compact drawer surface has no autofocus.
  React.useEffect(() => {
    if (popoverOpen && showFilter) {
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [popoverOpen, showFilter])

  // Styles matching todo-filter-menu.tsx for consistency
  const MENU_CONTAINER_STYLE = 'min-w-[200px] max-w-[400px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'
  const MENU_LIST_STYLE = 'max-h-[200px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
  const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] outline-none'

  return (
    <>
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <span className="shrink min-w-0 overflow-hidden">
          <FreeFormInputContextBadge
            icon={<Icon_Home className="h-4 w-4" />}
            label={folderName ?? 'Work in Folder'}
            isExpanded={isEmptySession}
            hasSelection={hasFolder}
            showChevron={true}
            isOpen={popoverOpen}
            tooltip={
              hasFolder ? (
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{t("chat.workingDirectory")}</span>
                  <span className="text-xs opacity-70">{formatPathForDisplay(workingDirectory, homeDir)}</span>
                  {gitBranch && <span className="text-xs opacity-70">{t("chat.onBranch", { branch: gitBranch })}</span>}
                </span>
              ) : t("chat.chooseWorkingDirectory")
            }
          />
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className={MENU_CONTAINER_STYLE}>
        <CommandPrimitive shouldFilter={showFilter}>
          {/* Filter input - only shown when more than 5 recent folders */}
          {showFilter && (
            <div className="border-b border-border/50 px-3 py-2">
              <CommandPrimitive.Input
                ref={inputRef}
                value={filter}
                onValueChange={setFilter}
                placeholder={t("chat.filterFolders")}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 placeholder:select-none"
              />
            </div>
          )}

          <CommandPrimitive.List className={MENU_LIST_STYLE}>
            {/* Current Folder Display - shown at top with checkmark */}
            {hasFolder && (
              <CommandPrimitive.Item
                value={`current-${workingDirectory}`}
                className={cn(MENU_ITEM_STYLE, 'pointer-events-none bg-foreground/5')}
                disabled
              >
                <Icon_Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate">
                  <span>{folderName}</span>
                  <span className="text-muted-foreground ml-1.5">{formatPathForDisplay(workingDirectory, homeDir)}</span>
                </span>
                <Check className="h-4 w-4 shrink-0" />
              </CommandPrimitive.Item>
            )}

            {/* Separator after current folder */}
            {hasFolder && filteredRecent.length > 0 && (
              <div className="h-px bg-border my-1 mx-1" />
            )}

            {/* Recent Directories - filterable (current directory already filtered out via filteredRecent) */}
            {filteredRecent.map((path) => {
              const recentFolderName = getPathBasename(path) || 'Folder'
              return (
                <CommandPrimitive.Item
                  key={path}
                  value={`${recentFolderName} ${path}`}
                  onSelect={() => handleSelectRecent(path)}
                  className={cn(MENU_ITEM_STYLE, 'group/item data-[selected=true]:bg-foreground/5')}
                >
                  <Icon_Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">
                    <span>{recentFolderName}</span>
                    <span className="text-muted-foreground ml-1.5">{formatPathForDisplay(path, homeDir)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => handleRemoveRecent(e, path)}
                    data-touch-reveal="true"
                    className="shrink-0 h-3 w-3 rounded-[3px] flex items-center justify-center opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-all"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </CommandPrimitive.Item>
              )
            })}

            {/* Empty state when filtering */}
            {showFilter && (
              <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                {t('chat.noFoldersFound')}
              </CommandPrimitive.Empty>
            )}
          </CommandPrimitive.List>

          {/* Bottom actions - always visible, outside scrollable area */}
          <div className="border-t border-border/50 p-1">
            <button
              type="button"
              onClick={handleChooseFolder}
              className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
            >
              {t('chat.chooseFolder')}
            </button>
            {showReset && (
              <button
                type="button"
                onClick={handleReset}
                className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
              >
                {t('common.reset')}
              </button>
            )}
          </div>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
    <ServerDirectoryBrowser
      open={showServerBrowser}
      mode={serverBrowserMode}
      onSelect={confirmServerBrowser}
      onCancel={cancelServerBrowser}
      initialPath={workingDirectory}
    />
    </>
  )
}
