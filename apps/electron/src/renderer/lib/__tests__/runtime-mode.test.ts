import { describe, expect, it } from 'bun:test'
import { resolveCraftTestMode } from '../runtime-mode'

describe('Mortise runtime mode', () => {
  it('enables product feature testing from quick-launch Vite mode', () => {
    expect(resolveCraftTestMode({ search: '', viteTestMode: '1' })).toBe(true)
  })

  it('allows an explicit URL override in either direction', () => {
    expect(resolveCraftTestMode({ search: '?mortiseTestMode=1', viteTestMode: '0' })).toBe(true)
    expect(resolveCraftTestMode({ search: '?mortiseTestMode=0', viteTestMode: '1' })).toBe(false)
  })

  it('stays disabled in ordinary development and production launches', () => {
    expect(resolveCraftTestMode({ search: '', viteTestMode: undefined })).toBe(false)
  })
})
