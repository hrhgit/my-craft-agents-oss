import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import {
  PERMISSION_MODE_CONFIG,
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from '@craft-agent/shared/agent/modes'

// ============================================================================
// Mode Icon (same SVG pattern as ActiveOptionBadges.PermissionModeIcon)
// ============================================================================

function ModeIcon({ mode, className }: { mode: PermissionMode; className?: string }) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

// ============================================================================
// Trigger chip styling per mode (matches desktop PermissionModeDropdown)
// ============================================================================

const MODE_STYLES: Record<PermissionMode, { className: string; shadowVar: string }> = {
  safe: {
    className: 'bg-foreground/5 text-foreground/60',
    shadowVar: 'var(--foreground-rgb)',
  },
  ask: {
    className: 'bg-info/10 text-info',
    shadowVar: 'var(--info-rgb)',
  },
  'allow-all': {
    className: 'bg-accent/5 text-accent',
    shadowVar: 'var(--accent-rgb)',
  },
}

// ============================================================================
// Component
// ============================================================================

interface CompactPermissionModeSelectorProps {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
}

export function CompactPermissionModeSelector({
  permissionMode,
  onPermissionModeChange,
}: CompactPermissionModeSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // Optimistic local state — updates immediately, syncs with prop
  const [optimisticMode, setOptimisticMode] = React.useState(permissionMode)

  React.useEffect(() => {
    setOptimisticMode(permissionMode)
  }, [permissionMode])

  const handleSelect = React.useCallback((mode: PermissionMode) => {
    setOptimisticMode(mode)
    onPermissionModeChange?.(mode)
    setOpen(false)
  }, [onPermissionModeChange])

  const style = MODE_STYLES[optimisticMode]
  const labelKeyByMode: Record<PermissionMode, string> = {
    safe: 'mode.explore',
    ask: 'mode.ask',
    'allow-all': 'mode.execute',
  }
  const descriptionKeyByMode: Record<PermissionMode, string> = {
    safe: 'mode.exploreFullDesc',
    ask: 'mode.askFullDesc',
    'allow-all': 'mode.executeFullDesc',
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Permission mode: ${t(labelKeyByMode[optimisticMode])}`}
          className={cn(
            "h-7 pl-2 pr-2.5 text-xs font-medium rounded-[6px] flex items-center gap-1.5 shadow-tinted outline-none select-none shrink-0",
            style.className,
          )}
          style={{ '--shadow-color': style.shadowVar } as React.CSSProperties}
        >
          <ModeIcon mode={optimisticMode} className="h-3.5 w-3.5" />
          <span>{t(labelKeyByMode[optimisticMode])}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent side="top" align="start" sideOffset={4} className="min-w-[220px]">
        {PERMISSION_MODE_ORDER.map((mode) => {
          const isSelected = mode === optimisticMode
          return (
            <StyledDropdownMenuItem
              key={mode}
              onSelect={() => handleSelect(mode)}
              className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn("shrink-0", PERMISSION_MODE_CONFIG[mode].colorClass.text)}>
                  <ModeIcon mode={mode} className="h-4 w-4" />
                </span>
                <div className="min-w-0 text-left">
                  <div className="text-sm font-medium">{t(labelKeyByMode[mode])}</div>
                  <div className="text-xs text-muted-foreground truncate">{t(descriptionKeyByMode[mode])}</div>
                </div>
              </div>
              {isSelected && (
                <Check className="h-3.5 w-3.5 shrink-0 ml-3 text-foreground/60" />
              )}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
