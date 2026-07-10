import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setup() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-pi-providers-'))
  const piAgentDir = join(configDir, 'pi-agent')
  mkdirSync(piAgentDir, { recursive: true })

  writeFileSync(
    join(piAgentDir, 'models.json'),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions',
          authHeader: false,
          models: [{ id: 'llama-local', name: 'Llama Local', input: ['text'] }],
        },
        cloud: {
          baseUrl: 'https://example.test/v1',
          api: 'openai-responses',
          authHeader: true,
          models: [{ id: 'gpt-cloud', name: 'GPT Cloud', input: ['text', 'image'], reasoning: true }],
        },
      },
      craftConnections: [
        {
          slug: 'legacy-only',
          name: 'Legacy Only',
          providerType: 'pi_compat',
          authType: 'none',
          createdAt: 1,
        },
        {
          slug: 'pi-cloud',
          name: 'Stale Cloud Shadow',
          providerType: 'pi_compat',
          authType: 'none',
          createdAt: 1,
        },
      ],
    }, null, 2),
    'utf-8',
  )

  writeFileSync(
    join(piAgentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'cloud', defaultModel: 'gpt-cloud' }, null, 2),
    'utf-8',
  )

  return { configDir, piAgentDir }
}

function runStorageScript(env: { configDir: string; piAgentDir: string }, source: string) {
  const run = Bun.spawnSync([process.execPath, '--eval', source], {
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: env.configDir,
      PI_CODING_AGENT_DIR: env.piAgentDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(`storage subprocess failed:\n${run.stderr.toString()}`)
  }
  return JSON.parse(run.stdout.toString())
}

describe('storage derives LLM connections from Pi providers', () => {
  it('projects providers first, keeps non-colliding legacy connections, and uses Pi default', () => {
    const env = setup()
    const result = runStorageScript(env, `
      import { getDefaultLlmConnection, getLlmConnections } from ${JSON.stringify(STORAGE_MODULE_PATH)};
      const connections = getLlmConnections();
      console.log(JSON.stringify({
        slugs: connections.map(c => c.slug),
        cloudName: connections.find(c => c.slug === 'pi-cloud')?.name,
        auth: Object.fromEntries(connections.map(c => [c.slug, c.authType])),
        defaultSlug: getDefaultLlmConnection(),
      }));
    `)

    expect(result.slugs).toEqual(['pi-local', 'pi-cloud', 'legacy-only'])
    expect(result.cloudName).toBe('cloud')
    expect(result.auth).toMatchObject({
      'pi-local': 'none',
      'pi-cloud': 'api_key_with_endpoint',
      'legacy-only': 'none',
    })
    expect(result.defaultSlug).toBe('pi-cloud')
  })

  it('writes model image capability changes back to provider models', () => {
    const env = setup()
    const result = runStorageScript(env, `
      import { readFileSync } from 'fs';
      import { join } from 'path';
      import { updateLlmConnection } from ${JSON.stringify(STORAGE_MODULE_PATH)};
      const ok = updateLlmConnection('pi-local', {
        models: [{
          id: 'llama-local',
          name: 'Llama Local',
          shortName: 'Llama Local',
          description: '',
          provider: 'pi',
          contextWindow: 200000,
          supportsImages: true,
        }],
      });
      const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf-8'));
      console.log(JSON.stringify({
        ok,
        input: models.providers.local.models[0].input,
      }));
    `)

    expect(result.ok).toBe(true)
    expect(result.input).toEqual(['text', 'image'])
  })
})
