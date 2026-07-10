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
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          baseUrl: 'https://api.example.com/v1/v1',
          customEndpoint: { api: 'openai-completions' },
          models: [{ id: 'chat-model' }],
          createdAt: Date.now(),
        } as any,
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
        connection: {
          slug: 'custom-anthropic',
          name: 'Custom Anthropic',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          baseUrl: 'https://api.anthropic.com/v1',
          customEndpoint: { api: 'anthropic-messages' },
          models: [{ id: 'claude-sonnet-4-6' }],
          createdAt: Date.now(),
        } as any,
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
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});
