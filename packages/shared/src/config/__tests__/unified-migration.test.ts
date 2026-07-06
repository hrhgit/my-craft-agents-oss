import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const MIGRATION_MODULE = pathToFileURL(join(import.meta.dir, '..', 'unified-migration.ts')).href
const PATHS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'paths.ts')).href
const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'storage.ts')).href
const TREE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'tree-jsonl.ts')).href

function runIsolatedMigrationScript(root: string, code: string): { stdout: string; stderr: string; exitCode: number | null } {
  const homeDir = join(root, 'home')
  const configDir = join(root, 'craft')
  const piAgentDir = join(root, 'pi-agent')

  const result = Bun.spawnSync([
    process.execPath,
    '--eval',
    code,
  ], {
    env: {
      ...process.env,
      TEST_ROOT: root,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CRAFT_CONFIG_DIR: configDir,
      PI_CODING_AGENT_DIR: piAgentDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  }
}

async function runIsolatedMigrationScriptAsync(root: string, code: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const homeDir = join(root, 'home')
  const configDir = join(root, 'craft')
  const piAgentDir = join(root, 'pi-agent')

  const proc = Bun.spawn([
    process.execPath,
    '--eval',
    code,
  ], {
    env: {
      ...process.env,
      TEST_ROOT: root,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CRAFT_CONFIG_DIR: configDir,
      PI_CODING_AGENT_DIR: piAgentDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  }
}

describe('unified migration', () => {
  it('moves agent runtime fields to pi settings and keeps craft-only config fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-unified-migration-config-'))
    try {
      const script = `
        import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
        import { join } from 'path';
        import { runUnifiedMigrationIfNeeded } from ${JSON.stringify(MIGRATION_MODULE)};
        import { CONFIG_DIR, PI_AGENT_DIR } from ${JSON.stringify(PATHS_MODULE)};

        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
          workspaces: [],
          activeWorkspaceId: null,
          activeSessionId: null,
          colorTheme: 'dracula',
          allowRemoteEvaluate: false,
          extendedPromptCache: true,
          enable1MContext: false,
          rtkEnabled: true,
          defaultThinkingLevel: 'max',
          browserToolEnabled: false,
          piShellFullPassthrough: true
        }, null, 2));

        const result = await runUnifiedMigrationIfNeeded();
        const craftConfig = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf-8'));
        const piSettings = JSON.parse(readFileSync(join(PI_AGENT_DIR, 'settings.json'), 'utf-8'));

        console.log(JSON.stringify({
          result,
          markerExists: existsSync(join(CONFIG_DIR, '.unified-migration-completed')),
          craftConfig,
          piSettings,
        }));
      `

      const result = runIsolatedMigrationScript(root, script)
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        result: { migratedConfigFields: number; skipped: boolean }
        markerExists: boolean
        craftConfig: Record<string, unknown>
        piSettings: {
          defaultThinkingLevel?: string
          craft?: { agent?: Record<string, unknown> }
          shellGui?: { craft?: Record<string, unknown> }
        }
      }

      expect(parsed.result.skipped).toBe(false)
      expect(parsed.result.migratedConfigFields).toBe(6)
      expect(parsed.markerExists).toBe(true)

      expect(parsed.craftConfig.colorTheme).toBe('dracula')
      expect(parsed.craftConfig.allowRemoteEvaluate).toBe(false)
      expect(parsed.craftConfig.extendedPromptCache).toBeUndefined()
      expect(parsed.craftConfig.enable1MContext).toBeUndefined()
      expect(parsed.craftConfig.rtkEnabled).toBeUndefined()
      expect(parsed.craftConfig.defaultThinkingLevel).toBeUndefined()
      expect(parsed.craftConfig.browserToolEnabled).toBeUndefined()
      expect(parsed.craftConfig.piShellFullPassthrough).toBeUndefined()

      expect(parsed.piSettings.defaultThinkingLevel).toBe('max')
      expect(parsed.piSettings.craft?.agent).toEqual({
        extendedPromptCache: true,
        enable1MContext: false,
        rtkEnabled: true,
      })
      expect(parsed.piSettings.shellGui?.craft).toMatchObject({
        browserToolEnabled: false,
        piShellFullPassthrough: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('uses an alternate session target on collision and still completes migration', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-unified-migration-'))
    try {
      const script = `
        import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
        import { join } from 'path';
        import { runUnifiedMigrationIfNeeded } from ${JSON.stringify(MIGRATION_MODULE)};
        import { CONFIG_DIR, PI_AGENT_DIR, encodePiSessionCwd } from ${JSON.stringify(PATHS_MODULE)};
        import { buildPiSessionFileName } from ${JSON.stringify(STORAGE_MODULE)};

        const root = process.env.TEST_ROOT;
        const workspaceRoot = join(CONFIG_DIR, 'workspaces', 'ws');
        const projectRoot = join(root, 'project');
        const sessionsRoot = join(workspaceRoot, 'sessions');
        mkdirSync(projectRoot, { recursive: true });
        mkdirSync(sessionsRoot, { recursive: true });
        mkdirSync(join(process.env.HOME, '.agents'), { recursive: true });
        writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
          id: 'ws',
          name: 'Workspace',
          slug: 'ws',
          defaults: { workingDirectory: projectRoot },
          createdAt: 0,
          updatedAt: 0,
        }));

        function writeLegacySession(id, createdAt) {
          const dir = join(sessionsRoot, id);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({
            id,
            workspaceRootPath: workspaceRoot,
            createdAt,
            lastUsedAt: createdAt,
            workingDirectory: projectRoot,
          }) + '\\n');
        }

        const okCreatedAt = 1700000000000;
        const conflictCreatedAt = 1700000001000;
        writeLegacySession('ok-session', okCreatedAt);
        writeLegacySession('conflict-session', conflictCreatedAt);

        const bucket = join(PI_AGENT_DIR, 'sessions', encodePiSessionCwd(projectRoot));
        mkdirSync(bucket, { recursive: true });
        const okTarget = join(bucket, buildPiSessionFileName('ok-session', okCreatedAt));
        const conflictTarget = join(bucket, buildPiSessionFileName('conflict-session', conflictCreatedAt));
        writeFileSync(conflictTarget, JSON.stringify({
          type: 'session',
          version: 3,
          id: 'conflict-session',
          timestamp: new Date(conflictCreatedAt).toISOString(),
          cwd: projectRoot,
        }) + '\\n');

        let threw = false;
        let message = '';
        let migrationResult = null;
        try {
          migrationResult = await runUnifiedMigrationIfNeeded();
        } catch (error) {
          threw = true;
          message = error instanceof Error ? error.message : String(error);
        }

        console.log(JSON.stringify({
          threw,
          message,
          migrationResult,
          markerExists: existsSync(join(CONFIG_DIR, '.unified-migration-completed')),
          okTargetExists: existsSync(okTarget),
          conflictTargetExists: existsSync(conflictTarget),
          oldOkExists: existsSync(join(sessionsRoot, 'ok-session', 'session.jsonl')),
          oldConflictExists: existsSync(join(sessionsRoot, 'conflict-session', 'session.jsonl')),
          bucketFiles: readdirSync(bucket).sort(),
        }));
      `

      const result = runIsolatedMigrationScript(root, script)
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        threw: boolean
        message: string
        migrationResult: { migratedSessions: number; skipped: boolean } | null
        markerExists: boolean
        okTargetExists: boolean
        conflictTargetExists: boolean
        oldOkExists: boolean
        oldConflictExists: boolean
        bucketFiles: string[]
      }

      expect(parsed.threw).toBe(false)
      expect(parsed.message).toBe('')
      expect(parsed.migrationResult?.skipped).toBe(false)
      expect(parsed.migrationResult?.migratedSessions).toBe(2)
      expect(parsed.markerExists).toBe(true)
      expect(parsed.okTargetExists).toBe(true)
      expect(parsed.conflictTargetExists).toBe(true)
      expect(parsed.oldOkExists).toBe(false)
      expect(parsed.oldConflictExists).toBe(false)
      expect(parsed.bucketFiles).toHaveLength(3)
      expect(parsed.bucketFiles.some(file => file.includes('conflict-session.legacy-1.jsonl'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('reuses an already migrated session target after a marker-write crash window', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-unified-migration-partial-'))
    try {
      const script = `
        import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
        import { join } from 'path';
        import { runUnifiedMigrationIfNeeded } from ${JSON.stringify(MIGRATION_MODULE)};
        import { CONFIG_DIR, PI_AGENT_DIR, encodePiSessionCwd } from ${JSON.stringify(PATHS_MODULE)};
        import { buildPiSessionFileName, getSharedPiSidecarPathForFile } from ${JSON.stringify(STORAGE_MODULE)};
        import { createNewTreeSessionFile } from ${JSON.stringify(TREE_MODULE)};

        const root = process.env.TEST_ROOT;
        const workspaceRoot = join(CONFIG_DIR, 'workspaces', 'ws');
        const projectRoot = join(root, 'project');
        const sessionsRoot = join(workspaceRoot, 'sessions');
        const sessionDir = join(sessionsRoot, 'partial-session');
        const createdAt = 1700000002000;
        mkdirSync(projectRoot, { recursive: true });
        mkdirSync(join(sessionDir, 'attachments'), { recursive: true });
        writeFileSync(join(sessionDir, 'attachments', 'note.txt'), 'keep me');
        writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
          id: 'ws',
          name: 'Workspace',
          slug: 'ws',
          defaults: { workingDirectory: projectRoot },
          createdAt: 0,
          updatedAt: 0,
        }));
        writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify({
          id: 'partial-session',
          workspaceRootPath: workspaceRoot,
          createdAt,
          lastUsedAt: createdAt,
          workingDirectory: projectRoot,
        }) + '\\n');

        const bucket = join(PI_AGENT_DIR, 'sessions', encodePiSessionCwd(projectRoot));
        mkdirSync(bucket, { recursive: true });
        const target = join(bucket, buildPiSessionFileName('partial-session', createdAt));
        createNewTreeSessionFile(target, {
          craftId: 'partial-session',
          workspaceRootPath: workspaceRoot,
          createdAt,
          lastUsedAt: createdAt,
          workingDirectory: projectRoot,
          messages: [],
        });
        const sidecarDir = getSharedPiSidecarPathForFile(target, 'partial-session');

        const result = await runUnifiedMigrationIfNeeded();

        console.log(JSON.stringify({
          result,
          markerExists: existsSync(join(CONFIG_DIR, '.unified-migration-completed')),
          oldSessionExists: existsSync(join(sessionDir, 'session.jsonl')),
          targetExists: existsSync(target),
          sidecarAttachment: existsSync(join(sidecarDir, 'attachments', 'note.txt'))
            ? readFileSync(join(sidecarDir, 'attachments', 'note.txt'), 'utf-8')
            : null,
          jsonlFiles: readdirSync(bucket).filter(name => name.endsWith('.jsonl')).sort(),
        }));
      `

      const result = runIsolatedMigrationScript(root, script)
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        result: { migratedSessions: number; skipped: boolean }
        markerExists: boolean
        oldSessionExists: boolean
        targetExists: boolean
        sidecarAttachment: string | null
        jsonlFiles: string[]
      }

      expect(parsed.result.skipped).toBe(false)
      expect(parsed.result.migratedSessions).toBe(1)
      expect(parsed.markerExists).toBe(true)
      expect(parsed.oldSessionExists).toBe(false)
      expect(parsed.targetExists).toBe(true)
      expect(parsed.sidecarAttachment).toBe('keep me')
      expect(parsed.jsonlFiles).toHaveLength(1)
      expect(parsed.jsonlFiles[0]).not.toContain('.legacy-')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('skips workspace skills without a workingDirectory instead of blocking startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-unified-migration-skills-'))
    try {
      const script = `
        import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
        import { join } from 'path';
        import { runUnifiedMigrationIfNeeded } from ${JSON.stringify(MIGRATION_MODULE)};
        import { CONFIG_DIR } from ${JSON.stringify(PATHS_MODULE)};

        const workspaceRoot = join(CONFIG_DIR, 'workspaces', 'ws');
        const skillDir = join(workspaceRoot, 'skills', 'local-skill');
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
          id: 'ws',
          name: 'Workspace',
          slug: 'ws',
          defaults: {},
          createdAt: 0,
          updatedAt: 0,
        }));
        writeFileSync(join(skillDir, 'SKILL.md'), '# Local skill');

        const result = await runUnifiedMigrationIfNeeded();

        console.log(JSON.stringify({
          result,
          markerExists: existsSync(join(CONFIG_DIR, '.unified-migration-completed')),
          oldSkillExists: existsSync(join(skillDir, 'SKILL.md'))
            ? readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
            : null,
        }));
      `

      const result = runIsolatedMigrationScript(root, script)
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        result: { migratedSkills: number; skipped: boolean }
        markerExists: boolean
        oldSkillExists: string | null
      }

      expect(parsed.result.skipped).toBe(false)
      expect(parsed.result.migratedSkills).toBe(0)
      expect(parsed.markerExists).toBe(true)
      expect(parsed.oldSkillExists).toBe('# Local skill')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('serializes concurrent one-shot migration attempts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-unified-migration-lock-'))
    try {
      const configDir = join(root, 'craft')
      mkdirSync(configDir, { recursive: true })
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        browserToolEnabled: true,
      }, null, 2))

      const script = `
        import { runUnifiedMigrationIfNeeded } from ${JSON.stringify(MIGRATION_MODULE)};
        const result = await runUnifiedMigrationIfNeeded();
        console.log(JSON.stringify(result));
      `

      const [first, second] = await Promise.all([
        runIsolatedMigrationScriptAsync(root, script),
        runIsolatedMigrationScriptAsync(root, script),
      ])

      expect(first.exitCode).toBe(0)
      expect(second.exitCode).toBe(0)

      const results = [JSON.parse(first.stdout), JSON.parse(second.stdout)] as Array<{ skipped: boolean }>
      expect(results.filter(result => result.skipped)).toHaveLength(1)
      expect(results.filter(result => !result.skipped)).toHaveLength(1)
      expect(existsSync(join(configDir, '.unified-migration-completed'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
