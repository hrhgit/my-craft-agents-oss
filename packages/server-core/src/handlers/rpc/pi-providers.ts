import { RPC_CHANNELS } from '@mortise/shared/protocol'
import {
  sanitizePiGlobalProvider,
  type FetchedEndpointModel,
  type PiCustomApi,
  type PiGlobalProvider,
} from '@mortise/shared/config'
import { pushTyped, type RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { syncPiGlobalConfig } from './pi-global-sync'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,
  RPC_CHANNELS.pi.GET_GLOBAL_PROVIDERS,
  RPC_CHANNELS.pi.GET_GLOBAL_SETTINGS,
  RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER,
  RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER_API_KEY,
  RPC_CHANNELS.pi.SAVE_GLOBAL_PROVIDER,
  RPC_CHANNELS.pi.DELETE_GLOBAL_PROVIDER,
  RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT,
  RPC_CHANNELS.pi.FETCH_MODELS_FOR_ENDPOINT,
] as const

/** Register the provider/model configuration API backed by Pi global config. */
export function registerPiProviderHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps
  let piSettingsWriteChain: Promise<unknown> = Promise.resolve()
  const serializePiSettingsWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = piSettingsWriteChain.then(fn)
    piSettingsWriteChain = result.catch(() => {})
    return result
  }

  const runPiGlobalSync = async (reason: string): Promise<void> => {
    const result = await syncPiGlobalConfig()
    if (result.error) {
      deps.platform.logger?.warn(`[pi-global-sync] ${reason} failed: ${result.error}`)
      return
    }
    pushTyped(server, RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
    if (result.changed) {
      await sessionManager.reinitializeAuth().catch(err => {
        deps.platform.logger?.warn(`[pi-global-sync] reinitializeAuth failed: ${err instanceof Error ? err.message : err}`)
      })
    }
  }

  server.handle(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS, async () => {
    const { getPiApiKeyProviders } = await import('@mortise/shared/config/models-pi')
    return getPiApiKeyProviders()
  })
  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL, async (_ctx, provider: string) => {
    const { getPiProviderBaseUrl } = await import('@mortise/shared/config/models-pi')
    return getPiProviderBaseUrl(provider)
  })
  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_MODELS, async (_ctx, provider: string) => {
    const { getPiProviderCatalogModels } = await import('@mortise/shared/config/models-pi')
    const models = getPiProviderCatalogModels(provider)
    return { models: [...models].sort((a, b) => b.costOutput - a.costOutput || b.costInput - a.costInput), totalCount: models.length }
  })
  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDERS, async () => {
    const { readPiGlobalProvidersForDisplay } = await import('@mortise/shared/config')
    return readPiGlobalProvidersForDisplay()
  })
  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_SETTINGS, async () => {
    const { readPiGlobalSettings } = await import('@mortise/shared/config')
    return readPiGlobalSettings()
  })
  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER, async (_ctx, key: string) => {
    const { readPiGlobalProviders } = await import('@mortise/shared/config')
    const provider = readPiGlobalProviders()[key]
    return provider ? sanitizePiGlobalProvider(provider) : null
  })
  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER_API_KEY, async (_ctx, key: string): Promise<string | null> => {
    const { readPiGlobalApiKey } = await import('@mortise/shared/config')
    return readPiGlobalApiKey(key) ?? null
  })
  server.handle(RPC_CHANNELS.pi.SAVE_GLOBAL_PROVIDER, async (_ctx, args: { key: string; provider: PiGlobalProvider; apiKey?: string }) => {
    try {
      const { savePiGlobalProvider } = await import('@mortise/shared/config')
      savePiGlobalProvider(args.key, args.provider, args.apiKey)
      await serializePiSettingsWrite(() => runPiGlobalSync('saveGlobalProvider'))
      await sessionManager.reloadProviderRuntime(args.key)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  server.handle(RPC_CHANNELS.pi.DELETE_GLOBAL_PROVIDER, async (_ctx, key: string) => {
    try {
      const { deletePiGlobalProvider } = await import('@mortise/shared/config')
      await serializePiSettingsWrite(async () => {
        await deletePiGlobalProvider(key)
        await sessionManager.clearDeletedProviderReferences(key)
        await runPiGlobalSync('deleteGlobalProvider')
        await sessionManager.reloadProviderRuntime()
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  server.handle(RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT, async (_ctx, args: {
    provider?: string
    model?: string
    thinkingLevel?: string
    slot?: number
    remove?: boolean
  }) => {
    try {
      const { removePiGlobalDefaultSlot, setPiGlobalDefault, setPiGlobalDefaultSlot } = await import('@mortise/shared/config')
      await serializePiSettingsWrite(async () => {
        const slot = args.slot ?? 1
        if (!Number.isInteger(slot) || slot < 1) throw new Error(`Invalid model default slot: ${slot}`)
        if (args.remove) {
          await removePiGlobalDefaultSlot(slot)
        } else if (!args.provider || !args.model || !args.thinkingLevel) {
          throw new Error('Provider, model, and thinking level are required.')
        } else if (slot === 1) {
          await setPiGlobalDefault(args.provider, args.model, args.thinkingLevel)
        } else {
          await setPiGlobalDefaultSlot(slot, args.provider, args.model, args.thinkingLevel)
        }
        await runPiGlobalSync('setGlobalDefault')
        await sessionManager.reloadProviderRuntime()
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  server.handle(RPC_CHANNELS.pi.FETCH_MODELS_FOR_ENDPOINT, async (_ctx, args: { baseUrl: string; apiKey?: string; api?: PiCustomApi; authHeader?: boolean }): Promise<{ success: boolean; models: FetchedEndpointModel[]; resolvedBaseUrl?: string; error?: string }> => {
    try {
      const { fetchModelsForEndpointWithResolution } = await import('@mortise/shared/config')
      const result = await fetchModelsForEndpointWithResolution(args.baseUrl, args.apiKey ?? '', { api: args.api, authHeader: args.authHeader })
      return { success: true, models: result.models, resolvedBaseUrl: result.resolvedBaseUrl }
    } catch (error) {
      return { success: false, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  void serializePiSettingsWrite(() => runPiGlobalSync('startup')).catch(error => {
    deps.platform.logger?.error('[pi-global-sync] startup failed:', error)
  })
}
