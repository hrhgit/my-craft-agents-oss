import { describe, expect, it } from 'bun:test'
import { deriveConnectionStatus } from '../source-status'

describe('deriveConnectionStatus', () => {
  it('matches backend auth policy for HTTP MCP sources without authType', () => {
    expect(deriveConnectionStatus({
      config: {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp' },
      },
    })).toBe('needs_auth')
  })

  it('treats authenticated HTTP MCP sources without authType as connected', () => {
    expect(deriveConnectionStatus({
      config: {
        type: 'mcp',
        isAuthenticated: true,
        mcp: { url: 'https://example.com/mcp' },
      },
    })).toBe('connected')
  })

  it('keeps explicit no-auth MCP and stdio MCP connected without stored auth', () => {
    expect(deriveConnectionStatus({
      config: {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'none' },
      },
    })).toBe('connected')

    expect(deriveConnectionStatus({
      config: {
        type: 'mcp',
        mcp: { transport: 'stdio' },
      },
    })).toBe('connected')
  })

  it('keeps local MCP disabled status highest priority', () => {
    expect(deriveConnectionStatus({
      config: {
        type: 'mcp',
        mcp: { transport: 'stdio' },
      },
    }, false)).toBe('local_disabled')
  })
})
