import type { BrowserHostDockNavigationCommand } from '../shared/types'

type EmbeddedBrowserInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift'
>

export type EmbeddedBrowserHostShortcut =
  | { type: 'dock-navigation'; command: BrowserHostDockNavigationCommand }
  | { type: 'reload-host' }

export function resolveEmbeddedBrowserHostShortcut(
  input: EmbeddedBrowserInput | null | undefined,
  options: { platform?: NodeJS.Platform; isPackaged?: boolean } = {},
): EmbeddedBrowserHostShortcut | null {
  if (!input || input.type !== 'keyDown') return null
  const key = input.key?.toLowerCase()
  const code = input.code?.toLowerCase()
  const hasUnrelatedModifier = Boolean(input.alt || input.shift || input.meta)

  if (!input.control && !input.meta && !input.alt && !input.shift && key === 'f6') {
    return { type: 'dock-navigation', command: 'focus-active-tab' }
  }

  if (input.control && !hasUnrelatedModifier) {
    if (key === ']' || code === 'bracketright') {
      return { type: 'dock-navigation', command: 'focus-next-group' }
    }
    if (key === '[' || code === 'bracketleft') {
      return { type: 'dock-navigation', command: 'focus-previous-group' }
    }
  }

  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? true
  if (
    platform === 'darwin'
    && !isPackaged
    && input.meta
    && !input.control
    && !input.alt
    && !input.shift
    && key === 'r'
  ) {
    return { type: 'reload-host' }
  }

  return null
}
