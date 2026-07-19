import type { LucideIcon } from "lucide-react"
import * as React from "react"
import { AnimatePresence, motion, type Variants } from "motion/react"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '@/components/ui/styled-dropdown'
import { ContextMenuProvider, DropdownMenuProvider } from '@/components/ui/menu-context'
import { SidebarMenu, type SidebarMenuType } from './SidebarMenu'
import { HoverRevealIcon } from '@/components/ui/HoverRevealIcon'
import { FadingText } from '@/components/ui/fading-text'

/** Context menu configuration for sidebar items */
export interface SidebarContextMenuConfig {
  /** Type of sidebar item (determines available menu items) */
  type: SidebarMenuType
  /** Handler for "Mark All Read" action - for allSessions type */
  onMarkAllRead?: () => void
  /** Handler for "Add Source" action - for sources type */
  onAddSource?: () => void
  /** Handler for "Add Skill" action - for skills type */
  onAddSkill?: () => void
  /** Handler for "Add Automation" action - for automations type */
  onAddAutomation?: () => void
  /** Source type filter for "Learn More" link - determines which docs page to open */
  sourceType?: 'api' | 'mcp' | 'local'
  /** Workspace actions for nested workspace rows. */
  isActiveWorkspace?: boolean
  onOpenWorkspaceInNewWindow?: () => void
  onRemoveWorkspace?: () => void
}

export interface LinkItem {
  id: string            // Unique ID for navigation (e.g., 'nav:allSessions')
  title: string
  label?: string        // Optional badge (e.g., count)
  icon?: LucideIcon | React.ReactNode  // LucideIcon or custom React element
  iconColor?: string    // Optional color class for the icon
  /** Whether the icon responds to color (uses currentColor). Default true for Lucide icons. */
  iconColorable?: boolean
  variant: "default" | "ghost"  // "default" = highlighted, "ghost" = subtle
  /** Visual hierarchy inside the primary sidebar. */
  tone?: "navigation" | "workspace" | "session"
  onClick?: () => void
  // Expandable item properties
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  items?: SidebarItem[]    // Subitems as data (rendered as nested LeftSidebar) - supports separators
  // Compact mode: stable 28px row height for workspace and session lists
  compact?: boolean
  // Tutorial system
  dataTutorial?: string // data-tutorial attribute for tutorial targeting
  // Context menu configuration (optional - if provided, right-click shows context menu)
  contextMenu?: SidebarContextMenuConfig
  /** Shared dropdown/context-menu content. When provided, the row gains the
   *  same hover-revealed ellipsis and right-click behavior as entity lists. */
  menuContent?: React.ReactNode
  // Optional element rendered after the title (e.g., label type icon), revealed on hover
  afterTitle?: React.ReactNode
  /** Always-visible trailing status, such as unread/remote/active workspace state. */
  accessory?: React.ReactNode
}

export interface SeparatorItem {
  id: string
  type: 'separator'
}

export type SidebarItem = LinkItem | SeparatorItem

export const isSeparatorItem = (item: SidebarItem): item is SeparatorItem =>
  'type' in item && item.type === 'separator'

interface LeftSidebarProps {
  isCollapsed: boolean
  links: SidebarItem[]
  /** Get props for each item (from unified sidebar navigation) */
  getItemProps?: (id: string) => {
    tabIndex: number
    'data-focused': boolean
    ref: (el: HTMLElement | null) => void
  }
  /** Currently focused item ID */
  focusedItemId?: string | null
  /** Whether this is a nested sidebar (child of expandable item) */
  isNested?: boolean
}

// Stagger animation for child items
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.01,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.015,
      staggerDirection: -1,
    },
  },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: 'easeOut' },
  },
  exit: {
    opacity: 0,
    x: -8,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
}

