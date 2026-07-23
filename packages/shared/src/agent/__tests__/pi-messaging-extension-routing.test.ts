import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Pi messaging extension routing contract', () => {
  const source = readFileSync(join(__dirname, '..', 'pi-agent.ts'), 'utf8')

  it('has no per-session extension loading path', () => {
    expect(source).not.toContain('buildRpcArgs')
    expect(source).not.toContain('new PiRpcClient')
  })

  it('passes bundled extensions to each GlobalHost runtime', () => {
    expect(source).toContain('extensionPaths: this.getMortiseExtensionPaths()')
    expect(source).toContain('process.env.MORTISE_BROWSER_EXTENSION_PATH, process.env.MORTISE_MESSAGING_EXTENSION_PATH')
  })

  it('binds shared runtimes and host reuse to Mortise-owned directories', () => {
    expect(source).toContain("import { MORTISE_AGENT_DIR, MORTISE_PROJECT_DIR } from '../config/paths.ts'")
    expect(source).toContain('key: this.piHostKey(nodePath, cliPath, clientOptions.env ?? {})')
    expect(source).toContain('agentDir: MORTISE_AGENT_DIR')
    expect(source).toContain('projectConfigDir: MORTISE_PROJECT_DIR')
    expect(source).not.toContain('process.env.PI_AGENT_DIR')
  })

  it('does not dual-register extension-owned host tools', () => {
    expect(source).toContain('!PI_EXTENSION_OWNED_SESSION_TOOL_NAMES.has(d.name)')
  })
})
