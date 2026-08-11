import type { ModelFetcherMap, ModelFetcherCredentials, ModelFetchResult } from '@mortise/shared/config'
import { readPiGlobalProviders } from '@mortise/shared/config'
import { MODEL_FETCHERS } from './registry'
import { handlerLog } from './runtime'

type CredentialResolver = (providerKey: string) => Promise<ModelFetcherCredentials>

class ModelRefreshService {
  private inFlight = new Map<string, Promise<ModelFetchResult>>()

  constructor(private fetchers: ModelFetcherMap, private getCredentials: CredentialResolver) {}

  async refreshProvider(providerKey: string): Promise<ModelFetchResult> {
    const existing = this.inFlight.get(providerKey)
    if (existing) return existing
    const work = this.doRefresh(providerKey).finally(() => this.inFlight.delete(providerKey))
    this.inFlight.set(providerKey, work)
    return work
  }

  private async doRefresh(providerKey: string): Promise<ModelFetchResult> {
    const provider = readPiGlobalProviders()[providerKey]
    if (!provider) return { models: [] }
    const fetcher = this.fetchers.pi
    if (!fetcher) return { models: [] }
    try {
      return await fetcher.fetchModels(providerKey, provider, await this.getCredentials(providerKey))
    } catch (error) {
      handlerLog.warn(`Model refresh [${providerKey}] failed: ${error instanceof Error ? error.message : error}`)
      return { models: [] }
    }
  }

  stopAll(): void {}
  stopProvider(_providerKey: string): void {}
  async refreshNow(providerKey: string): Promise<ModelFetchResult> { return this.refreshProvider(providerKey) }
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