/**
 * LeftSidebar - Vertical list of navigation buttons with icons
 *
 * Navigation is managed by the parent component (Chat.tsx) for unified
 * sidebar keyboard navigation. This component just renders the items.
 *
 * Styling matches agent items in the sidebar for consistency:
 * - py-[7px] px-2 text-[13px] rounded-md
 * - Icon: h-3.5 w-3.5
 *
 * Link variants:
 * - "default": Highlighted style (used for active/selected items)
 * - "ghost": Subtle style (used for inactive items)
 *
 * Expandable items:
 * - Show a chevron toggle on hover (replaces icon position)
 * - Children are rendered with animated expand/collapse
 * - Nested items have left indentation with vertical line
 *
 */
export function LeftSidebar({ links, isCollapsed, getItemProps, focusedItemId, isNested }: LeftSidebarProps) {
  // For nested sidebars, wrap in motion container for stagger effect
  const NavWrapper = isNested ? motion.nav : 'nav'
  const navProps = isNested ? {
    variants: containerVariants,
    initial: 'hidden',
    animate: 'visible',
    exit: 'exit',
  } : {}

  return (
    <div className={cn("flex min-w-0 flex-col select-none", !isNested && "py-1")}>
      <NavWrapper
        data-mortise-semantic-id={isNested ? undefined : 'navigation.main'}
        className={cn(
          "grid min-w-0 gap-0.5",
          isNested ? "pl-5 pr-0 relative" : "px-2"
        )}
        role="navigation"
        aria-label={isNested ? "Sub navigation" : "Main navigation"}
        {...navProps}
      >
        {links.map((item) => {
          // Handle separator items
          if (isSeparatorItem(item)) {
            return (
              <div key={item.id} className="py-1 px-2" aria-hidden="true">
                <div className="h-px bg-foreground/5" />
              </div>
            )
          }

          const link = item
          const itemProps = getItemProps?.(link.id)
          const isFocused = focusedItemId === link.id

          // Render nested content for expanded items.
          const hasExpandedItems = Boolean(link.expandable && link.items?.length)
          const expandedContent = hasExpandedItems && link.expanded
            ? renderExpandedContent(link, getItemProps, focusedItemId)
            : null

          const content = (
            <SidebarLinkRow
              link={link}
              itemProps={itemProps}
              expandedContent={expandedContent}
              hasExpandedItems={hasExpandedItems}
              isNested={isNested}
            />
          )

          // For nested items, wrap in motion.div for stagger animation
          return isNested ? (
            <motion.div key={link.id} variants={itemVariants} className="min-w-0">
              {content}
            </motion.div>
          ) : (
            <React.Fragment key={link.id}>
              {content}
            </React.Fragment>
          )
        })}
      </NavWrapper>
    </div>
  )
}

