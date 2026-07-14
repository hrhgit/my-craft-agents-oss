import { describe, expect, it, mock } from 'bun:test'
import type { WebContents } from 'electron'
import { ElectronExtensionValidationAdapter, ExtensionValidationAdapterError } from '../extension-validation-adapter'

function contents(result: unknown, destroyed = false): { webContents: WebContents; execute: ReturnType<typeof mock> } {
  const execute = mock(async () => result)
  return { webContents: { isDestroyed: () => destroyed, executeJavaScript: execute } as unknown as WebContents, execute }
}

describe('ElectronExtensionValidationAdapter', () => {
  it('uses a fixed renderer bridge method and passes request values as JSON data', async () => {
    const fake = contents({ ok: true, result: { invoked: true } })
    const adapter = new ElectronExtensionValidationAdapter(fake.webContents)
    await expect(adapter.execute({
      sessionId: 's', extensionId: 'e', runtimeId: 'r', definitionId: 'd', kind: 'action', id: 'refresh',
      input: { message: `'); globalThis.compromised = true; ('` },
    })).resolves.toEqual({ invoked: true })
    const expression = String(fake.execute.mock.calls[0]?.[0])
    expect(expression).toContain('__CRAFT_UI_VALIDATION_EXTENSION_BRIDGE_V1__')
    expect(expression).toContain('bridge["execute"]')
    expect(expression).not.toContain('eval(')
  })

  it('preserves typed renderer failures and refuses destroyed windows', async () => {
    const rejected = contents({ ok: false, code: 'DISABLED', message: 'disabled' })
    await expect(new ElectronExtensionValidationAdapter(rejected.webContents).readiness({ sessionId: 's', extensionId: 'e', definitionId: 'd' }))
      .rejects.toEqual(new ExtensionValidationAdapterError('DISABLED', 'disabled'))
    const destroyed = contents({ ok: true }, true)
    await expect(new ElectronExtensionValidationAdapter(destroyed.webContents).snapshot()).rejects.toMatchObject({ code: 'WINDOW_GONE' })
  })
})
