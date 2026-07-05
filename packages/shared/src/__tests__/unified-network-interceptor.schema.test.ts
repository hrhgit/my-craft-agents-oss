import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let injectMetadataIntoToolSchema: typeof import('../unified-network-interceptor.ts').injectMetadataIntoToolSchema;
let sanitizeEmptyTextCacheControl: typeof import('../unified-network-interceptor.ts').sanitizeEmptyTextCacheControl;
let upgradePromptCacheTtl: typeof import('../unified-network-interceptor.ts').upgradePromptCacheTtl;
let _resetConfigCacheForTesting: typeof import('../interceptor-common.ts')._resetConfigCacheForTesting;

let tempRoot: string;
let piAgentDir: string;
let previousCraftConfigDir: string | undefined;
let previousPiAgentDir: string | undefined;

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'craft-interceptor-settings-'));
  piAgentDir = join(tempRoot, 'pi-agent');
  previousCraftConfigDir = process.env.CRAFT_CONFIG_DIR;
  previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.CRAFT_CONFIG_DIR = join(tempRoot, 'craft');
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  mkdirSync(piAgentDir, { recursive: true });

  ({ injectMetadataIntoToolSchema, sanitizeEmptyTextCacheControl, upgradePromptCacheTtl } = await import('../unified-network-interceptor.ts'));
  ({ _resetConfigCacheForTesting } = await import('../interceptor-common.ts'));
});

afterAll(() => {
  if (previousCraftConfigDir === undefined) {
    delete process.env.CRAFT_CONFIG_DIR;
  } else {
    process.env.CRAFT_CONFIG_DIR = previousCraftConfigDir;
  }

  if (previousPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }

  rmSync(tempRoot, { recursive: true, force: true });
});

describe('unified-network-interceptor schema metadata injection', () => {
  it('injects metadata fields into empty/zero-arg schemas', () => {
    const schema = { type: 'object' };
    const result = injectMetadataIntoToolSchema(schema);

    expect(result.properties._displayName).toBeDefined();
    expect(result.properties._intent).toBeDefined();
    expect(result.required).toContain('_displayName');
    expect(result.required).toContain('_intent');
  });

  it('preserves existing properties and required keys while prepending metadata keys', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    };

    const result = injectMetadataIntoToolSchema(schema);

    expect(result.properties.url).toEqual({ type: 'string' });
    expect(result.required).toEqual(['_displayName', '_intent', 'url']);
  });

  it('does not duplicate metadata keys when already present in required', () => {
    const schema = {
      properties: {
        _displayName: { type: 'string', description: 'custom display name schema' },
        _intent: { type: 'string', description: 'custom intent schema' },
      },
      required: ['_intent', '_displayName'],
    };

    const result = injectMetadataIntoToolSchema(schema);

    expect(result.required).toEqual(['_displayName', '_intent']);
    expect(result.properties._displayName).toEqual({ type: 'string', description: 'custom display name schema' });
    expect(result.properties._intent).toEqual({ type: 'string', description: 'custom intent schema' });
  });
});

describe('sanitizeEmptyTextCacheControl', () => {
  it('strips cache_control from empty text blocks', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        ],
      }],
    };

    const stripped = sanitizeEmptyTextCacheControl(body);

    expect(stripped).toBe(1);
    expect((body.messages[0]!.content as any[])[0].cache_control).toBeUndefined();
    expect((body.messages[0]!.content as any[])[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips cache_control from whitespace-only text blocks', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '   \n\t  ', cache_control: { type: 'ephemeral' } },
        ],
      }],
    };

    const stripped = sanitizeEmptyTextCacheControl(body);

    expect(stripped).toBe(1);
    expect((body.messages[0]!.content as any[])[0].cache_control).toBeUndefined();
  });

  it('leaves non-text blocks untouched', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: {}, cache_control: { type: 'ephemeral' } },
        ],
      }],
    };

    const stripped = sanitizeEmptyTextCacheControl(body);

    expect(stripped).toBe(0);
    expect((body.messages[0]!.content as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles messages without content arrays', () => {
    const body = {
      messages: [{ role: 'user', content: 'plain string' }],
    };

    const stripped = sanitizeEmptyTextCacheControl(body);
    expect(stripped).toBe(0);
  });

  it('returns 0 when no messages present', () => {
    expect(sanitizeEmptyTextCacheControl({})).toBe(0);
  });
});

