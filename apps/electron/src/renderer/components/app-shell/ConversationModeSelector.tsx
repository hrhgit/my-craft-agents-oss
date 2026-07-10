import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ClipboardList,
  MessageSquare,
  PencilLine,
} from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'

export type ConversationMode = 'normal' | 'discuss' | 'plan'

const CONVERSATION_MODE_OPTIONS: Array<{
  id: ConversationMode
  labelKey: string
  descriptionKey: string
  icon: React.ComponentType<{ className?: string }>
  className: string
  iconClassName: string
  shadowVar: string
}> = [
  {
    id: 'normal',
    labelKey: 'chat.conversationMode.normal',
    descriptionKey: 'chat.conversationMode.normalDesc',
    icon: PencilLine,
    className: 'bg-foreground/5 text-foreground/70',
    iconClassName: 'text-foreground/70',
    shadowVar: 'var(--foreground-rgb)',
  },
  {
    id: 'discuss',
    labelKey: 'chat.conversationMode.discuss',
    descriptionKey: 'chat.conversationMode.discussDesc',
    icon: MessageSquare,
    className: 'bg-info/10 text-info',
    iconClassName: 'text-info',
    shadowVar: 'var(--info-rgb)',
  },
  {
    id: 'plan',
    labelKey: 'chat.conversationMode.plan',
    descriptionKey: 'chat.conversationMode.planDesc',
    icon: ClipboardList,
    className: 'bg-accent/5 text-accent',
    iconClassName: 'text-accent',
    shadowVar: 'var(--accent-rgb)',
  },
]

interface ConversationModeSelectorProps {
  mode: ConversationMode
  onModeChange?: (mode: ConversationMode) => void
  showDiscussion?: boolean
  showPlan?: boolean
  sessionId?: string
}

export function normalizeConversationMode(value: unknown): ConversationMode {
  return value === 'discuss' || value === 'plan' ? value : 'normal'
}

export function ConversationModeSelector({
  mode,
  onModeChange,
  showDiscussion = true,
  showPlan = true,
  sessionId,
}: ConversationModeSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const options = React.useMemo(
    () => CONVERSATION_MODE_OPTIONS.filter(option => {
      if (option.id === 'discuss') return showDiscussion
      if (option.id === 'plan') return showPlan
      return true
    }),
    [showDiscussion, showPlan],
  )
  const displayMode = options.some(option => option.id === mode) ? mode : 'normal'
  const selected = CONVERSATION_MODE_OPTIONS.find(option => option.id === displayMode) ?? CONVERSATION_MODE_OPTIONS[0]
  const SelectedIcon = selected.icon

  const handleSelect = React.useCallback((nextMode: ConversationMode) => {
    onModeChange?.(nextMode)
    setOpen(false)
  }, [onModeChange])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('chat.conversationMode.ariaLabel', { mode: t(selected.labelKey) })}
          data-tutorial="conversation-mode-dropdown"
          className={cn(
            'h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px] flex items-center gap-1.5 shadow-tinted outline-none select-none',
            selected.className,
          )}
          style={{ '--shadow-color': selected.shadowVar } as React.CSSProperties}
        >
          <SelectedIcon className="h-3.5 w-3.5" />
          <span>{t(selected.labelKey)}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent
        className="min-w-[220px]"
        side="top"
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('craft:focus-input', {
              detail: { sessionId },
            }))
          }
        }}
      >
        {options.map(option => {
          const Icon = option.icon
          const isSelected = option.id === displayMode
          return (
            <StyledDropdownMenuItem
              key={option.id}
              onSelect={() => handleSelect(option.id)}
              className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon className={cn('h-4 w-4 shrink-0', option.iconClassName)} />
                <div className="min-w-0 text-left">
                  <div className="text-sm font-medium">{t(option.labelKey)}</div>
                  <div className="text-xs text-muted-foreground truncate">{t(option.descriptionKey)}</div>
                </div>
              </div>
              {isSelected && <Check className="h-3.5 w-3.5 shrink-0 ml-3 text-foreground/60" />}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
