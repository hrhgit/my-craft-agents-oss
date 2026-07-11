import { describe, expect, it } from 'bun:test'
import messagingExtension from './messaging.js'

function loadExtension(outputs: Record<string, unknown>) {
  const tools = new Map<string, any>()
  const declarations: unknown[] = []
  messagingExtension({
    declareCapabilities(value: unknown) { declarations.push(value) },
    registerTool(tool: any) { tools.set(tool.name, tool) },
  })
  const calls: Array<{ operation: string; input: unknown }> = []
  const ctx = {
    capabilities: {
      async invoke(_capability: string, operation: string, input: unknown) {
        calls.push({ operation, input })
        return { status: 'success', output: outputs[operation] }
      },
    },
  }
  return { tools, declarations, calls, ctx }
}

describe('Pi messaging capability extension', () => {
  it('declares only bounded messaging operations and preserves list formatting', async () => {
    const f = loadExtension({
      'list-bindings': [{ id: 'binding-1', platform: 'telegram', channelId: 'chat-1', channelName: 'Team', threadId: 7, enabled: true }],
    })
    expect(f.declarations).toEqual([[{ capability: 'messaging.session', operations: ['list-bindings', 'unbind'] }]])
    const result = await f.tools.get('mcp__session__list_messaging_channels').execute('call', {}, new AbortController().signal, () => {}, f.ctx)
    expect(result.content[0].text).toContain('- telegram: Team › Topic #7 (active)')
    expect(f.calls).toEqual([{ operation: 'list-bindings', input: {} }])
  })

  it('unbinds only the Host-owned current session and reports removed count', async () => {
    const f = loadExtension({ unbind: { removed: 2 } })
    const result = await f.tools.get('mcp__session__unbind_messaging_channel').execute(
      'call', { platform: 'whatsapp' }, new AbortController().signal, () => {}, f.ctx,
    )
    expect(result.content[0].text).toBe('Unbound 2 messaging channel(s) for whatsapp.')
    expect(f.calls).toEqual([{ operation: 'unbind', input: { platform: 'whatsapp' } }])
  })
})
