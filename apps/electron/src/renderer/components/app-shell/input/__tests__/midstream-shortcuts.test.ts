import { describe, expect, it } from 'bun:test'
import { getEventIsComposing, resolveMidStreamSendIntent } from '../midstream-shortcuts'

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

describe('getEventIsComposing event-shape tolerance', () => {
  it('reads the flag from a React synthetic event shape (nativeEvent)', () => {
    expect(getEventIsComposing({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(getEventIsComposing({ nativeEvent: { isComposing: false } })).toBe(false)
  })

  it('reads the flag from a raw DOM KeyboardEvent shape (no nativeEvent)', () => {
    expect(getEventIsComposing({ isComposing: true })).toBe(true)
    expect(getEventIsComposing({ isComposing: false })).toBe(false)
  })

  it('prefers the native event when both shapes are present', () => {
    expect(getEventIsComposing({ isComposing: false, nativeEvent: { isComposing: true } })).toBe(true)
  })

  it('defaults to false when neither shape carries the flag', () => {
    expect(getEventIsComposing({})).toBe(false)
  })
})
