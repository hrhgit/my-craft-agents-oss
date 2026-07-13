import { describe, expect, it } from 'bun:test'
import { resolveMidStreamSendIntent } from '../midstream-shortcuts'

const enter = {
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
}

describe('mid-stream send shortcuts', () => {
  it('uses the configured behavior for plain Enter', () => {
    expect(resolveMidStreamSendIntent('enter', enter)).toBe('default')
  })

  it('uses the alternate behavior for Ctrl/Cmd+Enter', () => {
    expect(resolveMidStreamSendIntent('enter', { ...enter, ctrlKey: true })).toBe('alternate')
    expect(resolveMidStreamSendIntent('enter', { ...enter, metaKey: true })).toBe('alternate')
  })

  it('preserves newline and IME behavior', () => {
    expect(resolveMidStreamSendIntent('enter', { ...enter, shiftKey: true })).toBeNull()
    expect(resolveMidStreamSendIntent('enter', { ...enter, isComposing: true })).toBeNull()
  })

  it('preserves the Ctrl/Cmd-only send preference', () => {
    expect(resolveMidStreamSendIntent('cmd-enter', enter)).toBeNull()
    expect(resolveMidStreamSendIntent('cmd-enter', { ...enter, ctrlKey: true })).toBe('alternate')
  })
})
