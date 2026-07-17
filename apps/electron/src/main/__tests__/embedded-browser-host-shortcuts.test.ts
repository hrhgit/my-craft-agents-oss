import { describe, expect, it } from 'bun:test'
import { resolveEmbeddedBrowserHostShortcut } from '../embedded-browser-host-shortcuts'

describe('embedded browser host shortcuts', () => {
  it('maps only the supported dock navigation keys', () => {
    expect(resolveEmbeddedBrowserHostShortcut({ type: 'keyDown', key: 'F6', code: 'F6', control: false, meta: false, alt: false, shift: false }))
      .toEqual({ type: 'dock-navigation', command: 'focus-active-tab' })
    expect(resolveEmbeddedBrowserHostShortcut({ type: 'keyDown', key: ']', code: 'BracketRight', control: true, meta: false, alt: false, shift: false }))
      .toEqual({ type: 'dock-navigation', command: 'focus-next-group' })
    expect(resolveEmbeddedBrowserHostShortcut({ type: 'keyDown', key: '[', code: 'BracketLeft', control: true, meta: false, alt: false, shift: false }))
      .toEqual({ type: 'dock-navigation', command: 'focus-previous-group' })
    expect(resolveEmbeddedBrowserHostShortcut({ type: 'keyDown', key: 'F7', code: 'F7', control: false, meta: false, alt: false, shift: false })).toBeNull()
  })

  it('maps Cmd+R to host reload only for an unpackaged mac build', () => {
    const input = { type: 'keyDown', key: 'r', code: 'KeyR', control: false, meta: true, alt: false, shift: false } as const
    expect(resolveEmbeddedBrowserHostShortcut(input, { platform: 'darwin', isPackaged: false }))
      .toEqual({ type: 'reload-host' })
    expect(resolveEmbeddedBrowserHostShortcut(input, { platform: 'darwin', isPackaged: true })).toBeNull()
    expect(resolveEmbeddedBrowserHostShortcut(input, { platform: 'win32', isPackaged: false })).toBeNull()
  })
})
