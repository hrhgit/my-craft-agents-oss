export interface RemoteTlsPolicy {
  allowInsecureTls?: boolean
}

export function normalizeSecureWebSocketOrigin(serverUrl?: string | null): string | null {
  if (!serverUrl?.trim()) return null

  try {
    const parsed = new URL(serverUrl.trim())
    return parsed.protocol === 'wss:' ? parsed.origin : null
  } catch {
    return null
  }
}

export function reconcileInsecureTlsConsentOrigin(
  serverUrl: string,
  consentOrigin: string | null,
): string | null {
  return normalizeSecureWebSocketOrigin(serverUrl) === consentOrigin ? consentOrigin : null
}

export function shouldRejectUnauthorizedTls(policy?: RemoteTlsPolicy | null): boolean {
  return policy?.allowInsecureTls !== true
}

export function allowsInsecureTlsFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.CRAFT_ALLOW_INSECURE_TLS === '1'
}
