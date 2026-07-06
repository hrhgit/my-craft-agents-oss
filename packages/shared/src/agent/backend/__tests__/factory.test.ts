/**
 * Tests for Agent Factory
 *
 * Verifies:
 * - Backend creation for different providers
 * - LLM connection type mapping
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  createBackend,
  fetchBackendModels,
  initializeBackendHostRuntime,
  AGENT_PROVIDER,
  resolveModelForProvider,
  resolveSetupTestConnectionHint,
  createBackendFromConnection,
  testBackendConnection,
  validateStoredBackendConnection,
} from '../factory.ts';
import type { BackendConfig } from '../types.ts';
import type { Workspace, LlmConnection } from '../../../config/storage.ts';
import type { SessionHeader as Session } from '../../../sessions/types.ts';
import { PiAgent } from '../../pi-agent.ts';
import { isValidProviderAuthCombination } from '../../../config/llm-connections.ts';

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

// ============================================================
// Provider-Auth Validation Tests
// ============================================================

describe('isValidProviderAuthCombination', () => {
  describe('Legacy Anthropic providerType', () => {
    it('rejects legacy auth combinations', () => {
      for (const authType of ['api_key', 'oauth', 'api_key_with_endpoint', 'none'] as const) {
        expect(isValidProviderAuthCombination('anthropic' as any, authType)).toBe(false);
      }
    });
  });

  describe('Pi provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('pi', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('pi', 'oauth')).toBe(true);
    });

    it('should accept none auth', () => {
      expect(isValidProviderAuthCombination('pi', 'none')).toBe(true);
    });
  });

  describe('Pi compat provider', () => {
    it('should accept api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'api_key_with_endpoint')).toBe(true);
    });

    it('should accept none auth (for local models like Ollama)', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'none')).toBe(true);
    });
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

  it('resolveSetupTestConnectionHint maps provider/baseUrl/piAuthProvider correctly', () => {
    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com',
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'anthropic' });

    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: '',
    })).toEqual({ providerType: 'pi', piAuthProvider: 'anthropic' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      piAuthProvider: 'openai-codex',
    })).toEqual({ providerType: 'pi', piAuthProvider: 'openai-codex' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      customEndpoint: { api: 'openai-completions' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'openai', customEndpoint: { api: 'openai-completions' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://my-anthropic-proxy.internal/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' } });
  });

  it('fetchBackendModels dispatches for pi provider', async () => {
    const connection: LlmConnection = {
      slug: 'pi-test',
      name: 'Pi Test',
      providerType: 'pi',
      authType: 'none',
      createdAt: Date.now(),
    };

    const result = await fetchBackendModels({
      connection,
      credentials: {},
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validateStoredBackendConnection returns not found for unknown slug', async () => {
    const result = await validateStoredBackendConnection({
      slug: '__missing-connection__',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection not found');
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
  it('falls back to the Pi connection default when a normalized stale model is not in the connection list', () => {
    const connection = {
      providerType: 'pi',
      defaultModel: 'pi/claude-opus-4-7',
      models: ['pi/claude-opus-4-7', 'pi/claude-sonnet-4-6'],
    } as unknown as LlmConnection;

    expect(resolveModelForProvider('pi', 'pi/claude-opus-4-6', connection)).toBe('pi/claude-opus-4-7');
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