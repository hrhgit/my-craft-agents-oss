import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const mockReadPiGlobalProviders = mock(() => ({} as Record<string, unknown>))
const mockReadPiGlobalSettings = mock(() => ({} as Record<string, unknown>))
const mockSetPiGlobalDefault = mock(async (_provider: string, _model: string, _thinkingLevel?: string) => undefined)
const mockMigratePiGlobalProviderApiKeysToAuth = mock(() => ({
  migrated: 0,
  removedFromModels: 0,
  changed: false,
}))

mock.module('@craft-agent/shared/config', () => ({
  migratePiGlobalProviderApiKeysToAuth: () => mockMigratePiGlobalProviderApiKeysToAuth(),
  readPiGlobalProviders: () => mockReadPiGlobalProviders(),
  readPiGlobalSettings: () => mockReadPiGlobalSettings(),
  setPiGlobalDefault: (provider: string, model: string, thinkingLevel?: string) =>
    mockSetPiGlobalDefault(provider, model, thinkingLevel),
}))

const { syncPiGlobalConfig } = await import('./pi-global-sync.ts')

describe('syncPiGlobalConfig', () => {
  beforeEach(() => {
    mockReadPiGlobalProviders.mockReset()
    mockReadPiGlobalSettings.mockReset()
    mockSetPiGlobalDefault.mockReset()
    mockMigratePiGlobalProviderApiKeysToAuth.mockReset()
    mockReadPiGlobalProviders.mockImplementation(() => ({}))
    mockReadPiGlobalSettings.mockImplementation(() => ({}))
    mockSetPiGlobalDefault.mockImplementation(async () => undefined)
    mockMigratePiGlobalProviderApiKeysToAuth.mockImplementation(() => ({
      migrated: 0,
      removedFromModels: 0,
      changed: false,
    }))
  })

  it('reports a retained Pi provider API-key migration as a configuration change', async () => {
    mockMigratePiGlobalProviderApiKeysToAuth.mockImplementation(() => ({
      migrated: 1,
      removedFromModels: 1,
      changed: true,
    }))

    await expect(syncPiGlobalConfig()).resolves.toEqual({ changed: true })
  })

  it('returns an error when automatic defaultProvider repair fails', async () => {
    mockReadPiGlobalProviders.mockImplementation(() => ({
      anthropic: {
        models: [{ id: 'claude-sonnet-4-6' }],
      },
    }))
    mockReadPiGlobalSettings.mockImplementation(() => ({
      defaultProvider: 'custom-endpoint',
      defaultThinkingLevel: 'medium',
    }))
    mockSetPiGlobalDefault.mockImplementation(async () => {
      throw new Error('settings flush failed')
    })

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await syncPiGlobalConfig()

      expect(result.changed).toBe(false)
      expect(result.error).toContain('settings flush failed')
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
