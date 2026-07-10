import type { SourceConnectionStatus } from '../../../shared/types'

/**
 * Derive connection status from source config.
 *
 * Keep this in sync with packages/shared/src/sources/auth-state.ts. This module
 * stays React-free so status policy can be tested without loading UI bundles.
 */
export function deriveConnectionStatus(source: {
  config: {
    isAuthenticated?: boolean
    connectionStatus?: SourceConnectionStatus
    type?: string
    mcp?: { authType?: string; transport?: string; url?: string }
    api?: { authType?: string }
  }
}, localMcpEnabled = true): SourceConnectionStatus {
  const mcp = source.config.mcp
  if (mcp?.transport === 'stdio' && !localMcpEnabled) {
    return 'local_disabled'
  }

  if (source.config.connectionStatus) {
    return source.config.connectionStatus
  }

  if (source.config.type === 'local') {
    return 'connected'
  }

  const requiresAuthentication = sourceRequiresAuthenticationForStatus(source.config)
  const isAuthenticated = !requiresAuthentication || source.config.isAuthenticated === true

  if (!isAuthenticated) {
    return 'needs_auth'
  }

  if (isAuthenticated) {
    return 'connected'
  }

  return 'untested'
}

function sourceRequiresAuthenticationForStatus(config: {
  type?: string
  mcp?: { authType?: string; transport?: string; url?: string }
  api?: { authType?: string }
}): boolean {
  if (config.type === 'mcp') {
    const mcp = config.mcp
    if (!mcp) return false
    if (mcp.transport === 'stdio') return false
    return mcp.authType !== 'none'
  }

  if (config.type === 'api') {
    const authType = config.api?.authType
    return authType !== undefined && authType !== 'none'
  }

  return false
}
