import { describe, expect, it } from 'bun:test'
import { createSingleFlightLoader } from './single-flight-loader'

describe('single-flight loader', () => {
  it('shares concurrent work for the same key', async () => {
    let resolveRequest!: (value: string[]) => void
    let requestCount = 0
    const loader = createSingleFlightLoader<string[]>(
      async () => {
        requestCount += 1
        return await new Promise<string[]>((resolve) => { resolveRequest = resolve })
      },
      { cacheTtlMs: 5_000 },
    )

    const first = loader.load('session-1')
    const second = loader.load('session-1')

    expect(first).toBe(second)
    expect(requestCount).toBe(1)
    resolveRequest(['child-1'])
    await expect(first).resolves.toEqual(['child-1'])
    await expect(second).resolves.toEqual(['child-1'])
  })

  it('reuses fresh values while allowing explicit and expired refreshes', async () => {
    let now = 100
    let requestCount = 0
    const loader = createSingleFlightLoader(
      async () => [`request-${++requestCount}`],
      { cacheTtlMs: 5_000, now: () => now },
    )

    await expect(loader.load('session-1')).resolves.toEqual(['request-1'])
    await expect(loader.load('session-1')).resolves.toEqual(['request-1'])
    await expect(loader.load('session-1', { force: true })).resolves.toEqual(['request-2'])
    now += 5_001
    await expect(loader.load('session-1')).resolves.toEqual(['request-3'])
    expect(requestCount).toBe(3)
  })

  it('clears a failed request so the next refresh can retry', async () => {
    let requestCount = 0
    const loader = createSingleFlightLoader(
      async () => {
        requestCount += 1
        if (requestCount === 1) throw new Error('connection lost')
        return ['recovered']
      },
      { cacheTtlMs: 5_000 },
    )

    await expect(loader.load('session-1')).rejects.toThrow('connection lost')
    await expect(loader.load('session-1')).resolves.toEqual(['recovered'])
    expect(requestCount).toBe(2)
  })
})
