import type { ModelFetcherMap, ModelFetcherCredentials, PiGlobalModel } from '@mortise/shared/config'
import { readPiGlobalProviders, savePiGlobalProvider } from '@mortise/shared/config'
import { MODEL_FETCHERS } from './registry'
import { handlerLog } from './runtime'

type CredentialResolver = (providerKey: string) => Promise<ModelFetcherCredentials>

class ModelRefreshService {
  private inFlight = new Map<string, Promise<void>>()

  constructor(private fetchers: ModelFetcherMap, private getCredentials: CredentialResolver) {}

  async refreshProvider(providerKey: string): Promise<void> {
    const existing = this.inFlight.get(providerKey)
    if (existing) return existing
    const work = this.doRefresh(providerKey).finally(() => this.inFlight.delete(providerKey))
    this.inFlight.set(providerKey, work)
    return work
  }

  private async doRefresh(providerKey: string): Promise<void> {
    const provider = readPiGlobalProviders()[providerKey]
    if (!provider) return
    const fetcher = this.fetchers.pi
    if (!fetcher) return
    try {
      const result = await fetcher.fetchModels(providerKey, provider, await this.getCredentials(providerKey))
      if (!result.models.length) return
      const models: PiGlobalModel[] = result.models.map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        input: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
      savePiGlobalProvider(providerKey, { ...provider, models })
    } catch (error) {
      handlerLog.warn(`Model refresh [${providerKey}] failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  startAll(): void {
    for (const key of Object.keys(readPiGlobalProviders())) void this.refreshProvider(key)
  }

  stopAll(): void {}
  stopProvider(_providerKey: string): void {}
  async refreshNow(providerKey: string): Promise<void> { await this.refreshProvider(providerKey) }
}

let service: ModelRefreshService | null = null

export function getModelRefreshService(): ModelRefreshService {
  if (!service) throw new Error('ModelRefreshService not initialized. Call initModelRefreshService() first.')
  return service
}

export function initModelRefreshService(getCredentials: CredentialResolver): ModelRefreshService {
  service = new ModelRefreshService(MODEL_FETCHERS, getCredentials)
  return service
}

export { setFetcherPlatform } from './runtime'
