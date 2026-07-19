import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const PI_GLOBAL_CONFIG_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'pi-global-config.ts')).href
const CONFIG_WATCHER_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'watcher.ts')).href
const MASKED_SHORT_KEY = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

function setupPiAgentDir() {
  const piAgentDir = mkdtempSync(join(tmpdir(), 'mortise-pi-agent-'))
  mkdirSync(piAgentDir, { recursive: true })
  return {
    piAgentDir,
    modelsPath: join(piAgentDir, 'models.json'),
    authPath: join(piAgentDir, 'auth.json'),
  }
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

function runIsolatedPiConfigScript<T>(piAgentDir: string, body: string): T {
  const code = `
    import {
      migratePiGlobalProviderApiKeysToAuth,
      savePiGlobalProvider,
      readPiGlobalProvidersForDisplay,
      getPiGlobalProviderKeyForConnection,
      hasPiGlobalAuthForConnection,
      maskApiKey,
      watchPiGlobalModelsFile,
    } from ${JSON.stringify(PI_GLOBAL_CONFIG_MODULE_PATH)};
    import { mkdirSync, readFileSync, writeFileSync } from 'fs';
    import { join } from 'path';
    const piAgentDir = process.env.PI_CODING_AGENT_DIR;
    ${body}
  `
  const run = Bun.spawnSync([process.execPath, '--eval', code], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piAgentDir,
      MORTISE_CONFIG_DIR: join(piAgentDir, 'mortise-config'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(
      `pi-global-config subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`,
    )
  }

  return JSON.parse(run.stdout.toString()) as T
}

describe('pi-global-config auth storage', () => {
  it('notifies global config watchers when auth.json changes', () => {
    const { piAgentDir, authPath } = setupPiAgentDir()
    writeJson(authPath, {})

    const output = runIsolatedPiConfigScript<{ changed: boolean; filename: string }>(piAgentDir, `
      const result = await new Promise((resolve, reject) => {
        let watcher;
        const timeout = setTimeout(() => {
          watcher?.close();
          reject(new Error('auth.json watcher timed out'));
        }, 5000);
        watcher = watchPiGlobalModelsFile(() => {
          clearTimeout(timeout);
          watcher.close();
          resolve({ changed: true, filename: 'auth.json' });
        });
        setTimeout(() => {
          writeFileSync(join(piAgentDir, 'auth.json'), JSON.stringify({ test: { type: 'api_key', key: 'changed' } }));
        }, 50);
      });
      console.log(JSON.stringify(result));
    `)

    expect(output).toEqual({ changed: true, filename: 'auth.json' })
  })

  it('propagates an auth-only change through ConfigWatcher provider deduplication', () => {
    const { piAgentDir, modelsPath, authPath } = setupPiAgentDir()
    writeJson(modelsPath, { providers: {} })
    writeJson(authPath, { test: { type: 'api_key', key: 'before' } })

    const output = runIsolatedPiConfigScript<{ changed: boolean }>(piAgentDir, `
      const { ConfigWatcher } = await import(${JSON.stringify(CONFIG_WATCHER_MODULE_PATH)});
      const workspacePath = join(piAgentDir, 'workspace');
      mkdirSync(workspacePath, { recursive: true });
      const result = await new Promise((resolve, reject) => {
        let watcher;
        const timeout = setTimeout(() => {
          watcher?.stop();
          reject(new Error('ConfigWatcher auth propagation timed out'));
        }, 5000);
        watcher = new ConfigWatcher(workspacePath, {
          onProvidersChange() {
            clearTimeout(timeout);
            watcher.stop();
            resolve({ changed: true });
          },
        });
        watcher.start();
        setTimeout(() => {
          writeFileSync(join(piAgentDir, 'auth.json'), JSON.stringify({ test: { type: 'api_key', key: 'after' } }));
        }, 100);
      });
      console.log(JSON.stringify(result));
    `)

    expect(output).toEqual({ changed: true })
  })

  it('migrates legacy provider apiKey fields into auth.json without overwriting existing auth', () => {
    const { piAgentDir, modelsPath, authPath } = setupPiAgentDir()

    writeJson(modelsPath, {
      providers: {
        legacy: {
          baseUrl: 'https://legacy.example/v1',
          api: 'openai-completions',
          apiKey: 'legacy-key',
          models: [{ id: 'legacy-model' }],
        },
        existing: {
          baseUrl: 'https://existing.example/v1',
          api: 'openai-completions',
          apiKey: 'legacy-should-not-win',
          models: [{ id: 'existing-model' }],
        },
        oauth: {
          baseUrl: 'https://oauth.example/v1',
          api: 'openai-completions',
          apiKey: 'legacy-oauth-should-not-win',
          models: [{ id: 'oauth-model' }],
        },
      },
    })
    writeJson(authPath, {
      existing: { type: 'api_key', key: 'existing-key' },
      oauth: { type: 'oauth', access: 'oauth-access', refresh: 'oauth-refresh' },
    })

    const output = runIsolatedPiConfigScript<{
      result: { migrated: number; removedFromModels: number; changed: boolean }
      models: { providers: Record<string, Record<string, unknown>> }
      auth: Record<string, { type: string; key?: string; access?: string }>
    }>(piAgentDir, `
      const result = migratePiGlobalProviderApiKeysToAuth();
      const models = JSON.parse(readFileSync(join(piAgentDir, 'models.json'), 'utf-8'));
      const auth = JSON.parse(readFileSync(join(piAgentDir, 'auth.json'), 'utf-8'));
      console.log(JSON.stringify({ result, models, auth }));
    `)

    expect(output.result).toEqual({ migrated: 1, removedFromModels: 3, changed: true })
    expect(output.models.providers.legacy!.apiKey).toBeUndefined()
    expect(output.models.providers.existing!.apiKey).toBeUndefined()
    expect(output.models.providers.oauth!.apiKey).toBeUndefined()
    expect(output.auth.legacy).toEqual({ type: 'api_key', key: 'legacy-key' })
    expect(output.auth.existing).toEqual({ type: 'api_key', key: 'existing-key' })
    expect(output.auth.oauth!.type).toBe('oauth')
    expect(output.auth.oauth!.access).toBe('oauth-access')
  })

  it('saves provider credentials to auth.json and keeps models.json sanitized', () => {
    const { piAgentDir, modelsPath, authPath } = setupPiAgentDir()
    writeJson(modelsPath, { providers: {} })
    writeJson(authPath, {})

    const output = runIsolatedPiConfigScript<{
      models: { providers: Record<string, Record<string, unknown>> }
      auth: Record<string, { type: string; key?: string }>
      display: { apiKeyMasked: string; provider: Record<string, unknown> }
      shortMask: string
      longMask: string
    }>(piAgentDir, `
      savePiGlobalProvider('my-provider', {
        baseUrl: 'https://one.example/v1',
        api: 'openai-completions',
        apiKey: 'initial-short',
        models: [{ id: 'one' }],
      });
      savePiGlobalProvider('my-provider', {
        baseUrl: 'https://two.example/v1',
        api: 'openai-completions',
        models: [{ id: 'two' }],
      });
      savePiGlobalProvider('root-openai-provider', {
        baseUrl: 'https://root-openai.example',
        api: 'openai-completions',
        models: [{ id: 'root-model' }],
      });
      savePiGlobalProvider('anthropic-provider', {
        baseUrl: 'https://api.anthropic.com/v1',
        api: 'anthropic-messages',
        models: [{ id: 'claude-sonnet-4-6' }],
      });
      const models = JSON.parse(readFileSync(join(piAgentDir, 'models.json'), 'utf-8'));
      const auth = JSON.parse(readFileSync(join(piAgentDir, 'auth.json'), 'utf-8'));
      const display = readPiGlobalProvidersForDisplay().find(entry => entry.key === 'my-provider');
      console.log(JSON.stringify({
        models,
        auth,
        display,
        shortMask: maskApiKey('short-secret'),
        longMask: maskApiKey('sk-live-abcdefghijklmnop'),
      }));
    `)

    expect(output.models.providers['my-provider']!.apiKey).toBeUndefined()
    expect(output.models.providers['my-provider']!.baseUrl).toBe('https://two.example/v1')
    expect(output.models.providers['root-openai-provider']!.baseUrl).toBe('https://root-openai.example/v1')
    expect(output.models.providers['anthropic-provider']!.baseUrl).toBe('https://api.anthropic.com')
    expect(output.auth['my-provider']).toEqual({ type: 'api_key', key: 'initial-short' })
    expect(output.display.provider.apiKey).toBeUndefined()
    expect(output.display.apiKeyMasked).toBe(MASKED_SHORT_KEY)
    expect(output.shortMask).toBe(MASKED_SHORT_KEY)
    expect(output.longMask).toBe('sk-live...mnop')
  })

  it('resolves Pi auth provider keys without treating pi-api-key as a provider name', () => {
    const { piAgentDir, modelsPath, authPath } = setupPiAgentDir()
    writeJson(modelsPath, {
      providers: {
        'my-provider': {
          baseUrl: 'https://my-provider.example/v1',
          api: 'openai-completions',
          models: [{ id: 'model' }],
        },
      },
    })
    writeJson(authPath, {
      anthropic: { type: 'api_key', key: 'anthropic-key' },
      'my-provider': { type: 'api_key', key: 'my-provider-key' },
    })

    const output = runIsolatedPiConfigScript<{
      genericPiProviderKey: string | undefined
      genericPiWithoutProviderKey: string | undefined
      globalCompatProviderKey: string | undefined
      hasBuiltInAnthropicAuth: boolean
      hasGlobalCompatAuth: boolean
      hasBorrowedCustomCompatAuth: boolean
    }>(piAgentDir, `
      const genericPi = { slug: 'pi-api-key', providerType: 'pi', piAuthProvider: 'anthropic' };
      const genericPiWithoutProvider = { slug: 'pi-api-key-2', providerType: 'pi' };
      const globalCompat = { slug: 'pi-my-provider', providerType: 'pi_compat' };
      const customCompat = { slug: 'custom-compat', providerType: 'pi_compat', piAuthProvider: 'anthropic' };
      console.log(JSON.stringify({
        genericPiProviderKey: getPiGlobalProviderKeyForConnection(genericPi),
        genericPiWithoutProviderKey: getPiGlobalProviderKeyForConnection(genericPiWithoutProvider),
        globalCompatProviderKey: getPiGlobalProviderKeyForConnection(globalCompat),
        hasBuiltInAnthropicAuth: hasPiGlobalAuthForConnection(genericPi),
        hasGlobalCompatAuth: hasPiGlobalAuthForConnection(globalCompat),
        hasBorrowedCustomCompatAuth: hasPiGlobalAuthForConnection(customCompat),
      }));
    `)

    expect(output.genericPiProviderKey).toBe('anthropic')
    expect(output.genericPiWithoutProviderKey).toBeUndefined()
    expect(output.globalCompatProviderKey).toBe('my-provider')
    expect(output.hasBuiltInAnthropicAuth).toBe(true)
    expect(output.hasGlobalCompatAuth).toBe(true)
    expect(output.hasBorrowedCustomCompatAuth).toBe(false)
  })
})
