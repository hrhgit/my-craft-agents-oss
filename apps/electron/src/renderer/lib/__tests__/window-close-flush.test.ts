import { describe, expect, it } from 'bun:test'
import { flushWindowCloseState, registerWindowCloseFlusher } from '../window-close-flush'

describe('window close flush registry', () => {
  it('waits for registered state flushers and removes unregistered work', async () => {
    const calls: string[] = []
    const unregisterFirst = registerWindowCloseFlusher(async () => { calls.push('first') })
    const unregisterSecond = registerWindowCloseFlusher(() => { calls.push('second') })

    unregisterSecond()
    await flushWindowCloseState()
    unregisterFirst()

    expect(calls).toEqual(['first'])
  })

  it('bounds a stuck renderer flusher', async () => {
    const unregister = registerWindowCloseFlusher(() => new Promise<void>(() => {}))
    const startedAt = Date.now()
    await expect(flushWindowCloseState(5)).rejects.toThrow('timed out')
    unregister()
    expect(Date.now() - startedAt).toBeLessThan(100)
  })

  it('surfaces a flusher failure to the destructive caller', async () => {
    const unregister = registerWindowCloseFlusher(async () => {
      throw new Error('draft persistence failed')
    })
    await expect(flushWindowCloseState()).rejects.toThrow('draft persistence failed')
    unregister()
  })
})
