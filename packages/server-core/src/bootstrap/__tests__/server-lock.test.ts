import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformServices } from '../../runtime/platform'
import { acquireServerLock, isProcessIdentityMismatch, releaseServerLock } from '../headless-start'

const logger = {} as PlatformServices['logger']

describe('server lock process identity', () => {
  it('accepts a lock owned by the same process', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000, processStartedAt: 9_000 }, 9_500)).toBe(false)
  })

  it('rejects a live PID whose process identity changed', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000, processStartedAt: 9_000 }, 20_000)).toBe(true)
  })

  it('detects PID reuse when process identity capture was unavailable', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000 }, 20_000)).toBe(true)
  })

  it('stays conservative when process identity capture was unavailable', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000 }, 9_500)).toBe(false)
    expect(isProcessIdentityMismatch({ startedAt: 10_000 }, null)).toBe(false)
  })
})

describe('server registration protocol', () => {
  it('removes a live legacy registration without a protocol version', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-server-lock-'))
    const lockFile = join(root, '.server.lock')
    const registrationsDir = `${lockFile}.d`
    const legacyRegistration = join(registrationsDir, 'legacy.json')
    mkdirSync(registrationsDir, { recursive: true })
    writeFileSync(legacyRegistration, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
    }))

    try {
      acquireServerLock(logger, lockFile)

      expect(existsSync(legacyRegistration)).toBe(false)
      const registrations = readdirSync(registrationsDir)
      expect(registrations).toHaveLength(1)
      const payload = JSON.parse(readFileSync(join(registrationsDir, registrations[0]!), 'utf8'))
      expect(payload.protocolVersion).toBe(2)
      expect(payload.pid).toBe(process.pid)
      expect(payload.startedAt).toBeGreaterThan(0)
    } finally {
      releaseServerLock(lockFile)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes registrations from unsupported protocol versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-server-lock-'))
    const lockFile = join(root, '.server.lock')
    const registrationsDir = `${lockFile}.d`
    const unsupportedRegistration = join(registrationsDir, 'unsupported.json')
    mkdirSync(registrationsDir, { recursive: true })
    writeFileSync(unsupportedRegistration, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      protocolVersion: 1,
    }))

    try {
      acquireServerLock(logger, lockFile)
      expect(existsSync(unsupportedRegistration)).toBe(false)
    } finally {
      releaseServerLock(lockFile)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
