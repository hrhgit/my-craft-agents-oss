import { describe, expect, it } from 'bun:test'
import { parseExtensionProtocolUrl } from '../extension-protocol-url'

describe('parseExtensionProtocolUrl', () => {
  it('parses entry URLs with the resource type in the hostname', () => {
    expect(parseExtensionProtocolUrl('mortise-extension://frontend/extension-ui-v2-lab/conversation-review/entry'))
      .toEqual({ resourceType: 'frontend', extensionId: 'extension-ui-v2-lab', itemId: 'conversation-review', kind: 'entry' })
  })

  it('parses indexed style URLs and decodes identifiers', () => {
    expect(parseExtensionProtocolUrl('mortise-extension://module/my%20extension/components/style/2'))
      .toEqual({ resourceType: 'module', extensionId: 'my extension', itemId: 'components', kind: 'style', index: 2 })
  })

  it('rejects malformed and unsupported URLs', () => {
    expect(parseExtensionProtocolUrl('mortise-extension://frontend/a/b/entry/0')).toBeNull()
    expect(parseExtensionProtocolUrl('mortise-extension://unknown/a/b/entry')).toBeNull()
    expect(parseExtensionProtocolUrl('mortise-extension://frontend/a/b/style/not-a-number')).toBeNull()
  })
})
