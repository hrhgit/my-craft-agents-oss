import { afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const noop = () => {}
const scopedLogger = { info: noop, warn: noop, error: noop, debug: noop }
const electronLog = {
  transports: {
    file: { format: undefined, maxSize: 0, level: 'debug', getFile: () => undefined },
    console: { format: undefined, level: 'debug' },
  },
  scope: () => scopedLogger,
}

mock.module('electron-log/main', () => ({ default: electronLog }))

const { BoundedAsyncDedicatedLogWriter } = await import('../logger')

const tempDirs: string[] = []

function tempPath(name = 'dedicated.log'): string {
  const dir = mkdtempSync(join(tmpdir(), 'mortise-dedicated-log-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('BoundedAsyncDedicatedLogWriter', () => {
  it('preserves FIFO ordering and keeps filesystem work off the enqueue path', async () => {
    const path = tempPath()
    const writer = new BoundedAsyncDedicatedLogWriter({ path, maxBytes: 1_024 })

    writer.enqueue('info', 'first\n')
    writer.enqueue('warn', 'second\n')
    writer.enqueue('error', 'third\n')

    expect(existsSync(path)).toBe(false)
    await writer.flush()
    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\nthird\n')
    expect(writer.stats()).toMatchObject({ pending: 0, failed: 0, draining: false })
  })

  it('bounds queued bytes even when a single entry is larger than the queue budget', async () => {
    const path = tempPath()
    const writer = new BoundedAsyncDedicatedLogWriter({
      path,
      maxBytes: 1_024,
      maxPendingBytes: 8,
    })

    expect(writer.enqueue('error', 'oversized\n')).toBe(false)
    expect(writer.stats()).toMatchObject({
      pending: 0,
      pendingBytes: 0,
      dropped: { info: 0, warn: 0, error: 1 },
    })
    await writer.flush()
    expect(existsSync(path)).toBe(false)
  })

  it('bounds pending lines and lets higher-severity entries evict lower-severity entries', async () => {
    const path = tempPath()
    const writer = new BoundedAsyncDedicatedLogWriter({
      path,
      maxBytes: 1_024,
      maxPendingLines: 2,
    })

    expect(writer.enqueue('info', 'info-one\n')).toBe(true)
    expect(writer.enqueue('info', 'info-two\n')).toBe(true)
    expect(writer.enqueue('error', 'error-three\n')).toBe(true)
    expect(writer.enqueue('info', 'info-four\n')).toBe(false)

    await writer.flush()
    expect(readFileSync(path, 'utf8')).toBe('info-two\nerror-three\n')
    expect(writer.stats()).toMatchObject({
      dropped: { info: 2, warn: 0, error: 0 },
      highWaterMark: 2,
    })
  })

  it('rotates to one independent backup before an entry would cross the cap', async () => {
    const path = tempPath()
    const writer = new BoundedAsyncDedicatedLogWriter({ path, maxBytes: 10 })

    writer.enqueue('info', 'first\n')
    writer.enqueue('info', 'second\n')
    await writer.flush()

    expect(readFileSync(`${path}.1`, 'utf8')).toBe('first\n')
    expect(readFileSync(path, 'utf8')).toBe('second\n')
  })

  it('reports asynchronous filesystem failures through flush and queue evidence', async () => {
    const parentFile = tempPath('not-a-directory')
    writeFileSync(parentFile, 'occupied')
    const observed: unknown[] = []
    const writer = new BoundedAsyncDedicatedLogWriter({
      path: join(parentFile, 'dedicated.log'),
      maxBytes: 1_024,
      onFailure: error => observed.push(error),
    })

    writer.enqueue('error', 'cannot-write\n')
    await expect(writer.flush()).rejects.toBeDefined()
    expect(observed).toHaveLength(1)
    expect(writer.stats()).toMatchObject({ pending: 0, failed: 1, draining: false })
  })

  it('retains a background write failure until a later shutdown flush observes it', async () => {
    const parentFile = tempPath('not-a-directory')
    writeFileSync(parentFile, 'occupied')
    const writer = new BoundedAsyncDedicatedLogWriter({
      path: join(parentFile, 'dedicated.log'),
      maxBytes: 1_024,
    })

    writer.enqueue('warn', 'background-failure\n')
    while (writer.stats().draining) await new Promise(resolve => setTimeout(resolve, 1))

    await expect(writer.flush()).rejects.toBeDefined()
    await expect(writer.flush()).resolves.toBeUndefined()
  })

  it('flushes every accepted line before resolving the shutdown boundary', async () => {
    const path = tempPath()
    const writer = new BoundedAsyncDedicatedLogWriter({ path, maxBytes: 1_024 })
    for (let index = 0; index < 50; index += 1) {
      writer.enqueue('info', `${index}\n`)
    }

    await writer.flush()
    expect(readFileSync(path, 'utf8').trim().split('\n')).toEqual(
      Array.from({ length: 50 }, (_, index) => String(index)),
    )
  })
})
