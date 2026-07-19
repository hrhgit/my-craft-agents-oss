import type { ModelFetcher, ModelFetchResult, ModelFetcherCredentials, PiGlobalProvider } from '@mortise/shared/config'
import { fetchBackendModels } from '@mortise/shared/agent/backend'
import { getHostRuntime } from './runtime'

export class PiModelFetcher implements ModelFetcher {
  readonly refreshIntervalMs = 0

  async fetchModels(providerKey: string, provider: PiGlobalProvider, credentials: ModelFetcherCredentials): Promise<ModelFetchResult> {
    return fetchBackendModels({
      providerKey,
      providerConfig: provider,
      credentials,
      timeoutMs: providerKey === 'github-copilot' ? 30_000 : 15_000,
      hostRuntime: getHostRuntime(),
    })
  }
}
