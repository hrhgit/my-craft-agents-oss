import { describe, expect, it } from 'bun:test'
import { redactText, redactValue } from '../redaction.ts'

describe('craft-ui evidence redaction', () => {
  it('redacts structured credentials and known token values', () => {
    expect(redactValue({ apiKey: 'sk-secret-value-123456', nested: { token: 'abc' }, ok: 'visible' }))
      .toEqual({ apiKey: '[REDACTED]', nested: { token: '[REDACTED]' }, ok: 'visible' })
    expect(redactText('Authorization: Bearer abc.def and secret run-token-value', ['run-token-value']))
      .toBe('Authorization: Bearer [REDACTED] and secret [REDACTED]')
  })

  it('redacts query values for web, websocket, and file URLs', () => {
    const value = redactValue({
      web: 'https://host.test/a?token=raw&view=private',
      socket: 'ws://127.0.0.1:1234/path?auth=raw',
      file: 'file:///app/playground.html?scenario=secret',
    }) as Record<string, string>
    expect(value.web).not.toContain('raw')
    expect(value.socket).not.toContain('raw')
    expect(value.file).not.toContain('secret')
  })
})
