/**
 * Settings Registry - Single Source of Truth
 *
 * This file defines all settings pages in one place. All other files that need
 * settings page information should import from here.
 *
 * To add a new settings page:
 * 1. Add an entry to SETTINGS_PAGES below
 * 2. Create the page component in renderer/pages/settings/
 * 3. Add to SETTINGS_PAGE_COMPONENTS in renderer/pages/settings/settings-pages.ts
 * 4. Add icon to SETTINGS_ICONS in renderer/components/icons/SettingsIcons.tsx
 *
 * That's it - types, routes, and validation are derived automatically.
 */

/**
 * Settings page definition
 */
export interface SettingsPageDefinition {
  /** Unique identifier used in routes and navigation */
  id: string
  /** i18n key for display label in settings navigator */
  labelKey: string
  /** i18n key for short description shown in settings navigator */
  descriptionKey: string
}

/**
 * The canonical list of all settings pages.
 * Order here determines display order in the settings navigator.
 *
 * ADD NEW PAGES HERE - everything else derives from this list.
 *
 * NOTE: labelKey/descriptionKey are i18n translation keys, resolved at render
 * time via t(). Do NOT call i18n.t() here — this module loads before i18n init.
 */
export const SETTINGS_PAGES = [
  { id: 'app' as const, labelKey: 'settings.app.title', descriptionKey: 'settings.app.description' },
  { id: 'ai' as const, labelKey: 'settings.ai.title', descriptionKey: 'settings.ai.description' },
  { id: 'agents' as const, labelKey: 'settings.agents.title', descriptionKey: 'settings.agents.description' },
  { id: 'extensions' as const, labelKey: 'settings.extensions.title', descriptionKey: 'settings.extensions.description' },
  { id: 'developer' as const, labelKey: 'settings.developer.title', descriptionKey: 'settings.developer.description' },
  { id: 'appearance' as const, labelKey: 'settings.appearance.title', descriptionKey: 'settings.appearance.description' },
  { id: 'input' as const, labelKey: 'settings.input.title', descriptionKey: 'settings.input.description' },
  { id: 'workspace' as const, labelKey: 'settings.workspace.title', descriptionKey: 'settings.workspace.description' },
  { id: 'messaging' as const, labelKey: 'settings.messaging.title', descriptionKey: 'settings.messaging.description' },
  { id: 'server' as const, labelKey: 'settings.server.title', descriptionKey: 'settings.server.description' },
  { id: 'shortcuts' as const, labelKey: 'settings.shortcuts.title', descriptionKey: 'settings.shortcuts.description' },
  { id: 'preferences' as const, labelKey: 'settings.preferences.title', descriptionKey: 'settings.preferences.description' },
] satisfies readonly SettingsPageDefinition[]

/**
 * Settings subpage type - derived from SETTINGS_PAGES
 * This replaces the manual union type in types.ts
 */
export type BuiltInSettingsSubpage = (typeof SETTINGS_PAGES)[number]['id']
export type ExtensionSettingsSubpage = `extension-${string}.${string}`
export type SettingsSubpage = BuiltInSettingsSubpage | ExtensionSettingsSubpage

/**
 * Array of valid settings subpage IDs - for runtime validation
 */
export const VALID_SETTINGS_SUBPAGES: readonly BuiltInSettingsSubpage[] = SETTINGS_PAGES.map(p => p.id)

export function isBuiltInSettingsSubpage(value: string): value is BuiltInSettingsSubpage {
  return VALID_SETTINGS_SUBPAGES.includes(value as BuiltInSettingsSubpage)
}

/**
 * Type guard to check if a string is a valid settings subpage
 */
export function isValidSettingsSubpage(value: string): value is SettingsSubpage {
  return isBuiltInSettingsSubpage(value)
    || /^extension-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

export function createExtensionSettingsSubpage(extensionId: string, pageId: string): ExtensionSettingsSubpage {
  return `extension-${extensionId}.${pageId}`
}

export function parseExtensionSettingsSubpage(value: string): { extensionId: string; pageId: string } | null {
  const match = /^extension-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(value)
  return match ? { extensionId: match[1], pageId: match[2] } : null
}

/**
 * Get settings page definition by ID
 */
export function getSettingsPage(id: BuiltInSettingsSubpage): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find(p => p.id === id)
  if (!page) throw new Error(`Unknown settings page: ${id}`)
  return page
}
