import { describe, expect, it } from 'bun:test'
import { isAllowedWsOrigin, isLoopbackHost, isWildcardBindHost } from '../server'

describe('WebSocket Origin validation', () => {
  it('keeps loopback binds permissive for local Electron origins', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isAllowedWsOrigin(undefined, '127.0.0.1')).toBe(true)
    expect(isAllowedWsOrigin('app://craft', 'localhost')).toBe(true)
  })

  it('allows explicit non-loopback same-host origins only', () => {
    expect(isAllowedWsOrigin('https://192.168.1.20:3000', '192.168.1.20')).toBe(true)
    expect(isAllowedWsOrigin('https://evil.com', '192.168.1.20')).toBe(false)
    expect(isAllowedWsOrigin(undefined, '192.168.1.20')).toBe(false)
  })

  it('compares wildcard binds against the concrete request Host header', () => {
    expect(isWildcardBindHost('0.0.0.0')).toBe(true)
    expect(isAllowedWsOrigin('https://192.168.1.20:3000', '0.0.0.0', '192.168.1.20:3000')).toBe(true)
    expect(isAllowedWsOrigin('https://app.example.com', '0.0.0.0', 'app.example.com')).toBe(true)
    expect(isAllowedWsOrigin('https://evil.com', '0.0.0.0', '192.168.1.20:3000')).toBe(false)
  })

  it('handles IPv6 wildcard Host matching', () => {
    expect(isWildcardBindHost('::')).toBe(true)
    expect(isAllowedWsOrigin('https://[fd00::1]:3000', '::', '[fd00::1]:3000')).toBe(true)
    expect(isAllowedWsOrigin('https://[fd00::2]:3000', '::', '[fd00::1]:3000')).toBe(false)
  })

  it('rejects malformed origins for non-loopback binds', () => {
    expect(isAllowedWsOrigin('not a url', '0.0.0.0', '192.168.1.20:3000')).toBe(false)
  })
})
