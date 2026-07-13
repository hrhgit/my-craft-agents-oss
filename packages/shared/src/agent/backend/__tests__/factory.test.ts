/**
 * Tests for Agent Factory
 *
 * Verifies:
 * - Backend creation for different providers
 * - provider type mapping
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  createBackend,
  fetchBackendModels,
  initializeBackendHostRuntime,
  AGENT_PROVIDER,
  resolveModelForProvider,
  testBackendConnection,
  validateStoredBackendProvider,
} from '../factory.ts';
import type { BackendConfig } from '../types.ts';
import type { Workspace } from '../../../config/storage.ts';
import type { SessionHeader as Session } from '../../../sessions/types.ts';
import { PiAgent } from '../../pi-agent.ts';

// Test helpers
function createTestWorkspace(): Workspace {
  return {
    id: 'test-workspace',
    name: 'Test Workspace',
    slug: 'workspace',
    rootPath: '/test/workspace',
    createdAt: Date.now(),
  };
}

function createTestSession(): Session {
  return {
    craftId: 'test-session',
    name: 'Test Session',
    workspaceRootPath: '/test/workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'ask',
  };
}

function createTestConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: createTestWorkspace(),
    session: createTestSession(),
    isHeadless: true, // Prevent config watchers from starting
    ...overrides,
  };
}

describe('createBackend', () => {
  describe('Anthropic legacy provider', () => {
    it('rejects anthropic as a runtime provider', () => {
      const config = createTestConfig({ provider: 'anthropic' as any });

      expect(() => createBackend(config)).toThrow('Unknown provider: anthropic');
    });
  });

  describe('Pi provider', () => {
    it('should create PiAgent for pi provider', () => {
      const config = createTestConfig({ provider: 'pi' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(PiAgent);
    });
  });

  describe('Unknown provider', () => {
    it('should throw for unknown provider', () => {
      const config = createTestConfig({ provider: 'unknown' as any });

      expect(() => createBackend(config)).toThrow('Unknown provider: unknown');
    });
  });
});

describe('AGENT_PROVIDER', () => {
  it('routes all LlmProviderType values to the Pi backend', () => {
    expect(AGENT_PROVIDER).toBe('pi');
  });
});

describe('phase4 backend abstraction APIs', () => {
  it('initializeBackendHostRuntime bootstraps without throwing in dev runtime', () => {
    expect(() => initializeBackendHostRuntime({
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    })).not.toThrow();
  });

  it('fetchBackendModels dispatches for pi provider', async () => {
    const result = await fetchBackendModels({
      providerKey: 'anthropic',
      providerConfig: {},
      credentials: {},
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validateStoredBackendProvider returns not found for unknown provider', async () => {
    const result = await validateStoredBackendProvider({
      providerKey: '__missing-provider__',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Provider not found');
  });

  it('testBackendConnection keeps required model argument and validates key presence', async () => {
    const result = await testBackendConnection({
      provider: 'anthropic',
      apiKey: '   ',
      model: 'claude-sonnet-4-6',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('API key is required');
  });
});

describe('resolveModelForProvider', () => {
  it('falls back to the first provider model when a stale model is not available', () => {
    const provider = { models: [{ id: 'pi/claude-opus-4-7' }, { id: 'pi/claude-sonnet-4-6' }] };
    expect(resolveModelForProvider('pi', 'pi/claude-opus-4-6', provider)).toBe('pi/claude-opus-4-7');
  });
});

describe('PiAgent model switching', () => {
  it('setModel updates getModel (regression: setModel used to write config.model but getModel reads _model)', () => {
    const agent = createBackend(createTestConfig({ provider: 'pi', model: 'claude-opus-4-7' }));

    expect(agent.getModel()).toBe('claude-opus-4-7');

    agent.setModel('claude-sonnet-4-6');

    expect(agent.getModel()).toBe('claude-sonnet-4-6');
  });
});
