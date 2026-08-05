/**
 * SettingsNavigator
 *
 * Navigator panel content for settings. Displays a list of settings sections
 * (App, Workspace, Shortcuts, Preferences) that can be selected to show in the details panel.
 *
 * Styling follows SessionList/SourcesListPanel patterns for visual consistency.
 */

import { useCallback, useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, AppWindow } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { DropdownMenuProvider } from '@/components/ui/menu-context'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { SettingsSubpage } from '../../../shared/types'
import { SETTINGS_ITEMS } from '../../../shared/menu-schema'
import { SETTINGS_ICONS, getExtensionSettingsIcon } from '@/components/icons/SettingsIcons'
import { createExtensionSettingsSubpage } from '../../../shared/settings-registry'
import type { PiExtensionCatalogEntry } from '@mortise/shared/config'

interface ExtensionPageItem {
  extension: PiExtensionCatalogEntry
  page: { id: string; title: string; description?: string; icon?: string; order?: number }
}

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'navigator',
}

interface SettingsNavigatorProps {
  /**
   * Currently selected settings subpage. `null` means the bare `settings`
   * route (no row highlighted) — happens in compact mode where the navigator
   * stands alone before the user drills into a subpage.
   */
  selectedSubpage: SettingsSubpage | null
  /** Called when a subpage is selected */
  onSelectSubpage: (subpage: SettingsSubpage) => void
}

interface SettingsItem {
  id: SettingsSubpage
  label: string
  icon: React.ComponentType<{ className?: string }>
  description: string
}

interface SettingsItemRowProps {
  item: SettingsItem
  isSelected: boolean
  isFirst: boolean
  onSelect: () => void
}

/**
 * SettingsItemRow - Individual settings item with dropdown menu
 * Tracks menu open state to keep "..." button visible when menu is open
 */
function SettingsItemRow({ item, isSelected, isFirst, onSelect }: SettingsItemRowProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const Icon = item.icon

  // Open settings page in a new window via deep link
  const handleOpenInNewWindow = () => {
    window.electronAPI.openUrl(`mortise://settings/${item.id}?window=focused`)
  }

  return (
    <div className="settings-item" data-selected={isSelected || undefined}>
      {/* Separator - only show if not first */}
      {!isFirst && (
        <div className="settings-separator pl-12 pr-4">
          <Separator />
        </div>
      )}
      {/* Wrapper for button with proper margins */}
      <div className="settings-content relative group select-none pl-2 mr-2">
        {/* Icon - positioned absolutely for consistent alignment */}
        <div className="absolute left-[20px] top-[15px] z-10">
          <Icon
            className={cn(
              'w-[18px] h-[18px] shrink-0',
              isSelected ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
        </div>
        {/* Main content button */}
        <button
          data-mortise-semantic-id={`settings.${item.id}`}
          type="button"
          onClick={onSelect}
          className={cn(
            'flex w-full items-start gap-2 pl-2 pr-4 py-3 text-left text-sm outline-none rounded-[8px]',
            // Fast hover transition (75ms vs default 150ms)
            'transition-[background-color] duration-75',
            isSelected
              ? 'bg-foreground/5 hover:bg-foreground/7'
              : 'hover:bg-foreground/2'
          )}
        >
          {/* Spacer for icon */}
          <div className="w-6 h-5 shrink-0" />
          {/* Content column */}
          <div className="flex flex-col min-w-0 flex-1">
            <span
              className={cn(
                'font-medium',
                isSelected ? 'text-foreground' : 'text-foreground/80'
              )}
            >
              {item.label}
            </span>
            <span className="text-[13px] text-foreground/65 line-clamp-1">
              {item.description}
            </span>
          </div>
        </button>
        {/* Action buttons - visible on hover or when menu is open */}
        <div
          data-touch-reveal="true"
          className={cn(
            'absolute right-2 top-2.5 transition-opacity z-10',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <div className="flex items-center rounded-[8px] overflow-hidden border border-transparent hover:border-border/50">
            <DropdownMenu modal={true} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <div className="flex size-8 items-center justify-center hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </div>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                <DropdownMenuProvider>
                  <StyledDropdownMenuItem onClick={handleOpenInNewWindow}>
                    <AppWindow className="h-3.5 w-3.5" />
                    <span className="flex-1">{t("sessionMenu.openInNewWindow")}</span>
                  </StyledDropdownMenuItem>
                </DropdownMenuProvider>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SettingsNavigator({
  selectedSubpage,
  onSelectSubpage,
}: SettingsNavigatorProps) {
  const { t } = useTranslation()
  const [extensionPages, setExtensionPages] = useState<ExtensionPageItem[]>([])

  const loadExtensionPages = useCallback(async () => {
    const catalog = await window.electronAPI.getPiExtensionCatalog()
    const nextPages = catalog.extensions.flatMap<ExtensionPageItem>((extension) => {
      if (!extension.enabled) return []
      if (extension.ui?.schemaVersion === 1 && extension.ui.settings?.page) {
        return [{ extension, page: extension.ui.settings.page }]
      }
      return (extension.frontendDescriptors ?? [])
        .filter((descriptor) => descriptor.surface === 'settings.page' && descriptor.page)
        .map((descriptor) => ({ extension, page: descriptor.page! }))
    })
    setExtensionPages(nextPages)

    if (selectedSubpage?.startsWith('extension-') && !nextPages.some(({ extension, page }) =>
      createExtensionSettingsSubpage(extension.id, page.id) === selectedSubpage)) {
      onSelectSubpage('extensions')
    }
  }, [onSelectSubpage, selectedSubpage])

  useEffect(() => {
    const handleExtensionsReloaded = () => {
      void loadExtensionPages().catch((error) => console.error('Failed to refresh extension settings pages:', error))
    }
    window.addEventListener('mortise:pi-extensions-reloaded', handleExtensionsReloaded)
    void loadExtensionPages().catch((error) => console.error('Failed to load extension settings pages:', error))
    return () => window.removeEventListener('mortise:pi-extensions-reloaded', handleExtensionsReloaded)
  }, [loadExtensionPages])

  const settingsItems: SettingsItem[] = useMemo(() =>
    [...SETTINGS_ITEMS.map((item, index) => ({
      id: item.id,
      label: t(item.labelKey),
      icon: SETTINGS_ICONS[item.id],
      description: t(item.descriptionKey),
      order: index,
    })), ...extensionPages.map(({ extension, page }) => {
      return {
        id: createExtensionSettingsSubpage(extension.id, page.id),
        label: page.title,
        icon: getExtensionSettingsIcon(page.icon),
        description: page.description ?? extension.description,
        order: page.order ?? SETTINGS_ITEMS.length,
      }
    })].sort((left, right) => left.order - right.order).map(({ order: _order, ...item }) => item),
    [extensionPages, t]
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="pt-2">
          {settingsItems.map((item, index) => (
            <SettingsItemRow
              key={item.id}
              item={item}
              isSelected={selectedSubpage === item.id}
              isFirst={index === 0}
              onSelect={() => onSelectSubpage(item.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
