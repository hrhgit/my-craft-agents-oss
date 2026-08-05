import { describe, expect, test } from 'bun:test'
import { toWebExtensionResourceUrl } from './extension-resource-url'

describe('WebUI extension resource URLs', () => {
  test('maps Electron frontend, module, and override URLs to the authenticated route', () => {
    expect(toWebExtensionResourceUrl(
      'mortise-extension://frontend/conversation-board/board/entry?mortiseRevision=7',
    )).toBe('/api/extensions/ui/frontend/conversation-board/board/entry?mortiseRevision=7')
    expect(toWebExtensionResourceUrl(
      'mortise-extension://module/mortise-ui-kit/components/style/0',
    )).toBe('/api/extensions/ui/module/mortise-ui-kit/components/style/0')
    expect(toWebExtensionResourceUrl(
      'mortise-extension://override/conversation-board-tweak/board-tweak/entry',
    )).toBe('/api/extensions/ui/override/conversation-board-tweak/board-tweak/entry')
  })

  test('leaves development-server and already-routed URLs unchanged', () => {
    expect(toWebExtensionResourceUrl('http://127.0.0.1:5173/src/toolbar.js')).toBe('http://127.0.0.1:5173/src/toolbar.js')
    expect(toWebExtensionResourceUrl('/api/extensions/ui/frontend/id/toolbar/entry')).toBe('/api/extensions/ui/frontend/id/toolbar/entry')
  })
})
