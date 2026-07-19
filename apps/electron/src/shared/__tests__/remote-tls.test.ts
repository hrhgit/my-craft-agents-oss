import { describe, expect, it } from 'bun:test'
import {
  allowsInsecureTlsFromEnvironment,
  normalizeSecureWebSocketOrigin,
  reconcileInsecureTlsConsentOrigin,
  shouldRejectUnauthorizedTls,
} from '../remote-tls'

describe('remote TLS policy', () => {
  it('rejects untrusted certificates by default', () => {
    expect(shouldRejectUnauthorizedTls()).toBe(true)
    expect(shouldRejectUnauthorizedTls({})).toBe(true)
    expect(shouldRejectUnauthorizedTls({ allowInsecureTls: false })).toBe(true)
  })

  it('allows untrusted certificates only after explicit opt-in', () => {
    expect(shouldRejectUnauthorizedTls({ allowInsecureTls: true })).toBe(false)
    expect(allowsInsecureTlsFromEnvironment({ MORTISE_ALLOW_INSECURE_TLS: '1' })).toBe(true)
    expect(allowsInsecureTlsFromEnvironment({ MORTISE_ALLOW_INSECURE_TLS: 'true' })).toBe(false)
  })

  it('binds certificate consent to a normalized WSS origin', () => {
    const origin = normalizeSecureWebSocketOrigin(' WSS://EXAMPLE.test:443/path?q=1 ')

    expect(origin).toBe('wss://example.test')
    expect(reconcileInsecureTlsConsentOrigin('wss://example.test/other', origin)).toBe(origin)
    expect(reconcileInsecureTlsConsentOrigin('wss://other.test', origin)).toBeNull()
    expect(reconcileInsecureTlsConsentOrigin('ws://example.test', origin)).toBeNull()
  })

  it('does not carry initial consent onto a different or newly secure origin', () => {
    expect(normalizeSecureWebSocketOrigin('ws://example.test')).toBeNull()
    expect(normalizeSecureWebSocketOrigin('not a URL')).toBeNull()
    expect(reconcileInsecureTlsConsentOrigin('wss://example.test', null)).toBeNull()
  })
})