function SidebarLinkRow({
  link,
  itemProps,
  expandedContent,
  hasExpandedItems,
  isNested,
}: {
  link: LinkItem
  itemProps?: SidebarButtonProps['itemProps']
  expandedContent: React.ReactNode
  hasExpandedItems: boolean
  isNested?: boolean
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false)
  const hasContextMenu = Boolean(link.menuContent || link.contextMenu)
  const semanticId = `navigation.${link.id.replace(/[^A-Za-z0-9._-]/g, '_')}`

  const buttonElement = <SidebarButton link={link} itemProps={itemProps} />

  const configuredContextMenu = link.contextMenu ? (
    <SidebarMenu
      type={link.contextMenu.type}
      onMarkAllRead={link.contextMenu.onMarkAllRead}
      onAddSource={link.contextMenu.onAddSource}
      onAddSkill={link.contextMenu.onAddSkill}
      onAddAutomation={link.contextMenu.onAddAutomation}
      sourceType={link.contextMenu.sourceType}
      isActiveWorkspace={link.contextMenu.isActiveWorkspace}
      onOpenWorkspaceInNewWindow={link.contextMenu.onOpenWorkspaceInNewWindow}
      onRemoveWorkspace={link.contextMenu.onRemoveWorkspace}
    />
  ) : null

  return (
    <div
      className="group/section min-w-0"
      data-menu-open={(menuOpen || contextMenuOpen) || undefined}
    >
      <div className="relative min-w-0">
        {hasContextMenu ? (
          <ContextMenu modal={true} onOpenChange={setContextMenuOpen}>
            <ContextMenuTrigger asChild>
              {buttonElement}
            </ContextMenuTrigger>
            <StyledContextMenuContent>
              <ContextMenuProvider>
                {link.menuContent ?? configuredContextMenu}
              </ContextMenuProvider>
            </StyledContextMenuContent>
          </ContextMenu>
        ) : (
          buttonElement
        )}

        {link.menuContent && (
          <div
            data-touch-reveal="true"
            className={cn(
              "absolute inset-y-0 right-1 z-10 flex items-center transition-opacity",
              menuOpen || contextMenuOpen
                ? "opacity-100"
                : "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100",
            )}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu modal={true} open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-mortise-semantic-id={`${semanticId}.menu`}
                  aria-label={`${t('common.more')}: ${link.title}`}
                  className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted-foreground outline-none hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                <DropdownMenuProvider>{link.menuContent}</DropdownMenuProvider>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* Expandable subitems stay outside the context-menu trigger so opening
        * one row never highlights the entire workspace subtree. */}
      {hasExpandedItems && (
        <AnimatePresence initial={false}>
          {link.expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
              animate={{ height: 'auto', opacity: 1, marginTop: 1, marginBottom: isNested ? 3 : 6 }}
              exit={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              {expandedContent}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

// ============================================================
// Expanded Content Renderer
// Renders regular nested sidebar content.
// ============================================================

function renderExpandedContent(
  link: LinkItem,
  getItemProps: LeftSidebarProps['getItemProps'],
  focusedItemId: string | null | undefined
): React.ReactNode {
  return (
    <LeftSidebar
      isCollapsed={false}
      isNested={true}
      getItemProps={getItemProps}
      focusedItemId={focusedItemId}
      links={link.items!}
    />
  )
}

// ============================================================
// SidebarButton
// ============================================================

interface SidebarButtonProps {
  link: LinkItem
  itemProps?: {
    tabIndex: number
    'data-focused': boolean
    ref: (el: HTMLElement | null) => void
  }
}

// forwardRef is required so Radix's ContextMenuTrigger (asChild) can attach its ref
// and pass props like data-state="open" directly onto this button element.
const SidebarButton = React.forwardRef<HTMLButtonElement, SidebarButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ link, itemProps, className: extraClassName, ...radixProps }, forwardedRef) => {
    const { ref: _itemRef, ...itemButtonProps } = itemProps || { ref: undefined }
    return (
      <button
        data-mortise-semantic-id={`navigation.${link.id.replace(/[^A-Za-z0-9._-]/g, '_')}`}
        {...itemButtonProps}
        // Spread Radix props (data-state, onContextMenu, onPointerDown, etc.)
        {...radixProps}
        ref={(el) => {
          // Merge forwarded ref (from Radix) and itemProps ref (for keyboard nav)
          if (typeof forwardedRef === 'function') forwardedRef(el)
          else if (forwardedRef) forwardedRef.current = el
          if (itemProps?.ref) itemProps.ref(el)
        }}
        onClick={link.onClick}
        data-tutorial={link.dataTutorial}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-[6px] text-[13px] leading-5 select-none outline-none",
          "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          link.compact ? "h-7" : "h-8",
          "px-2",
          link.menuContent && "pr-8",
          link.tone === "workspace" && "font-medium text-foreground/85",
          link.tone === "session" && "text-foreground/75",
          link.variant === "default"
            ? "bg-foreground/[0.07] text-foreground"
            // Highlight on hover, context menu open (data-state), or EditPopover active (data-edit-active)
            : "hover:bg-foreground/[0.045] data-[state=open]:bg-foreground/[0.055] group-data-[menu-open=true]/section:bg-foreground/[0.055] data-[edit-active=true]:bg-foreground/[0.055]",
          extraClassName,
        )}
      >
        {/* Icon container with hover toggle for expandable items */}
        {link.icon && (
          <span className="relative h-3.5 w-3.5 shrink-0 flex items-center justify-center">
            {link.expandable ? (
              <>
                {/* Main icon - hidden on hover */}
                <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity duration-150">
                  {renderIcon(link)}
                </span>
                {/* Toggle chevron - shown on hover. data-no-dnd prevents drag activation on click. */}
                <HoverRevealIcon
                  icon={ChevronRight}
                  dataNoDnd
                  dataTouchReveal
                  onClick={(e) => {
                    e.stopPropagation()
                    link.onToggle?.()
                  }}
                  iconClassName={cn(
                    "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                    link.expanded && "rotate-90"
                  )}
                />
              </>
            ) : (
              renderIcon(link)
            )}
          </span>
        )}
        <FadingText className="min-w-0 flex-1 text-left" fadeWidth={22} title={link.title}>
          {link.title}
        </FadingText>
        {link.accessory && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {link.accessory}
          </span>
        )}
        {/* After-title element: type indicator icon, right-aligned before count badge, revealed on hover */}
        {link.afterTitle && (
          <span data-touch-reveal="true" className={cn(link.accessory ? 'ml-0' : 'ml-auto', 'opacity-0 group-hover/section:opacity-100 group-data-[state=open]:opacity-100 group-data-[menu-open=true]/section:opacity-100 group-data-[edit-active=true]:opacity-100 transition-opacity')}>
            {link.afterTitle}
          </span>
        )}
        {/* Label Badge: Shows count or status on the right, revealed on section hover */}
        {link.label && (
          <span data-touch-reveal="true" className={cn(link.afterTitle || link.accessory ? 'ml-0' : 'ml-auto', 'text-xs text-foreground/30 opacity-0 group-hover/section:opacity-100 group-data-[state=open]:opacity-100 group-data-[menu-open=true]/section:opacity-100 group-data-[edit-active=true]:opacity-100 transition-opacity')}>
            {link.label}
          </span>
        )}
      </button>
    )
  }
)

/**
 * Helper to render icon - either component (function/forwardRef) or React element.
 * Colors are always applied via inline style (resolved CSS color strings from EntityColor).
 */
function renderIcon(link: LinkItem) {
  const isComponent = typeof link.icon === 'function' ||
    (typeof link.icon === 'object' && link.icon !== null && 'render' in link.icon)
  // Default color for items without explicit iconColor (foreground at 60% opacity)
  const defaultColor = 'color-mix(in oklch, var(--foreground) 60%, transparent)'

  // Lucide components are always colorable; ReactNode icons check iconColorable
  // Default to true for backwards compatibility (most icons are colorable)
  const applyColor = link.iconColorable !== false
  const colorStyle = applyColor ? { color: link.iconColor || defaultColor } : undefined

  if (isComponent) {
    const Icon = link.icon as React.ComponentType<{ className?: string; style?: React.CSSProperties }>
    return (
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        style={colorStyle}
      />
    )
  }
  // Already a React element or primitive ReactNode
  // Clone with bare={true} to remove EntityIcon container, wrapper provides sizing
  // Only pass bare to components that accept it (have acceptsBare marker) to avoid
  // forwarding unknown props to DOM elements (e.g., Lucide icons → SVG)
  const iconElement = link.icon as React.ReactNode
  const bareIcon = React.isValidElement(iconElement)
    ? (typeof iconElement.type === 'function' && (iconElement.type as { acceptsBare?: boolean }).acceptsBare)
      ? React.cloneElement(iconElement as React.ReactElement<{ bare?: boolean }>, { bare: true })
      : iconElement
    : iconElement
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
      style={colorStyle}
    >
      {bareIcon}
    </span>
  )
}
