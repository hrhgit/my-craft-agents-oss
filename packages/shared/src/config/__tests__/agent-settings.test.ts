import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'agent-settings.ts')).href

function runEval(code: string): { output: string; root: string; piAgentDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mortise-agent-settings-'))
  const configDir = join(root, 'mortise')
  const piAgentDir = join(configDir, 'agent')
  const result = Bun.spawnSync([process.execPath, '--eval', `import * as settings from '${MODULE_PATH}'; ${code}`], {
    env: { ...process.env, MORTISE_CONFIG_DIR: configDir, PI_CODING_AGENT_DIR: piAgentDir },
    stdout: 'pipe', stderr: 'pipe', cwd: root,
  })
  if (result.exitCode !== 0) throw new Error(`subprocess failed (exit ${result.exitCode})\n${result.stderr.toString()}`)
  return { output: result.stdout.toString().trim(), root, piAgentDir }
}

describe('agent settings storage', () => {
  it('returns the Pi-native main Agent settings without exposing subagent UI state', () => {
    const { output, piAgentDir } = runEval(`
      const snapshot = await settings.getAgentSettingsSnapshot();
      console.log(JSON.stringify({ keys: Object.keys(snapshot), main: snapshot.mainAgent.systemPrompt.includes('expert coding assistant operating inside Mortise') }));
    `)
    expect(JSON.parse(output)).toEqual({ keys: ['schemaVersion', 'mainAgent'], main: true })
    expect(existsSync(join(piAgentDir, 'SYSTEM.md'))).toBe(false)
  })

  it('round-trips main prompt overrides and disabled tools', () => {
    const { output, piAgentDir } = runEval(`
      settings.updateMainAgentSettings({ schemaVersion: 1, systemPrompt: 'Custom system', compactionPrompt: 'Custom compaction', disabledTools: ['write', 'write', 'pwsh'] });
      const snapshot = await settings.getAgentSettingsSnapshot();
      console.log(JSON.stringify({ prompt: snapshot.mainAgent.systemPrompt, compaction: snapshot.mainAgent.compactionPrompt, disabled: snapshot.mainAgent.tools.filter(tool => !tool.enabled).map(tool => tool.name).sort() }));
    `)
    expect(JSON.parse(output)).toEqual({ prompt: 'Custom system', compaction: 'Custom compaction', disabled: ['pwsh', 'write'] })
    expect(JSON.parse(readFileSync(join(piAgentDir, 'settings.json'), 'utf8')).mortise.agent.disabledTools).toEqual(['write', 'pwsh'])
  })

  it('discovers global and Workspace Markdown and lets Workspace override the same ID', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-agent-discovery-'))
    const agentDir = join(root, 'global')
    const workspace = join(root, 'workspace')
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(join(workspace, '.mortise', 'agents'), { recursive: true })
    writeFileSync(join(agentDir, 'agents', 'reviewer.md'), '---\nname: Global\ndescription: Global reviewer\ntools:\n  - read\nmodel: global/model\n---\n\nGlobal prompt.\n')
    writeFileSync(join(workspace, '.mortise', 'agents', 'reviewer.md'), '---\nname: Workspace\ndescription: Workspace reviewer\ntools:\n  - read\n  - grep\nthinkingLevel: high\n---\n\nWorkspace prompt.\n')
    const result = Bun.spawnSync([process.execPath, '--eval', `import * as settings from '${MODULE_PATH}'; console.log(JSON.stringify(await settings.resolveSubagentConfigs({ agentDir: ${JSON.stringify(agentDir)}, cwd: ${JSON.stringify(workspace)} })));`], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    const resolved = JSON.parse(result.stdout.toString())
    const reviewer = resolved.agents.find((agent: { id: string }) => agent.id === 'reviewer')
    expect(reviewer).toMatchObject({ name: 'Workspace', source: 'workspace', tools: ['read', 'grep'], thinkingLevel: 'high', systemPrompt: 'Workspace prompt.' })
    expect(resolved.agents.filter((agent: { id: string }) => agent.id === 'reviewer')).toHaveLength(1)
  })

  it('reports a bad file and continues discovering valid files', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-agent-bad-file-'))
    const agentDir = join(root, 'global')
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    writeFileSync(join(agentDir, 'agents', 'good.md'), '---\nname: Good\ndescription: Valid\ntools: [read]\n---\n\nGood prompt.\n')
    writeFileSync(join(agentDir, 'agents', 'bad.md'), '---\nname: Bad\n---\n')
    const result = Bun.spawnSync([process.execPath, '--eval', `import * as settings from '${MODULE_PATH}'; console.log(JSON.stringify(await settings.resolveSubagentConfigs({ agentDir: ${JSON.stringify(agentDir)}, cwd: ${JSON.stringify(root)} })));`], { stdout: 'pipe', stderr: 'pipe' })
    const resolved = JSON.parse(result.stdout.toString())
    expect(resolved.agents.some((agent: { id: string }) => agent.id === 'good')).toBe(true)
    expect(resolved.diagnostics).toHaveLength(1)
    expect(resolved.diagnostics[0].path).toEndWith('bad.md')
  })

  it('namespaces read-only Extension configurations without overriding local IDs', async () => {
    const module = await import('../agent-settings.ts')
    const local = {
      id: 'reviewer',
      name: 'Local reviewer',
      description: 'Local',
      systemPrompt: 'Local prompt.',
      tools: ['read'],
      source: 'global' as const,
      editable: true as const,
      path: '/reviewer.md',
    }
    const extensionCatalog = [{
      id: 'quality',
      loadable: true,
      manifestStatus: 'loaded',
      manifest: {
        subagents: [{
          id: 'reviewer',
          name: 'Extension reviewer',
          description: 'Extension',
          systemPrompt: 'Extension prompt.',
          tools: ['grep'],
        }],
      },
    }]

    const agents = module.normalizeSubagentTemplates([local], [], extensionCatalog as never)
    expect(agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reviewer', source: 'global', editable: true }),
      expect.objectContaining({ id: 'quality:reviewer', source: 'extension', editable: false, extensionId: 'quality' }),
    ]))
  })
})
