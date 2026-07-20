import { describe, expect, it } from 'bun:test';
import { resolvePiModelReference, type PiGlobalSettings } from '../pi-global-config.ts';

const settings: PiGlobalSettings = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet',
  defaultThinkingLevel: 'medium',
  defaultSlots: [
    { slot: 1, provider: 'anthropic', model: 'claude-sonnet', thinkingLevel: 'medium' },
    { slot: 5, provider: 'openai', model: 'gpt-5', thinkingLevel: 'xhigh' },
  ],
};

describe('Pi model references', () => {
  it('resolves current-session at invocation time', () => {
    expect(resolvePiModelReference('current-session', {
      current: { provider: 'openrouter', model: 'qwen/qwen3' },
      settings,
    })).toEqual({ provider: 'openrouter', model: 'qwen/qwen3' });
  });

  it('resolves configured default slots and reports missing slots', () => {
    expect(resolvePiModelReference('default:1', { settings })).toEqual({ provider: 'anthropic', model: 'claude-sonnet', thinkingLevel: 'medium' });
    expect(resolvePiModelReference('default:5', { settings })).toEqual({ provider: 'openai', model: 'gpt-5', thinkingLevel: 'xhigh' });
    expect(resolvePiModelReference('default:3', { settings })).toBeUndefined();
  });

  it('keeps provider-qualified explicit models unambiguous', () => {
    expect(resolvePiModelReference('model:openrouter/qwen/qwen3', { settings }))
      .toEqual({ provider: 'openrouter', model: 'qwen/qwen3' });
  });
});
