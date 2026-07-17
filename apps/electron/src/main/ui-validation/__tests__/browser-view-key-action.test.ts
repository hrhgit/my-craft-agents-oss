import { describe, expect, it } from 'bun:test'
import { parseBrowserViewKeyAction } from '../browser-view-key-action'

describe('BrowserView UI validation key action', () => {
  it('accepts only the dock shortcuts needed for physical BrowserView validation', () => {
    expect(parseBrowserViewKeyAction({ instanceId: 'browser-a', key: 'F6' })).toEqual({
      instanceId: 'browser-a',
      key: 'F6',
      modifiers: [],
    })
    expect(parseBrowserViewKeyAction({ instanceId: 'browser-a', key: '[', modifiers: ['control'] })).toEqual({
      instanceId: 'browser-a',
      key: '[',
      modifiers: ['control'],
    })
    expect(parseBrowserViewKeyAction({ instanceId: 'browser-a', key: ']', modifiers: ['meta'] })).toEqual({
      instanceId: 'browser-a',
      key: ']',
      modifiers: ['meta'],
    })
  })

  it('rejects arbitrary keys, modifiers, and unbounded instance ids', () => {
    expect(() => parseBrowserViewKeyAction({ instanceId: 'browser-a', key: 'A' })).toThrow('limited')
    expect(() => parseBrowserViewKeyAction({ instanceId: 'browser-a', key: '[', modifiers: ['alt'] })).toThrow('only control or meta')
    expect(() => parseBrowserViewKeyAction({ instanceId: 'x'.repeat(201), key: 'F6' })).toThrow('bounded instanceId')
  })
})
