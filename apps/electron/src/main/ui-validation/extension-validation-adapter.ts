import type { WebContents } from 'electron'

const BRIDGE_KEY = '__CRAFT_UI_VALIDATION_EXTENSION_BRIDGE_V1__'
const MAX_REQUEST_BYTES = 32_768

export class ExtensionValidationAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExtensionValidationAdapterError'
  }
}

type BridgeMethod = 'snapshot' | 'readiness' | 'execute'

/**
 * Calls a fixed renderer Test Host bridge. Callers can select a validated
 * method and JSON arguments, but cannot submit JavaScript or access raw state.
 */
export class ElectronExtensionValidationAdapter {
  constructor(private readonly webContents: WebContents) {}

  snapshot(filter?: { sessionId?: string; extensionId?: string }): Promise<unknown> {
    return this.call('snapshot', filter ?? {})
  }

  readiness(selector: { sessionId: string; extensionId: string; runtimeId?: string; definitionId: string }): Promise<unknown> {
    return this.call('readiness', selector)
  }

  execute(request: {
    sessionId: string
    extensionId: string
    runtimeId?: string
    definitionId: string
    kind: 'action' | 'scenario'
    id: string
    phase?: 'setup' | 'teardown'
    input?: Record<string, unknown>
  }): Promise<unknown> {
    return this.call('execute', request)
  }

  private async call(method: BridgeMethod, args: unknown): Promise<unknown> {
    if (this.webContents.isDestroyed()) throw new ExtensionValidationAdapterError('WINDOW_GONE', 'Renderer window is gone.')
    const serialized = JSON.stringify(args)
    if (serialized.length > MAX_REQUEST_BYTES) throw new ExtensionValidationAdapterError('UNSUPPORTED', 'Extension validation request is too large.')
    // Only this constant wrapper is evaluated. User input remains JSON data and
    // the renderer bridge exposes no DOM, CDP, evaluate, or generic command API.
    const expression = `(() => {
      const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
      if (!bridge || bridge.schemaVersion !== 1) return { ok: false, code: 'NOT_READY', message: 'Extension validation bridge is unavailable.' };
      return Promise.resolve(bridge[${JSON.stringify(method)}](${serialized}))
        .then(result => ({ ok: true, result }))
        .catch(error => ({ ok: false, code: error?.code || 'UNSUPPORTED', message: String(error?.message || error) }));
    })()`
    const result = await this.webContents.executeJavaScript(expression, true) as { ok?: boolean; result?: unknown; code?: string; message?: string }
    if (!result?.ok) throw new ExtensionValidationAdapterError(result?.code || 'UNSUPPORTED', result?.message || 'Extension validation request failed.')
    return result.result
  }
}
