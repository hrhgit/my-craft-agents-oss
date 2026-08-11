import * as React from 'react'
import { useTranslation } from "react-i18next"
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
import { Spinner } from '@mortise/ui'

import * as storage from '@/lib/local-storage'
import { Button } from '@/components/ui/button'
import type { SlashCommandId, SlashCommand, SlashSection } from '@/components/ui/slash-command-menu'
import { useExtensionCommands } from '@/hooks/useExtensionCommands'
import type { MentionItemType } from '@/components/ui/mention-menu'
import { parseMentions } from '@/lib/mentions'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
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
import { cn } from '@/lib/utils'
import { coerceInputText } from '@/lib/input-text'
import { measureComposerPerformance } from '@/lib/composer-performance'
import { isMac } from '@/lib/platform'
import { AttachmentPreview } from '../AttachmentPreview'
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner'
import { ANTHROPIC_MODELS, getModelShortName, getModelDisplayName, type ModelDefinition } from '@config/models'
import { piProviderModelSupportsImages } from '@mortise/shared/config/pi-provider-models'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { ProviderIcon } from '@/components/icons/ProviderIcon'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { derivePickerMode } from './picker-mode'
import { matchExactExtensionCommand } from './extension-command-submit'
import type { FileAttachment, LoadedSkill } from '../../../../shared/types'
import type { MidStreamSendIntent } from '@mortise/shared/protocol'
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
  shouldRestoreComposerSubmission,
  snapshotComposerSubmission,
  type ComposerSubmissionAttempt,
} from './composer-submission'
import { CompactModelSelector } from './CompactModelSelector'
import { ExtensionContributionZone } from '@/components/extensions/ExtensionContributionZone'
import { ExtensionFrontendZone } from '@/components/extensions/ExtensionFrontendZone'
import { BasicComposerTextarea, InputControlFallback } from './DegradedComposer'
import { InputErrorBoundary, IsolatedInputSection } from './InputErrorBoundary'
import {
  formatTokenCount,
  groupProviders,
  resolveEffectiveProvider,
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import {
  getConnectionModelContextWindow,
  getContextUsagePercent,
  isContextWarning,
} from './context-usage'
import { useModelVisionToggle } from './useModelVisionToggle'
import { getEventIsComposing, resolveMidStreamSendIntent } from './midstream-shortcuts'
import {
  ComposerSuggestionMenus,
  type ComposerSuggestionMenusHandle,
} from './ComposerSuggestionMenus'

// The ProseMirror runtime is intentionally kept out of the renderer's static
// entry graph. The composer already has a local basic-text fallback, so the
// editor can be fetched while the input shell remains responsive.
const RichTextInput = React.lazy(async () => {
  const module = await import('./ComposerEditor')
  return { default: module.ComposerEditor }
})

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
  isProcessing = false,
  onRequestCompact,
}: {
  contextStatus?: FreeFormInputProps['contextStatus']
  currentModel: string
  configuredContextWindow?: number
  isProcessing?: boolean
  onRequestCompact?: () => void
}) {
  const { t } = useTranslation()
  const usage = getContextUsagePercent(contextStatus, currentModel, configuredContextWindow)
  const percent = usage.percent ?? 0
  const radius = 5
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - percent / 100)
  // Approaching auto-compaction is signaled by color (red ring) rather than a
  // number badge; the warning ring doubles as the click-to-compact affordance.
  const isWarning = isContextWarning(usage, contextStatus?.isCompacting)

  const ring = (
    <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={isWarning ? 0.45 : 0.22}
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={isWarning ? 2.5 : 2}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
      />
    </svg>
  )

  const tooltip = isWarning
    ? isProcessing
      ? `${percent}% context used — wait for current operation`
      : `${percent}% context used — click to compact`
    : usage.inputTokens && usage.contextWindow
      ? `${formatTokenCount(usage.inputTokens)} / ${formatTokenCount(usage.contextWindow)} tokens (${usage.percent}%)`
      : 'Context usage unavailable'

  const baseClassName =
    "h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-full transition-colors"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {isWarning ? (
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => { if (!isProcessing) onRequestCompact?.() }}
            aria-label={`${percent}% ${t('chat.context')}`}
            className={cn(
              baseClassName,
              "text-destructive shadow-tinted cursor-pointer select-none hover:bg-destructive/10",
              isProcessing && "opacity-60 cursor-not-allowed",
            )}
            style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
          >
            {ring}
          </button>
        ) : (
          <div
            aria-label={usage.percent === null ? t('chat.context') : `${usage.percent}% ${t('chat.context')}`}
            className={cn(baseClassName, "text-foreground/65")}
          >
            {ring}
          </div>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltip}
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
          className="h-8 px-2 shrink-0 inline-flex items-center gap-1 rounded-[6px] text-[13px] text-foreground/65 hover:bg-foreground/5 disabled:opacity-40"
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
  onSubmit: (attempt: ComposerSubmissionAttempt) => Promise<boolean>
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: (silent?: boolean) => void
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle>
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes provider key for proper persistence) */
  onModelChange: (model: string, provider?: string) => void
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
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
  /** Canonical workspace root used for file and skill resolution. */
  workspaceRoot?: string
  /** Session ID for scoping session-bound events */
  sessionId?: string
  /** Stable non-session scope used only for composer validation semantics. */
  semanticScopeId?: string
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
   * selector alongside other compact composer controls. Defaults to false so that
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
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  skills = [],
  workspaceId,
  workspaceRoot,
  sessionId,
  semanticScopeId,
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

  // Stable editor handle shared by external callers, draft restoration and
  // suggestion menus. It is intentionally created before the text mutators.
  const internalInputRef = React.useRef<RichTextInputHandle>(null)
  const richInputRef = externalInputRef || internalInputRef
  const suggestionMenusRef = React.useRef<ComposerSuggestionMenusHandle>(null)

  // The editor owns the live body text. React only keeps a seed snapshot for
  // external draft/session changes and the empty/non-empty boundary used by
  // the send affordance. Ordinary transactions never update this component.
  const initialInput = coerceInputText(inputValue)
  const initialAttachments = attachmentsValue ?? []
  const [hasTextContent, setHasTextContent] = React.useState(initialInput.trim().length > 0)
  const [attachments, setAttachmentsState] = React.useState<FileAttachment[]>(initialAttachments)
  const composerTextRef = React.useRef(initialInput)
  const attachmentsRef = React.useRef<FileAttachment[]>(initialAttachments)
  const composerRevisionRef = React.useRef(0)

  const readComposerText = React.useCallback(() => {
    const nextValue = coerceInputText(richInputRef.current?.value ?? composerTextRef.current)
    composerTextRef.current = nextValue
    return nextValue
  }, [richInputRef])

  const setInput = React.useCallback((next: React.SetStateAction<string>) => {
    const currentValue = typeof next === 'function' ? readComposerText() : composerTextRef.current
    const value = typeof next === 'function' ? next(currentValue) : next
    if (value === composerTextRef.current) return
    composerTextRef.current = value
    composerRevisionRef.current += 1
    setHasTextContent(value.trim().length > 0)
    richInputRef.current?.setValue(value)
  }, [readComposerText, richInputRef])

  const setAttachments = React.useCallback((next: React.SetStateAction<FileAttachment[]>) => {
    const value = typeof next === 'function' ? next(attachmentsRef.current) : next
    if (value === attachmentsRef.current || (value.length === 0 && attachmentsRef.current.length === 0)) return
    attachmentsRef.current = value
    composerRevisionRef.current += 1
    setAttachmentsState(value)
  }, [])

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)

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
  }, [attachmentsValue, attachmentsRefsKey, setAttachments])

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
  }, [inputValue, setInput])

  // Debounced sync to parent (saves draft without blocking typing)
  const syncTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncToParent = React.useCallback((knownValue?: string) => {
    if (!onInputChange) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      const value = measureComposerPerformance('draft-snapshot', () => {
        const snapshot = knownValue ?? readComposerText()
        onInputChange(snapshot)
        return snapshot
      })
      prevInputValueRef.current = value
    }, 300) // Debounce 300ms
  }, [onInputChange, readComposerText])

  const flushToParent = React.useCallback(() => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current)
      syncTimeoutRef.current = null
    }
    if (!onInputChange) return
    const value = measureComposerPerformance('draft-snapshot', () => readComposerText())
    if (value === prevInputValueRef.current) return
    onInputChange(value)
    prevInputValueRef.current = value
  }, [onInputChange, readComposerText])

  const handleEditorTransaction = React.useCallback(({ isEmpty }: { isEmpty: boolean }) => {
    composerRevisionRef.current += 1
    const hasText = !isEmpty
    setHasTextContent(previous => previous === hasText ? previous : hasText)
    syncToParent()
  }, [syncToParent])

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  React.useEffect(() => {
    return () => {
      // Cancel pending debounced sync
      flushToParent()
    }
  }, [flushToParent])

  const [isDraggingOver, setIsDraggingOver] = React.useState(false)
  const [loadingCount, setLoadingCount] = React.useState(0)
  const [isFocused, setIsFocused] = React.useState(false)
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540)
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // Input settings (loaded from config)
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(false)
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

  // Track last caret position for focus restoration after composer popovers close.
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
  }, [sessionId, isFocusedPanel, setInput, syncToParent, richInputRef])

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

  // Extension controls remain in the composer footer; slash commands only
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
    if (commandId === 'compact' && !isProcessing) {
      void onSubmit(snapshotComposerSubmission({
        composerText: '/compact',
        message: '/compact',
      }))
    }
  }, [isProcessing, onSubmit, triggerExtensionCommand])

  // Compact request from the context usage ring warning state (red ring).
  const handleRequestCompact = React.useCallback(() => {
    if (isProcessing) return
    void onSubmit(snapshotComposerSubmission({
      composerText: '/compact',
      message: '/compact',
    }))
  }, [isProcessing, onSubmit])

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
  }, [richInputRef, setAttachments])

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
    const currentInput = readComposerText()
    const hasContent = currentInput.trim() || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled) return false

    // Tutorial may disable sending to guide user through specific steps
    if (disableSend) return false

    const exactExtensionCommand = attachments.length === 0 && followUpItems.length === 0
      ? matchExactExtensionCommand(currentInput, extensionCommands)
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
    const mentions = parseMentions(currentInput, skillSlugs)

    const attachmentSnapshot = attachments

    const attempt = snapshotComposerSubmission({
      composerText: currentInput,
      message: currentInput.trim(),
      attachments: attachmentSnapshot,
      skillSlugs: mentions.skills,
      midStreamSendIntent,
    })
    const completion = onSubmit(attempt)
    setInput('')
    setAttachments([])
    // Clear draft immediately (cancel any pending debounced sync)
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    onAttachmentsChange?.([])
    prevInputValueRef.current = ''
    const clearedRevision = composerRevisionRef.current

    void completion.then(accepted => {
      if (accepted) return
      if (!shouldRestoreComposerSubmission({
        clearedRevision,
        currentRevision: composerRevisionRef.current,
        currentText: composerTextRef.current,
        currentAttachmentCount: attachmentsRef.current.length,
      })) return
      setInput(attempt.composerText)
      setAttachments(attempt.attachments?.map(attachment => ({ ...attachment })) ?? [])
      onInputChange?.(attempt.composerText)
      onAttachmentsChange?.(attempt.attachments?.map(attachment => ({ ...attachment })) ?? [])
      prevInputValueRef.current = attempt.composerText
    }).catch(() => {
      // ChatDisplay converts send rejection into an unaccepted completion. Keep
      // this guard for alternate consumers that reject directly.
      if (!shouldRestoreComposerSubmission({
        clearedRevision,
        currentRevision: composerRevisionRef.current,
        currentText: composerTextRef.current,
        currentAttachmentCount: attachmentsRef.current.length,
      })) return
      setInput(attempt.composerText)
      setAttachments(attempt.attachments?.map(attachment => ({ ...attachment })) ?? [])
      onInputChange?.(attempt.composerText)
      onAttachmentsChange?.(attempt.attachments?.map(attachment => ({ ...attachment })) ?? [])
      prevInputValueRef.current = attempt.composerText
    })

    // Restore focus after state updates
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
    })

    return true
  }, [attachments, followUpItems, disabled, disableSend, extensionCommands, triggerExtensionCommand, onInputChange, onAttachmentsChange, onSubmit, readComposerText, richInputRef, setAttachments, setInput, skills])

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
    // handleDOMEvents (rich editor) delivers the raw DOM KeyboardEvent, which has no React
    // `nativeEvent`; the raw event exposes `isComposing` directly.
    if (e.key === 'Escape' && getEventIsComposing(e)) {
      return
    }

    if (suggestionMenusRef.current?.handleKeyDown(e)) return

    const midStreamSendIntent = resolveMidStreamSendIntent(sendMessageKey, {
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      isComposing: getEventIsComposing(e),
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
    if (nextValue === composerTextRef.current) return
    composerTextRef.current = nextValue
    composerRevisionRef.current += 1
    const nextHasText = nextValue.trim().length > 0
    setHasTextContent(previous => previous === nextHasText ? previous : nextHasText)
    syncToParent(nextValue)
  }, [syncToParent])

  const applyEditorValue = React.useCallback((nextValue: string, cursorPosition?: number) => {
    const currentValue = readComposerText()
    if (nextValue === currentValue) return

    let start = 0
    while (start < currentValue.length && start < nextValue.length && currentValue[start] === nextValue[start]) start += 1

    let currentEnd = currentValue.length
    let nextEnd = nextValue.length
    while (currentEnd > start && nextEnd > start && currentValue[currentEnd - 1] === nextValue[nextEnd - 1]) {
      currentEnd -= 1
      nextEnd -= 1
    }

    const editorHandle = richInputRef.current
    if (editorHandle?.replaceTextRange) {
      editorHandle.replaceTextRange(start, currentEnd, nextValue.slice(start, nextEnd))
    } else {
      handleInputChange(nextValue)
      editorHandle?.setValue(nextValue)
    }
    if (cursorPosition !== undefined) richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
  }, [handleInputChange, readComposerText, richInputRef])

  const handleComposerFocus = React.useCallback(() => {
    setIsFocused(true)
    onFocusChange?.(true)
  }, [onFocusChange])

  const handleComposerBlur = React.useCallback(() => {
    lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
    flushToParent()
    setIsFocused(false)
    onFocusChange?.(false)
  }, [flushToParent, onFocusChange, richInputRef])

  const handleSuggestionChange = React.useCallback((
    kind: 'slash' | 'mention',
    value: string,
    cursorPosition: number,
  ) => {
    suggestionMenusRef.current?.update(kind, value, cursorPosition)
  }, [])

  const handleSuggestionExit = React.useCallback((kind: 'slash' | 'mention') => {
    suggestionMenusRef.current?.exit(kind)
  }, [])

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

  const hasContent = hasTextContent || attachments.length > 0 || followUpItems.length > 0
  const semanticComposerScopeId = (sessionId ?? semanticScopeId)?.replace(/[^A-Za-z0-9._:-]/g, '_')
  const inputSemanticProps = useUiSemanticNode(semanticComposerScopeId ? {
    id: `composer.${semanticComposerScopeId}.input`,
    role: 'textbox',
    name: t('chatInput.placeholder.typeMessage'),
    value: composerTextRef.current,
    sensitive: true,
    state: { disabled, readonly: disabled },
    actions: ['click', 'fill', 'clear', 'focus'],
    physicalActions: ['click', 'fill', 'press', 'shortcut', 'clipboard', 'ime', 'rich-text'],
    invoke: (action, payload) => {
      if (action === 'focus' || action === 'click') return richInputRef.current?.focus()
      setInput(action === 'clear' ? '' : payload.value ?? '')
    },
  } : null)
  const sendSemanticProps = useUiSemanticNode(semanticComposerScopeId ? {
    id: `composer.${semanticComposerScopeId}.${isProcessing ? 'stop' : 'send'}`,
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
  // Gate on pi_custom — built-in catalogs (anthropic/pi) are owned by the SDK
  // and we can't repair them from the UI here.
  const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))
  const showVisionWarning =
    hasStagedImages
    && !!effectiveProviderDetails
    && true
    && !piProviderModelSupportsImages(effectiveProviderDetails!.provider, currentModel)

  return (
    <form onSubmit={handleSubmit} data-mortise-ui-anchor="composer.root">
      <div
        ref={containerRef}
        className={cn(
          'overflow-visible transition-all',
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
        <ComposerSuggestionMenus
          ref={suggestionMenusRef}
          inputRef={richInputRef}
          skills={skills}
          workspaceRoot={workspaceRoot}
          workspaceId={workspaceSlug}
          activeCommands={activeCommands}
          extensionSections={extensionSections}
          onRefreshExtensionCommands={refreshExtensionCommands}
          onSelectSlashCommand={handleSlashCommand}
          onApplyEditorValue={applyEditorValue}
        />

        {/* Pre-flight image-support warning — only for pi_custom connections
            where the renderer can both detect text-only models and offer to
            flip the per-model supportsImages override on the spot. */}
        {showVisionWarning && effectiveProviderDetails && (
          <InputErrorBoundary
            sessionId={sessionId}
            resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::image-warning`}
            section="image-warning"
            fallback={null}
          >
            <ImageSupportWarningBanner
              modelName={currentModelDisplayName}
              onEnable={() => handleToggleModelVision(effectiveProviderDetails.key, currentModel, true)}
            />
          </InputErrorBoundary>
        )}

        {/* Attachment Preview */}
        <InputErrorBoundary
          sessionId={sessionId}
          resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::attachments`}
          section="attachments"
          fallback={({ retry }) => (
            <div className="flex justify-end px-2 pt-2">
              <InputControlFallback onRetry={retry} />
            </div>
          )}
        >
          <AttachmentPreview
            attachments={attachments}
            onRemove={handleRemoveAttachment}
            disabled={disabled}
            loadingCount={loadingCount}
          />
        </InputErrorBoundary>

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
          <InputErrorBoundary
            sessionId={sessionId}
            resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::rich-text`}
            section="rich-text"
            fallback={({ retry }) => (
              <BasicComposerTextarea
                ref={richInputRef}
                value={composerTextRef.current}
                onValueChange={handleInputChange}
                onSubmit={() => submitMessage()}
                onPaste={event => { void handlePaste(event) }}
                onFocus={handleComposerFocus}
                onBlur={handleComposerBlur}
                placeholder={Array.isArray(effectivePlaceholder) ? effectivePlaceholder[0] : effectivePlaceholder}
                disabled={disabled}
                maxHeight={inputMaxHeight}
                onRetry={retry}
              />
            )}
          >
            <React.Suspense
              fallback={(
                <BasicComposerTextarea
                  ref={richInputRef}
                  value={composerTextRef.current}
                  onValueChange={handleInputChange}
                  onSubmit={() => submitMessage()}
                  onPaste={event => { void handlePaste(event) }}
                  onFocus={handleComposerFocus}
                  onBlur={handleComposerBlur}
                  placeholder={Array.isArray(effectivePlaceholder) ? effectivePlaceholder[0] : effectivePlaceholder}
                  disabled={disabled}
                  maxHeight={inputMaxHeight}
                />
              )}
            >
              <RichTextInput
                {...inputSemanticProps}
                data-mortise-ui-interactions="shortcut clipboard ime rich-text"
                ref={richInputRef}
                value={composerTextRef.current}
                onTransaction={handleEditorTransaction}
                onSuggestionChange={handleSuggestionChange}
                onSuggestionExit={handleSuggestionExit}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onLongTextPaste={handleLongTextPaste}
                onFocus={handleComposerFocus}
                onBlur={handleComposerBlur}
                placeholder={effectivePlaceholder}
                disabled={disabled}
                autoCapitalisation={autoCapitalisation}
                skills={skills}
                workspaceId={workspaceSlug}
                className="min-h-[72px] overflow-y-auto pb-2 pl-5 pr-4 pt-3"
                style={{ maxHeight: inputMaxHeight }}
                data-tutorial="chat-input"
                spellCheck={spellCheck}
              />
            </React.Suspense>
          </InputErrorBoundary>
        )}

        {/* Bottom Row: Controls - wrapped in relative container for status slot overlay */}
        <div className="relative">
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <InputErrorBoundary
            sessionId={sessionId}
            resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::toolbar-status`}
            section="toolbar-status"
            fallback={null}
          >
            <ToolbarStatusSlot
              showEscapeOverlay={isProcessing && showEscapeOverlay}
              sessionId={sessionId}
            />
          </InputErrorBoundary>

          <div
            className="flex items-center gap-1 px-2 py-2"
            data-mortise-ui-anchor="composer.toolbar"
          >
          {/* Hidden file input for attach button (shared by compact and desktop) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {/* Compact mode: standard icon badges plus extension toolbar controls.
              Keep overflow visible because extension-owned menus render inside their scoped root. */}
          {compactMode && (
          <div className="flex items-center gap-1 min-w-0 shrink overflow-visible">
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
          {sessionId && <ExtensionContributionZone className="w-auto shrink-0" sessionId={sessionId} surface="composer.toolbar" />}
          <ExtensionFrontendZone className="contents" sessionId={sessionId} workspaceId={workspaceId} surface="composer.toolbar" />
          {enableCompactModelPicker && (
            <InputErrorBoundary
              sessionId={sessionId}
              resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::compact-model`}
              section="compact-model"
              fallback={({ retry }) => <InputControlFallback onRetry={retry} />}
            >
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
            </InputErrorBoundary>
          )}
          </div>
          )}

          {/* Desktop: full badges row with labels and working directory */}
          {!compactMode && (
          <div className="flex items-center gap-1 min-w-32 shrink overflow-visible">
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
          {sessionId && <ExtensionContributionZone className="w-auto shrink-0" sessionId={sessionId} surface="composer.toolbar" />}
          <ExtensionFrontendZone className="contents" sessionId={sessionId} workspaceId={workspaceId} surface="composer.toolbar" />

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
              className="flex-1 h-8 mx-1 flex items-center justify-center text-foreground/45 hover:text-foreground/70 transition-colors cursor-pointer rounded-[6px] hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex-1" />
          )}

          {/* Right side: Model + Send - never shrink so they're always visible */}
          <div className="flex items-center shrink-0">
          {/* Context usage ring - placed before model selector so it reads as
              "how full is the context" relative to the active model. Once usage
              crosses the pre-compaction warning threshold (~62% of the window)
              it turns red and becomes the click-to-compact affordance. */}
          <InputErrorBoundary
            sessionId={sessionId}
            resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::context-usage`}
            section="context-usage"
            fallback={null}
          >
            <ContextUsageRing
              contextStatus={contextStatus}
              currentModel={currentModel}
              configuredContextWindow={configuredContextWindow}
              isProcessing={isProcessing}
              onRequestCompact={handleRequestCompact}
            />
          </InputErrorBoundary>
          {/* 5. Model/Connection Selector - Hidden in compact mode (EditPopover embedding) */}
          {!compactMode && (
          <InputErrorBoundary
            sessionId={sessionId}
            resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::model-selector`}
            section="model-selector"
            fallback={({ retry }) => <InputControlFallback onRetry={retry} />}
          >
          <IsolatedInputSection render={() => (
          <DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "input-toolbar-btn inline-flex items-center h-8 px-2 gap-1 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none",
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
                  // Single-model pi_custom connection on a non-empty session (or
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
          )} />
          </InputErrorBoundary>
          )}
          <InputErrorBoundary
            sessionId={sessionId}
            resetKey={`${sessionId ?? semanticScopeId ?? 'composer'}::thinking`}
            section="thinking"
            fallback={({ retry }) => <InputControlFallback onRetry={retry} />}
          >
            <CompactThinkingBadge
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={onThinkingLevelChange}
              disabled={thinkingDisabled}
            />
          </InputErrorBoundary>

          {/* 6. Send/Stop Button - Always show stop when processing */}
          {isProcessing ? (
            <Button
              {...sendSemanticProps}
              type="button"
              size="icon"
              variant="secondary"
              aria-label={t('chat.stopResponse')}
              className="send-btn h-10 w-10 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 ml-2 shadow-[var(--shadow-control)]"
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
              className="send-btn h-10 w-10 rounded-full shrink-0 ml-2 shadow-[var(--shadow-control)]"
              disabled={!hasContent || disabled || disableSend}
              data-tutorial="send-button"
            >
              <ArrowUp className="h-[18px] w-[18px]" />
            </Button>
          )}
          </div>
          </div>
        </div>
      </div>
    </form>
  )
}
