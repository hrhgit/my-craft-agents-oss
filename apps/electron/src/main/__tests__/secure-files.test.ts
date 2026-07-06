import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOwnerOnlyFileSync } from '../secure-files'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeOwnerOnlyFileSync', () => {
  it('replaces existing content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-secure-file-'))
    tempDirs.push(dir)
    const file = join(dir, 'secret')
    writeFileSync(file, 'old')

    writeOwnerOnlyFileSync(file, 'new-secret')

    expect(readFileSync(file, 'utf-8')).toBe('new-secret')
    expect(existsSync(file)).toBe(true)
  })

  it('forces owner-only permissions on POSIX', () => {
    if (process.platform === 'win32') return

    const dir = mkdtempSync(join(tmpdir(), 'craft-secure-file-'))
    tempDirs.push(dir)
    const file = join(dir, 'secret')
    writeFileSync(file, 'old', { mode: 0o644 })
    chmodSync(file, 0o644)

    writeOwnerOnlyFileSync(file, 'new-secret')

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
