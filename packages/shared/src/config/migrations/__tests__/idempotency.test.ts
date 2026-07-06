import { describe, expect, it } from 'bun:test'
import type { StoredConfig } from '../../storage.ts'
import type { LlmConnection } from '../../llm-connections.ts'
import { migrateCodexCopilotToPi } from '../migrate-llm-connections.ts'
import { migrateLegacyProviderTypes } from '../migrate-provider-types.ts'
import { migrateModelDefaultsToConnections } from '../migrate-model-defaults.ts'
import { migrateLegacyOpusToDefaultOpus } from '../migrate-opus-models.ts'
import { backfillAllConnectionModels } from '../backfill-connection-models.ts'

/**
 * Idempotency tests for pure migration functions.
 *
 * Each migration must satisfy: running it twice on the same config produces
 * the same result, and the second run returns `false` (no further changes).
 * This is a hard requirement for one-shot migrations — if a migration is not
 * idempotent, it will mutate config on every startup and trigger unnecessary
 * disk writes.
 *
 * These tests use in-memory fixtures only — no file IO, no credentials, no
 * workspace config. Functions that perform IO (migrateOrphanedDefaultConnections,
 * migrateWorkspaceLegacyOpusToDefaultOpus) are exercised by the integration
 * tests in __tests__/storage-startup-migration.test.ts instead.
 */

function makeBaseConfig(connections: LlmConnection[]): StoredConfig {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    llmConnections: connections,
  }
}

describe('idempotency — pure migration functions', () => {
  describe('migrateCodexCopilotToPi', () => {
    it('is idempotent on a legacy openai+oauth connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'openai-oauth',
          name: 'OpenAI',
          providerType: 'openai' as LlmConnection['providerType'],
          authType: 'oauth',
          createdAt: Date.now(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          codexPath: '/usr/local/bin/codex',
        } as any as LlmConnection,
      ])

      const changed1 = migrateCodexCopilotToPi(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateCodexCopilotToPi(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('is idempotent on a legacy copilot connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'copilot',
          name: 'Copilot',
          providerType: 'copilot' as LlmConnection['providerType'],
          authType: 'oauth',
          createdAt: Date.now(),
        } as any as LlmConnection,
      ])

      const changed1 = migrateCodexCopilotToPi(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateCodexCopilotToPi(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('returns false on an already-migrated pi connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-openai',
          name: 'ChatGPT Plus (via Pi)',
          providerType: 'pi',
          piAuthProvider: 'openai-codex',
          authType: 'oauth',
          createdAt: Date.now(),
        } as LlmConnection,
      ])

      expect(migrateCodexCopilotToPi(config)).toBe(false)
    })
  })

  describe('migrateLegacyProviderTypes', () => {
    it('is idempotent on a legacy bedrock connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'bedrock',
          name: 'Bedrock',
          providerType: 'bedrock' as LlmConnection['providerType'],
          authType: 'api_key',
          createdAt: Date.now(),
          defaultModel: 'claude-opus-4-8',
          models: ['claude-opus-4-8'],
        } as any as LlmConnection,
      ])

      const changed1 = migrateLegacyProviderTypes(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateLegacyProviderTypes(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('is idempotent on a legacy vertex connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'vertex',
          name: 'Vertex',
          providerType: 'vertex' as LlmConnection['providerType'],
          authType: 'api_key',
          createdAt: Date.now(),
        } as any as LlmConnection,
      ])

      const changed1 = migrateLegacyProviderTypes(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateLegacyProviderTypes(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('is idempotent on a legacy anthropic_compat connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'anthropic-compat',
          name: 'Anthropic Compat',
          providerType: 'anthropic_compat' as LlmConnection['providerType'],
          authType: 'api_key_with_endpoint',
          baseUrl: 'https://gateway.example/v1',
          createdAt: Date.now(),
        } as any as LlmConnection,
      ])

      const changed1 = migrateLegacyProviderTypes(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateLegacyProviderTypes(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })
  })

  describe('migrateModelDefaultsToConnections', () => {
    it('is idempotent when modelDefaults.openai is set', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-openai',
          name: 'Pi (OpenAI)',
          providerType: 'pi',
          piAuthProvider: 'openai',
          authType: 'api_key',
          createdAt: Date.now(),
        } as any as LlmConnection,
      ])
      config.defaultLlmConnection = 'pi-openai'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(config as any).modelDefaults = { openai: 'gpt-4o' }

      const changed1 = migrateModelDefaultsToConnections(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateModelDefaultsToConnections(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('returns false when modelDefaults is absent', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-anthropic',
          name: 'Pi (Anthropic)',
          providerType: 'pi',
          piAuthProvider: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
        } as any as LlmConnection,
      ])

      expect(migrateModelDefaultsToConnections(config)).toBe(false)
    })
  })

  describe('migrateLegacyOpusToDefaultOpus', () => {
    it('is idempotent on a pi+anthropic opus-4-6 default', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-anthropic',
          name: 'Pi (Anthropic)',
          providerType: 'pi',
          piAuthProvider: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
          defaultModel: 'pi/claude-opus-4-6',
          models: [
            { id: 'pi/claude-opus-4-6', name: 'Opus 4.6', provider: 'anthropic', contextWindow: 200_000 },
            { id: 'pi/claude-opus-4-7', name: 'Opus 4.7', provider: 'anthropic', contextWindow: 1_000_000 },
          ],
        } as any as LlmConnection,
      ])

      const changed1 = migrateLegacyOpusToDefaultOpus(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateLegacyOpusToDefaultOpus(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('is idempotent on a pi+anthropic opus-4-5 default', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-anthropic',
          name: 'Pi (Anthropic)',
          providerType: 'pi',
          piAuthProvider: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
          defaultModel: 'pi/claude-opus-4-5-20251101',
          models: ['pi/claude-opus-4-5-20251101', 'pi/claude-sonnet-4-6'],
        } as any as LlmConnection,
      ])

      const changed1 = migrateLegacyOpusToDefaultOpus(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = migrateLegacyOpusToDefaultOpus(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })
  })

  describe('backfillAllConnectionModels', () => {
    it('is idempotent on a pi+anthropic connection with empty models', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-anthropic',
          name: 'Pi (Anthropic)',
          providerType: 'pi',
          piAuthProvider: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
          models: [],
          defaultModel: '',
        } as any as LlmConnection,
      ])

      const changed1 = backfillAllConnectionModels(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = backfillAllConnectionModels(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })

    it('is idempotent on a pi+openai-codex oauth connection', () => {
      const config = makeBaseConfig([
        {
          slug: 'pi-openai-codex',
          name: 'ChatGPT Plus (via Pi)',
          providerType: 'pi',
          piAuthProvider: 'openai-codex',
          authType: 'oauth',
          createdAt: Date.now(),
        } as any as LlmConnection,
      ])

      const changed1 = backfillAllConnectionModels(config)
      expect(changed1).toBe(true)

      const snapshot = structuredClone(config)
      const changed2 = backfillAllConnectionModels(config)
      expect(changed2).toBe(false)
      expect(config).toEqual(snapshot)
    })
  })
})
