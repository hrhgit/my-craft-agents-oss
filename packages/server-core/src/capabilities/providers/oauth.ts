import type { CapabilityProvider } from '../types.ts'

/**
 * Host-owned OAuth operations exposed to Pi extensions.
 *
 * The adapter deliberately returns only flow references and status.  OAuth
 * codes, state, access/refresh tokens and credential values never cross this
 * boundary.  The Host is responsible for opening the authorization URL and
 * completing the callback through its normal callback server.
 */
export interface OAuthCapabilityAdapter {
  begin(input: { sourceSlug: string; sessionId: string }, signal: AbortSignal): Promise<{
    flowId: string
    status: 'pending'
    /** Optional user-facing indication; never an auth URL or provider secret. */
    userAction?: 'open_authorization'
  }>
  status(input: { flowId: string; sessionId: string }): Promise<{
    flowId: string
    status: 'pending' | 'completed' | 'cancelled' | 'failed'
    /** Safe, non-sensitive account label only. */
    accountLabel?: string
    errorCode?: string
  }>
  cancel(input: { flowId: string; sessionId: string }): Promise<{ flowId: string; status: 'cancelled' }>
  revoke(input: { sourceSlug: string; sessionId: string }): Promise<{ sourceSlug: string; revoked: boolean }>
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Capability input must be an object')
  return input as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new Error(`${key} must be a non-empty string`)
  return value
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).find(key => !allowed.includes(key))
  if (unexpected) throw new Error(`Unexpected capability input field: ${unexpected}`)
}

export function createOAuthCapabilityProvider(adapter: OAuthCapabilityAdapter): CapabilityProvider {
  return {
    capability: 'oauth.flow',
    async invoke(operation, input, context) {
      const value = objectInput(input)
      switch (operation) {
        case 'begin': {
          onlyKeys(value, ['sourceSlug'])
          const result = await adapter.begin({ sourceSlug: requiredString(value, 'sourceSlug'), sessionId: context.request.sessionId }, context.signal)
          return {
            flowId: requiredString(result as unknown as Record<string, unknown>, 'flowId'),
            status: 'pending' as const,
            ...(result.userAction === 'open_authorization' ? { userAction: result.userAction } : {}),
          }
        }
        case 'status': {
          onlyKeys(value, ['flowId'])
          const result = await adapter.status({ flowId: requiredString(value, 'flowId'), sessionId: context.request.sessionId })
          if (!['pending', 'completed', 'cancelled', 'failed'].includes(result.status)) throw new Error('OAuth adapter returned an invalid status')
          return {
            flowId: requiredString(result as unknown as Record<string, unknown>, 'flowId'),
            status: result.status,
            ...(typeof result.accountLabel === 'string' ? { accountLabel: result.accountLabel.slice(0, 256) } : {}),
            ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode.slice(0, 128) } : {}),
          }
        }
        case 'cancel': {
          onlyKeys(value, ['flowId'])
          const result = await adapter.cancel({ flowId: requiredString(value, 'flowId'), sessionId: context.request.sessionId })
          return { flowId: requiredString(result as unknown as Record<string, unknown>, 'flowId'), status: 'cancelled' as const }
        }
        case 'revoke': {
          onlyKeys(value, ['sourceSlug'])
          const result = await adapter.revoke({ sourceSlug: requiredString(value, 'sourceSlug'), sessionId: context.request.sessionId })
          return { sourceSlug: requiredString(result as unknown as Record<string, unknown>, 'sourceSlug'), revoked: result.revoked === true }
        }
        default:
          throw new Error(`Unsupported oauth.flow operation: ${operation}`)
      }
    },
  }
}

/** Secret-free keychain metadata operations. Values are intentionally absent. */
export interface KeychainCapabilityAdapter {
  has(input: { type: string; sourceId?: string; name?: string; connectionSlug?: string }, sessionId: string): Promise<{ present: boolean }>
  remove(input: { type: string; sourceId?: string; name?: string; connectionSlug?: string }, sessionId: string): Promise<{ removed: boolean }>
}

export function createKeychainCapabilityProvider(adapter: KeychainCapabilityAdapter): CapabilityProvider {
  return {
    capability: 'credentials.keychain',
    async invoke(operation, input, context) {
      const value = objectInput(input)
      onlyKeys(value, ['type', 'sourceId', 'name', 'connectionSlug'])
      const type = requiredString(value, 'type')
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(type)) throw new Error('type is invalid')
      const id = {
        type,
        ...(typeof value.sourceId === 'string' ? { sourceId: value.sourceId } : {}),
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(typeof value.connectionSlug === 'string' ? { connectionSlug: value.connectionSlug } : {}),
      }
      if (operation === 'has') return { present: (await adapter.has(id, context.request.sessionId)).present === true }
      if (operation === 'remove') return { removed: (await adapter.remove(id, context.request.sessionId)).removed === true }
      throw new Error(`Unsupported credentials.keychain operation: ${operation}`)
    },
  }
}
