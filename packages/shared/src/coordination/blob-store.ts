import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CoordinationBlobRef } from './types.ts'

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
}

export class CoordinationBlobStore {
  constructor(private readonly rootPath: string) {}

  put(content: string | Uint8Array): CoordinationBlobRef {
    const bytes = toBuffer(content)
    const oid = createHash('sha256').update(bytes).digest('hex')
    const target = this.pathFor(oid)
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, bytes, { flag: 'wx' })
        try {
          renameSync(temporary, target)
        } catch (error) {
          if (!existsSync(target)) throw error
          unlinkSync(temporary)
        }
      } catch (error) {
        try { unlinkSync(temporary) } catch {}
        throw error
      }
    }
    return { algorithm: 'sha256', oid, size: bytes.byteLength }
  }

  get(oid: string): Uint8Array {
    if (!/^[a-f0-9]{64}$/.test(oid)) throw new TypeError('Invalid SHA-256 object id')
    const bytes = readFileSync(this.pathFor(oid))
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== oid) throw new Error(`Coordination blob failed integrity check: ${oid}`)
    return new Uint8Array(bytes)
  }

  has(oid: string): boolean {
    return /^[a-f0-9]{64}$/.test(oid) && existsSync(this.pathFor(oid))
  }

  private pathFor(oid: string): string {
    return join(this.rootPath, 'sha256', oid.slice(0, 2), oid.slice(2))
  }
}
