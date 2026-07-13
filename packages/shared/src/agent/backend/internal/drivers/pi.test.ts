import { describe, expect, it } from 'bun:test';
import { piDriver } from './pi.ts';

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('normalizes OpenAI-compatible runtime base URLs before passing them to Pi', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key_with_endpoint',
        resolvedModel: 'chat-model',
        capabilities: { needsHttpPoolServer: false },
        providerKey: 'custom-endpoint',
        providerConfig: {
          baseUrl: 'https://api.example.com/v1/v1',
          api: 'openai-completions',
          models: [{ id: 'chat-model' }],
        },
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.baseUrl).toBe('https://api.example.com/v1');
  });

  it('normalizes Anthropic-compatible runtime base URLs before passing them to Pi', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key_with_endpoint',
        resolvedModel: 'claude-sonnet-4-6',
        capabilities: { needsHttpPoolServer: false },
        providerKey: 'custom-anthropic',
        providerConfig: {
          baseUrl: 'https://api.anthropic.com/v1',
          api: 'anthropic-messages',
          models: [{ id: 'claude-sonnet-4-6' }],
        },
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.baseUrl).toBe('https://api.anthropic.com');
  });

  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        providerKey: 'custom-endpoint',
        providerConfig: {
          baseUrl: 'http://127.0.0.1:11111/v1',
          api: 'anthropic-messages',
          models: [
            { id: 'vision-model', contextWindow: 262_144, input: ['text', 'image'] },
            { id: 'text-only-model', input: ['text'] },
            { id: 'plain-model' },
          ],
        },
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      'text-only-model',
      'plain-model',
    ]);
  });
});
