import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Pi messaging extension routing contract', () => {
  const source = readFileSync(join(__dirname, '..', 'pi-agent.ts'), 'utf8')

  it('discovers the bundled extension in legacy runtimes', () => {
    expect(source).toContain('CRAFT_MESSAGING_EXTENSION_PATH')
    expect(source).toContain("args.push('--extension', messagingExtensionPath)")
  })

  it('passes bundled extensions to each GlobalHost runtime', () => {
    expect(source).toContain('extensionPaths: this.getCraftExtensionPaths()')
    expect(source).toContain('process.env.CRAFT_BROWSER_EXTENSION_PATH, process.env.CRAFT_MESSAGING_EXTENSION_PATH')
  })

  it('does not dual-register the legacy Host proxy tools', () => {
    expect(source).toContain("d.name !== 'mcp__session__list_messaging_channels'")
    expect(source).toContain("d.name !== 'mcp__session__unbind_messaging_channel'")
  })
})
