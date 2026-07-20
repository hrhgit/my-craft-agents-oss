import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '@mortise/shared/config'
import { withFileLockSync } from '@mortise/shared/storage'

interface StoredAutomationIngressTokenV1 {
  schemaVersion: 1
  workspaceId: string
  token: string
  createdAt: string
  rotatedAt?: string
  producerId: string
  allowedSourcePrefix: string
  allowedEventTypePrefix: string
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function safeTokenFileName(workspaceId: string): string {
  return `${createHash('sha256').update(workspaceId, 'utf8').digest('hex')}.json`
}

function parseStoredToken(raw: string, workspaceId: string): StoredAutomationIngressTokenV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredAutomationIngressTokenV1>
    if (value.schemaVersion !== 1 || value.workspaceId !== workspaceId || typeof value.token !== 'string') return null
    if (typeof value.createdAt !== 'string' || typeof value.producerId !== 'string'
      || typeof value.allowedSourcePrefix !== 'string' || typeof value.allowedEventTypePrefix !== 'string') return null
    return value as StoredAutomationIngressTokenV1
  } catch {
    return null
  }
}

/** Host-owned per-workspace credentials for the loopback CloudEvents ingress. */
export class AutomationIngressTokenRegistry {
  readonly directory: string

  constructor(configDir = CONFIG_DIR) {
    this.directory = join(configDir, 'automation-ingress-tokens')
  }

  pathFor(workspaceId: string): string {
    if (!workspaceId.trim()) throw new Error('workspaceId is required')
    return join(this.directory, safeTokenFileName(workspaceId))
  }

  ensure(workspaceId: string): { path: string; created: boolean } {
    const path = this.pathFor(workspaceId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try { chmodSync(dirname(path), 0o700) } catch { /* Windows ACLs are inherited from the owner profile. */ }
    return withFileLockSync(`${path}.lock`, () => {
      if (this.read(workspaceId)) return { path, created: false }
      this.write(path, {
        schemaVersion: 1,
        workspaceId,
        token: randomBytes(32).toString('base64url'),
        createdAt: new Date().toISOString(),
        producerId: 'local-default',
        allowedSourcePrefix: 'urn:mortise:external:',
        allowedEventTypePrefix: 'mortise.',
      })
      return { path, created: true }
    })
  }

  rotate(workspaceId: string): { path: string; rotatedAt: string } {
    const path = this.pathFor(workspaceId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    return withFileLockSync(`${path}.lock`, () => {
      const existing = this.read(workspaceId)
      const rotatedAt = new Date().toISOString()
      this.write(path, {
        schemaVersion: 1,
        workspaceId,
        token: randomBytes(32).toString('base64url'),
        createdAt: existing?.createdAt ?? rotatedAt,
        rotatedAt,
        producerId: existing?.producerId ?? 'local-default',
        allowedSourcePrefix: existing?.allowedSourcePrefix ?? 'urn:mortise:external:',
        allowedEventTypePrefix: existing?.allowedEventTypePrefix ?? 'mortise.',
      })
      return { path, rotatedAt }
    })
  }

  verify(workspaceId: string, suppliedToken: string): boolean {
    const stored = this.read(workspaceId)
    if (!stored) return false
    return timingSafeEqual(digest(stored.token), digest(suppliedToken))
  }

  authorizeEvent(
    workspaceId: string,
    suppliedToken: string,
    event: { source: string; type: string },
  ): { authorized: true; producerId: string } | { authorized: false; reason: 'invalid_token' | 'source_not_allowed' | 'event_type_not_allowed' } {
    const stored = this.read(workspaceId)
    if (!stored || !timingSafeEqual(digest(stored.token), digest(suppliedToken))) {
      return { authorized: false, reason: 'invalid_token' }
    }
    if (!event.source.startsWith(stored.allowedSourcePrefix)) return { authorized: false, reason: 'source_not_allowed' }
    if (!event.type.startsWith(stored.allowedEventTypePrefix)) return { authorized: false, reason: 'event_type_not_allowed' }
    return { authorized: true, producerId: stored.producerId }
  }

  private read(workspaceId: string): StoredAutomationIngressTokenV1 | null {
    const path = this.pathFor(workspaceId)
    if (!existsSync(path)) return null
    try {
      return parseStoredToken(readFileSync(path, 'utf8'), workspaceId)
    } catch {
      return null
    }
  }

  private write(path: string, value: StoredAutomationIngressTokenV1): void {
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
    try { chmodSync(path, 0o600) } catch { /* Best effort on Windows. */ }
  }
}
