import { describe, expect, it } from 'bun:test'
import {
  createExtensionSettingsSubpage,
  isValidSettingsSubpage,
  parseExtensionSettingsSubpage,
} from '../settings-registry'

describe('extension settings routes', () => {
  it('round-trips a manifest-owned settings page without adding it to the core registry', () => {
    const subpage = createExtensionSettingsSubpage('mortise-permissions', 'permissions')
    expect(subpage).toBe('extension-mortise-permissions.permissions')
    expect(isValidSettingsSubpage(subpage)).toBe(true)
    expect(parseExtensionSettingsSubpage(subpage)).toEqual({
      extensionId: 'mortise-permissions',
      pageId: 'permissions',
    })
  })

  it('rejects malformed extension settings routes', () => {
    expect(isValidSettingsSubpage('extension-../permissions')).toBe(false)
    expect(parseExtensionSettingsSubpage('extension-mortise-permissions')).toBeNull()
  })
})