describe('upgradePromptCacheTtl', () => {
  afterEach(() => {
    _resetConfigCacheForTesting();
  });

  function writeAgentSettings(extendedPromptCache: boolean) {
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(
      join(piAgentDir, 'settings.json'),
      JSON.stringify({ craft: { agent: { extendedPromptCache } } }, null, 2),
      'utf-8',
    );
  }

  function enableExtendedCache() {
    writeAgentSettings(true);
  }

  function disableExtendedCache() {
    writeAgentSettings(false);
  }

  it('leaves blocks without ttl untouched when disabled', () => {
    disableExtendedCache();
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        ],
      }],
    };

    const result = upgradePromptCacheTtl(body);

    expect(result).toBe(0);
    expect((body.messages[0]!.content as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips ttl from message content when disabled', () => {
    disableExtendedCache();
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'world', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
      }],
    };

    const stripped = upgradePromptCacheTtl(body);

    expect(stripped).toBe(2);
    expect((body.messages[0]!.content as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((body.messages[0]!.content as any[])[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips ttl from system prompt when disabled', () => {
    disableExtendedCache();
    const body = {
      system: [
        { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [],
    };

    const stripped = upgradePromptCacheTtl(body);

    expect(stripped).toBe(1);
    expect((body.system as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips ttl from top-level cache_control when disabled', () => {
    disableExtendedCache();
    const body = {
      cache_control: { type: 'ephemeral', ttl: '1h' },
      messages: [],
    };

    const stripped = upgradePromptCacheTtl(body);

    expect(stripped).toBe(1);
    expect(body.cache_control as any).toEqual({ type: 'ephemeral' });
  });

  it('upgrades message content cache_control to 1h when enabled', () => {
    enableExtendedCache();
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'world', cache_control: { type: 'ephemeral' } },
        ],
      }],
    };

    const upgraded = upgradePromptCacheTtl(body);

    expect(upgraded).toBe(2);
    expect((body.messages[0]!.content as any[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((body.messages[0]!.content as any[])[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('upgrades system prompt cache_control to 1h when enabled', () => {
    enableExtendedCache();
    const body = {
      system: [
        { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    };

    const upgraded = upgradePromptCacheTtl(body);

    expect(upgraded).toBe(1);
    expect((body.system as any[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('upgrades top-level cache_control (auto-caching mode) when enabled', () => {
    enableExtendedCache();
    const body = {
      cache_control: { type: 'ephemeral' },
      messages: [],
    };

    const upgraded = upgradePromptCacheTtl(body);

    expect(upgraded).toBe(1);
    expect(body.cache_control as any).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('leaves blocks without cache_control untouched', () => {
    enableExtendedCache();
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'no cache' },
        ],
      }],
    };

    const upgraded = upgradePromptCacheTtl(body);

    expect(upgraded).toBe(0);
    expect((body.messages[0]!.content as any[])[0].cache_control).toBeUndefined();
  });

  it('does not upgrade blocks that already have 1h TTL', () => {
    enableExtendedCache();
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'already cached', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
      }],
    };

    const upgraded = upgradePromptCacheTtl(body);

    // Still counts as upgraded (idempotent set), but that's fine
    expect(upgraded).toBe(1);
    expect((body.messages[0]!.content as any[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('returns 0 when no messages or system prompt', () => {
    enableExtendedCache();
    expect(upgradePromptCacheTtl({})).toBe(0);
  });

  // Regression for the screenshot bug: when extendedPromptCache is enabled,
  // we upgraded system+messages to 1h but left a 5m cache_control on a tool
  // untouched. Anthropic processes blocks in order `tools → system → messages`
  // and rejects "1h after 5m", so the tools walk has to keep up.
  it('upgrades tool cache_control to 1h when enabled', () => {
    enableExtendedCache();
    const body = {
      tools: [
        { name: 'search', description: 'do a search', cache_control: { type: 'ephemeral' } },
        { name: 'fetch', description: 'fetch a url', cache_control: { type: 'ephemeral' } },
      ],
      system: [
        { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    };

    const upgraded = upgradePromptCacheTtl(body);

    expect(upgraded).toBe(3);
    expect((body.tools as any[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((body.tools as any[])[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((body.system as any[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('strips ttl from tool cache_control when disabled', () => {
    disableExtendedCache();
    const body = {
      tools: [
        { name: 'search', description: 'do a search', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [],
    };

    const stripped = upgradePromptCacheTtl(body);

    expect(stripped).toBe(1);
    expect((body.tools as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
