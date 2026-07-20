import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('legacy Craft user-data migration', () => {
  test('does not rerun after a completed migration marker exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-legacy-migration-'))
    temporaryRoots.push(root)
    const home = join(root, 'home')
    const targetConfigDir = join(home, '.mortise')
    const existingBackup = join(root, 'existing-backup')
    mkdirSync(targetConfigDir, { recursive: true })
    mkdirSync(existingBackup)
    writeFileSync(join(targetConfigDir, '.legacy-craft-migration.json'), JSON.stringify({
      completedAt: '2026-07-20T00:00:00.000Z',
      backupRoot: existingBackup,
    }))

    const child = Bun.spawn({
      cmd: [process.execPath, 'run', 'scripts/migrate-legacy-craft-user-data.ts', `--backup-root=${existingBackup}`],
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MORTISE_CONFIG_DIR: targetConfigDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'legacy-craft-migration-already-completed',
      backupRoot: existingBackup,
    })
    expect(existsSync(join(home, '.craft-agent'))).toBe(false)
  })

  test('refuses an incomplete marker instead of rerunning the migration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-legacy-migration-'))
    temporaryRoots.push(root)
    const home = join(root, 'home')
    const targetConfigDir = join(home, '.mortise')
    mkdirSync(targetConfigDir, { recursive: true })
    writeFileSync(join(targetConfigDir, '.legacy-craft-migration.json'), '{}')

    const child = Bun.spawn({
      cmd: [process.execPath, 'run', 'scripts/migrate-legacy-craft-user-data.ts'],
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MORTISE_CONFIG_DIR: targetConfigDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('completion marker is incomplete')
    expect(existsSync(join(home, '.craft-agent'))).toBe(false)
  })
})
