/**
 * SidebarMenu - Shared menu content for sidebar navigation items
 *
 * Used by:
 * - LeftSidebar (context menu via right-click on nav items)
 * - AppShell (context menu for New Chat button)
 *
 * Uses MenuComponents context to render with either DropdownMenu or ContextMenu
 * primitives, allowing the same component to work in both scenarios.
 *
 * Provides actions based on the sidebar item type:
 * - "Mark All Read" (for allSessions)
 * - "Add Skill" (for skills) - triggers EditPopover callback
 * - "Open in New Window" (for newSession only) - uses deep link
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  AppWindow,
  CheckCheck,
  Plus,
  ExternalLink,
  Trash2,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getDocUrl } from '@mortise/shared/docs/doc-links'

export type SidebarMenuType = 'allSessions' | 'skills' | 'automations' | 'newSession' | 'workspace'

export interface SidebarMenuProps {
  /** Type of sidebar item (determines available menu items) */
  type: SidebarMenuType
  /** Handler for "Mark All Read" action - only for allSessions type */
  onMarkAllRead?: () => void
  /** Handler for "Add Skill" action - only for skills type */
  onAddSkill?: () => void
  /** Handler for "Add Automation" action - only for automations type */
  onAddAutomation?: () => void
  isActiveWorkspace?: boolean
  onOpenWorkspaceInNewWindow?: () => void
  onRemoveWorkspace?: () => void
}

/**
 * SidebarMenu - Renders the menu items for sidebar navigation actions
 * This is the content only, not wrapped in a DropdownMenu or ContextMenu
 */
export function SidebarMenu({
  type,
  onMarkAllRead,
  onAddSkill,
  onAddAutomation,
  isActiveWorkspace,
  onOpenWorkspaceInNewWindow,
  onRemoveWorkspace,
}: SidebarMenuProps) {
  const { t } = useTranslation()

  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator } = useMenuComponents()

  // New Session: only shows "Open in New Window"
  if (type === 'newSession') {
    return (
      <MenuItem onClick={() => window.electronAPI.openUrl('mortise://action/new-session?window=focused')}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>
    )
  }

  if (type === 'allSessions' && onMarkAllRead) {
    return (
      <MenuItem onClick={onMarkAllRead}>
        <CheckCheck className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.markAllRead")}</span>
      </MenuItem>
    )
  }

  if (type === 'workspace') {
    if (isActiveWorkspace) return null
    return (
      <>
        {onOpenWorkspaceInNewWindow && (
          <MenuItem onClick={onOpenWorkspaceInNewWindow}>
            <AppWindow className="h-3.5 w-3.5" />
            <span className="flex-1">{t('sidebarMenu.openInNewWindow')}</span>
          </MenuItem>
        )}
        {onOpenWorkspaceInNewWindow && onRemoveWorkspace && <Separator />}
        {onRemoveWorkspace && (
          <MenuItem onClick={onRemoveWorkspace}>
            <Trash2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t('workspace.removeWorkspace')}</span>
          </MenuItem>
        )}
      </>
    )
  }

  // Skills: show "Add Skill"
  if (type === 'skills' && onAddSkill) {
    return (
      <MenuItem onClick={onAddSkill}>
        <Plus className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.addSkill")}</span>
      </MenuItem>
    )
  }

  // Automations: show "Add Automation" and "Learn More"
  if (type === 'automations') {
    return (
      <>
        {onAddAutomation && (
          <MenuItem onClick={onAddAutomation}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addAutomation")}</span>
          </MenuItem>
        )}
        <Separator />
        <MenuItem onClick={() => window.electronAPI.openUrl(getDocUrl('automations'))}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sidebarMenu.learnMoreAutomations")}</span>
        </MenuItem>
      </>
    )
  }

  // Fallback: return null if no handler provided (shouldn't happen)
  return null
}
