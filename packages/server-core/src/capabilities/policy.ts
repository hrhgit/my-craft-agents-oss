import type { CapabilityAuthorization, CapabilityRequestV1 } from './types.ts'

export type CapabilityPolicyDecision = 'allow' | 'deny' | 'prompt'

export interface CapabilityPolicyRule {
  capability: string
  operations: readonly string[]
  decision: CapabilityPolicyDecision
  extensionIds?: readonly string[]
}

export interface CapabilityPolicyOptions {
  rules: readonly CapabilityPolicyRule[]
  sessionExists(sessionId: string): boolean | Promise<boolean>
  prompt?: (request: CapabilityRequestV1) => Promise<boolean>
}

/**
 * Host-side fail-closed authorization. Registering a provider does not expose it:
 * every operation also needs an explicit policy rule.
 */
export function createCapabilityAuthorizationPolicy(options: CapabilityPolicyOptions) {
  return async (request: CapabilityRequestV1): Promise<CapabilityAuthorization> => {
    if (!await options.sessionExists(request.sessionId)) {
      return { allowed: false, reason: 'Capability session is not active' }
    }

    const rule = options.rules.find(candidate =>
      candidate.capability === request.capability
      && candidate.operations.includes(request.operation)
      && (!candidate.extensionIds || candidate.extensionIds.includes(request.extensionId)))

    if (!rule || rule.decision === 'deny') {
      return { allowed: false, reason: 'Capability operation is not allowed by Host policy' }
    }
    if (rule.decision === 'allow') return { allowed: true }
    if (!options.prompt) {
      return { allowed: false, reason: 'Capability operation requires user confirmation' }
    }
    return await options.prompt(request)
      ? { allowed: true }
      : { allowed: false, reason: 'User denied capability request' }
  }
}

export const ELECTRON_CAPABILITY_POLICY_V1: readonly CapabilityPolicyRule[] = [
  { capability: 'system.notification', operations: ['show'], decision: 'allow' },
  // The native picker is itself an explicit user confirmation surface.
  { capability: 'files.pick', operations: ['open'], decision: 'allow' },
  // Provider additionally confines reads to the active workspace and a size limit.
  { capability: 'files.preview', operations: ['read'], decision: 'allow' },
  // These operations only affect a visible browser instance owned by the session.
  { capability: 'browser.open', operations: ['navigate'], decision: 'allow' },
  { capability: 'browser.control', operations: ['back', 'forward', 'focus', 'hide', 'close'], decision: 'allow' },
  { capability: 'browser.command', operations: ['execute'], decision: 'allow', extensionIds: ['browser'] },
  { capability: 'browser.operate', operations: ['snapshot', 'screenshot', 'console', 'network', 'downloads', 'challenge'], decision: 'allow' },
  { capability: 'browser.operate', operations: ['click', 'click-at', 'drag', 'fill', 'type', 'select', 'screenshot-region', 'wait', 'key', 'scroll', 'resize'], decision: 'prompt' },
  // OAuth mutates account state and always requires an explicit user decision.
  { capability: 'oauth.flow', operations: ['begin', 'revoke'], decision: 'prompt' },
  { capability: 'oauth.flow', operations: ['status', 'cancel'], decision: 'allow' },
  // Keychain metadata is safe to query; removal still requires confirmation.
  { capability: 'credentials.keychain', operations: ['has'], decision: 'allow' },
  { capability: 'credentials.keychain', operations: ['remove'], decision: 'prompt' },
  { capability: 'session.share', operations: ['status'], decision: 'allow' },
  { capability: 'session.share', operations: ['publish', 'refresh', 'revoke'], decision: 'prompt' },
  { capability: 'session.transfer', operations: ['export-summary', 'import-summary'], decision: 'prompt' },
  { capability: 'messaging.session', operations: ['status', 'list-bindings'], decision: 'allow' },
  { capability: 'messaging.session', operations: ['pair', 'unbind'], decision: 'prompt' },
  { capability: 'automation.workspace', operations: ['status', 'list'], decision: 'allow' },
  { capability: 'automation.workspace', operations: ['set-enabled'], decision: 'prompt' },
  { capability: 'scheduler.workspace', operations: ['status', 'list'], decision: 'allow' },
  { capability: 'scheduler.workspace', operations: ['set-enabled'], decision: 'prompt' },
  { capability: 'webhook.workspace', operations: ['status', 'list'], decision: 'allow' },
  { capability: 'webhook.workspace', operations: ['set-enabled'], decision: 'prompt' },
] as const
