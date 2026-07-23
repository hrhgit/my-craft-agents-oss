import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const VALIDATORS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'validators.ts')).href

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([process.execPath, '--eval', code], {
    env: { ...process.env, MORTISE_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

describe('SQLite global config authority', () => {
  it('validates SQLite state while ignoring and preserving retired JSON files', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-authority-'))
    const legacyPath = join(configDir, 'config.json')
    const legacyContents = '{ invalid legacy json'
    writeFileSync(legacyPath, legacyContents)

    const output = runEval(configDir, `
      const { saveConfig } = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
      const { validateConfig } = await import(${JSON.stringify(VALIDATORS_MODULE_PATH)});
      saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null });
      console.log(JSON.stringify(validateConfig()));
    `)

    const result = JSON.parse(output) as { valid: boolean; errors: unknown[] }
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyContents)
    expect(existsSync(join(configDir, '.config.json.sync'))).toBe(false)
  }, 30_000)

  it('rejects retired thinking aliases in the canonical SQLite record', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-retired-thinking-'))
    const output = runEval(configDir, `
      const { saveConfig } = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
      const { validateConfig } = await import(${JSON.stringify(VALIDATORS_MODULE_PATH)});
      saveConfig({
        workspaces: [], activeWorkspaceId: null, activeSessionId: null,
        defaultThinkingLevel: 'think',
      });
      console.log(JSON.stringify(validateConfig()));
    `)

    const result = JSON.parse(output) as { valid: boolean; errors: Array<{ path: string }> }
    expect(result.valid).toBe(false)
    expect(result.errors.some(error => error.path === 'defaultThinkingLevel')).toBe(true)
  }, 30_000)
})
