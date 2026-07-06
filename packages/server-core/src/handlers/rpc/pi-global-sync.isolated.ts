import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const mockReadPiGlobalProviders = mock(() => ({} as Record<string, unknown>))
const mockReadPiGlobalSettings = mock(() => ({} as Record<string, unknown>))
const mockSetPiGlobalDefault = mock(async (_provider: string, _model: string, _thinkingLevel?: string) => undefined)

mock.module('@craft-agent/shared/config', () => ({
  readPiGlobalProviders: () => mockReadPiGlobalProviders(),
  readPiGlobalSettings: () => mockReadPiGlobalSettings(),
  setPiGlobalDefault: (provider: string, model: string, thinkingLevel?: string) =>
    mockSetPiGlobalDefault(provider, model, thinkingLevel),
}))

const { syncPiGlobalToLlmConnections } = await import('./pi-global-sync.ts')

describe('syncPiGlobalToLlmConnections', () => {
  beforeEach(() => {
    mockReadPiGlobalProviders.mockReset()
    mockReadPiGlobalSettings.mockReset()
    mockSetPiGlobalDefault.mockReset()
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
      const result = await syncPiGlobalToLlmConnections()

      expect(result.changed).toBe(false)
      expect(result.error).toContain('settings flush failed')
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
