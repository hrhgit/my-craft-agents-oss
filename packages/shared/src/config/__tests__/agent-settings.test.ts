import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'agent-settings.ts')).href

function runEval(code: string): { output: string; piAgentDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mortise-agent-settings-'))
  const piAgentDir = join(root, 'pi-agent')
  const result = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as settings from '${MODULE_PATH}'; ${code}`,
  ], {
    env: {
      ...process.env,
      MORTISE_CONFIG_DIR: join(root, 'mortise'),
      PI_CODING_AGENT_DIR: piAgentDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${result.exitCode})\n${result.stderr.toString()}`)
  }
  return { output: result.stdout.toString().trim(), piAgentDir }
}

describe('agent settings storage', () => {
  it('returns Mortise defaults without freezing them into override files', () => {
    const { output, piAgentDir } = runEval(`
      const snapshot = settings.getAgentSettingsSnapshot();
      console.log(JSON.stringify({
        systemSource: snapshot.mainAgent.systemPromptSource,
        compactionSource: snapshot.mainAgent.compactionPromptSource,
        isMortisePrompt: snapshot.mainAgent.systemPrompt.includes('Mortise'),
        tools: snapshot.mainAgent.tools.map((tool) => tool.name),
        browserSource: snapshot.mainAgent.tools.find((tool) => tool.name === 'browser_tool')?.source,
        sourceTestSource: snapshot.mainAgent.tools.find((tool) => tool.name === 'source_test')?.source,
      }));
    `)
    expect(JSON.parse(output)).toEqual({
      systemSource: 'default',
      compactionSource: 'default',
      isMortisePrompt: true,
      tools: expect.arrayContaining(['read', 'edit', 'write', 'grep', 'find', 'ls', 'web_fetch', 'source_test', 'spawn_session']),
      browserSource: 'extension',
      sourceTestSource: 'host',
    })
    expect(existsSync(join(piAgentDir, 'SYSTEM.md'))).toBe(false)
    expect(existsSync(join(piAgentDir, 'COMPACTION.md'))).toBe(false)
  })

  it('round-trips prompt overrides and disabled tools through Pi storage', () => {
    const { output, piAgentDir } = runEval(`
      settings.updateMainAgentSettings({
        schemaVersion: 1,
        systemPrompt: 'Custom system',
        compactionPrompt: 'Custom compaction',
        disabledTools: ['write', 'write', 'pwsh'],
      });
      const snapshot = settings.getAgentSettingsSnapshot();
      console.log(JSON.stringify({
        systemPrompt: snapshot.mainAgent.systemPrompt,
        runtimeSystemPrompt: settings.resolveMainAgentSystemPrompt('Mortise default'),
        compactionPrompt: snapshot.mainAgent.compactionPrompt,
        disabled: snapshot.mainAgent.tools.filter((tool) => !tool.enabled).map((tool) => tool.name).sort(),
      }));
    `)
    expect(JSON.parse(output)).toEqual({
      systemPrompt: 'Custom system',
      runtimeSystemPrompt: 'Custom system',
      compactionPrompt: 'Custom compaction',
      disabled: ['pwsh', 'write'],
    })
    const piSettings = JSON.parse(readFileSync(join(piAgentDir, 'settings.json'), 'utf8'))
    expect(piSettings.mortise.agent.disabledTools).toEqual(['write', 'pwsh'])
  })

  it('migrates legacy session tool names in disabled-tool settings', () => {
    const { output } = runEval(`
      settings.updateMainAgentSettings({
        schemaVersion: 1,
        systemPrompt: null,
        compactionPrompt: null,
        disabledTools: ['mcp__session__source_test'],
      });
      const snapshot = settings.getAgentSettingsSnapshot();
      console.log(JSON.stringify(snapshot.mainAgent.tools
        .filter((tool) => !tool.enabled)
        .map((tool) => tool.name)));
    `)
    expect(JSON.parse(output)).toEqual(['source_test'])
  })

  it('uses the native Pi markdown format for subagents', () => {
    const { output, piAgentDir } = runEval(`
      settings.upsertSubagent({
        schemaVersion: 1,
        agent: {
          id: 'code-reviewer',
          name: 'Code Reviewer',
          description: 'Reviews code changes',
          systemPrompt: 'Review changes carefully.',
          tools: ['read', 'grep'],
        },
      });
      console.log(JSON.stringify(settings.listSubagents()));
    `)
    expect(JSON.parse(output)).toEqual([{
      id: 'code-reviewer',
      name: 'Code Reviewer',
      description: 'Reviews code changes',
      systemPrompt: 'Review changes carefully.',
      tools: ['read', 'grep'],
    }])
    const markdown = readFileSync(join(piAgentDir, 'agents', 'code-reviewer.md'), 'utf8')
    expect(markdown).toContain('name: "Code Reviewer"')
    expect(markdown).toContain('tools: "read, grep"')
  })

  it('migrates legacy session tool names in subagent allowlists', () => {
    const { output, piAgentDir } = runEval(`
      const saved = settings.upsertSubagent({
        schemaVersion: 1,
        agent: {
          id: 'legacy-tools',
          name: 'Legacy Tools',
          description: 'Migration fixture',
          systemPrompt: 'Use the configured tools.',
          tools: ['read', 'mcp__session__source_test'],
        },
      });
      console.log(JSON.stringify(saved.tools));
    `)
    expect(JSON.parse(output)).toEqual(['read', 'source_test'])
    expect(readFileSync(join(piAgentDir, 'agents', 'legacy-tools.md'), 'utf8')).toContain('tools: "read, source_test"')
  })

  it('rejects a rename that would overwrite another subagent', () => {
    const { output } = runEval(`
      const makeAgent = (id, name) => ({
        schemaVersion: 1,
        agent: { id, name, description: name, systemPrompt: name, tools: [] },
      });
      settings.upsertSubagent(makeAgent('first', 'First'));
      settings.upsertSubagent(makeAgent('second', 'Second'));
      try {
        settings.upsertSubagent({
          ...makeAgent('second', 'Renamed'),
          previousId: 'first',
        });
      } catch (error) {
        console.log(error.message);
      }
    `)
    expect(output).toBe('Subagent id already exists: second')
  })

  it('restores Pi defaults by removing custom prompt files', () => {
    const { output, piAgentDir } = runEval(`
      settings.updateMainAgentSettings({
        schemaVersion: 1,
        systemPrompt: 'Custom system',
        compactionPrompt: 'Custom compaction',
        disabledTools: [],
      });
      settings.updateMainAgentSettings({
        schemaVersion: 1,
        systemPrompt: null,
        compactionPrompt: null,
        disabledTools: [],
      });
      const snapshot = settings.getAgentSettingsSnapshot();
      console.log(JSON.stringify([
        snapshot.mainAgent.systemPromptSource,
        snapshot.mainAgent.compactionPromptSource,
        settings.resolveMainAgentSystemPrompt('Mortise default'),
      ]));
    `)
    expect(JSON.parse(output)).toEqual(['default', 'default', 'Mortise default'])
    expect(existsSync(join(piAgentDir, 'SYSTEM.md'))).toBe(false)
    expect(existsSync(join(piAgentDir, 'COMPACTION.md'))).toBe(false)
  })
})
