import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const CURRENT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function inheritedEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...overrides,
  }
}

describe('session MCP tools/list schema', () => {
  it('publishes exactly the current subagent thinking levels over stdio MCP', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mortise-session-mcp-tools-'))
    const workspaceRoot = resolve(root, 'workspace')
    const plansFolder = resolve(workspaceRoot, '.mortise', 'plans')
    const configDir = resolve(root, 'config')
    mkdirSync(plansFolder, { recursive: true })

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, 'index.ts'), '--session-id', 'tools-list-test', '--workspace-root', workspaceRoot, '--plans-folder', plansFolder],
      cwd: resolve(dirname(import.meta.dir), '..', '..'),
      env: inheritedEnvironment({ MORTISE_CONFIG_DIR: configDir, MORTISE_DOCS_MCP_URL: '' }),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'session-mcp-tools-list-test', version: '1.0.0' })

    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const subagent = tools.tools.find(tool => tool.name === 'subagent')
      const properties = subagent?.inputSchema.properties
      const thinkingLevel = properties?.thinkingLevel as { enum?: unknown } | undefined

      expect(thinkingLevel?.enum).toEqual(CURRENT_LEVELS)
      expect(thinkingLevel?.enum).not.toContain('think')
    } finally {
      await client.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
