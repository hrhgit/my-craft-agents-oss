import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'electron-dev.ts'), 'utf8')

describe('Electron development lifecycle', () => {
  it('runs Vite without a Windows package-manager shim', () => {
    expect(source).toContain('cmd: [process.execPath, VITE_ENTRY')
    expect(source).not.toContain('const VITE_BIN')
  })

  it('waits for Windows subprocess trees to stop when Electron exits', () => {
    expect(source).toContain('["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"]')
    expect(source).toContain('await Promise.all(processes.map(terminateProcessTree))')
    expect(source).toContain('let cleanupPromise: Promise<void> | undefined')
  })
})
