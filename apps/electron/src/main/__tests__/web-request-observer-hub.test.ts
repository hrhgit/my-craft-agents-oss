import { describe, expect, it } from 'bun:test'
import type { Session } from 'electron'
import { observeWebRequests } from '../web-request-observer-hub'

describe('web request observer hub', () => {
  it('installs one Electron listener and fans out without replacement', () => {
    let before: ((details: any, callback: (response: object) => void) => void) | undefined
    let completed: ((details: any) => void) | undefined
    let errors: ((details: any) => void) | undefined
    let beforeRegistrations = 0
    const session = { webRequest: {
      onBeforeRequest(listener: typeof before) { beforeRegistrations += 1; before = listener },
      onCompleted(listener: typeof completed) { completed = listener },
      onErrorOccurred(listener: typeof errors) { errors = listener },
    } } as unknown as Session
    const seen: string[] = []
    const first = observeWebRequests(session, { beforeRequest: () => seen.push('first') })
    observeWebRequests(session, { beforeRequest: () => seen.push('second'), completed: () => seen.push('complete') })
    let continued = false
    before?.({ id: 1 }, () => { continued = true })
    completed?.({ id: 1 })
    expect(beforeRegistrations).toBe(1)
    expect(continued).toBe(true)
    expect(seen).toEqual(['first', 'second', 'complete'])
    first()
    before?.({ id: 2 }, () => {})
    expect(seen.at(-1)).toBe('second')
  })
})
