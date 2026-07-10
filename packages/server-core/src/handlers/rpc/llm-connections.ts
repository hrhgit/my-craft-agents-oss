import { RPC_CHANNELS, type LlmConnectionSetup } from '@craft-agent/shared/protocol'
import { getLlmConnections, getLlmConnection, addLlmConnection, updateLlmConnection, deleteLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection, touchLlmConnection, isCompatProvider, getDefaultModelsForConnection, getDefaultModelForConnection, hasPiGlobalAuthForConnection, readPiGlobalApiKeyForConnection, sanitizePiGlobalProvider, maskApiKey, normalizePiCustomEndpointBaseUrl, type LlmConnection, type LlmConnectionWithStatus, toBedrockNativeId, deriveBedrockRegionPrefix, type PiGlobalProvider, type PiGlobalSettings, type PiCustomApi, type FetchedEndpointModel } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { setSetupDeferred } from '@craft-agent/shared/config/storage'
import {
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '@craft-agent/shared/agent/backend'
import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers'
import { parseTestConnectionError, createBuiltInConnection, validateModelList, piAuthProviderDisplayName, validateSetupTestInput, setupTestRequiresApiKey, resolveCustomEndpointSetup } from '@craft-agent/server-core/domain'
import { getWorkspaceOrThrow, buildBackendHostRuntimeContext } from '@craft-agent/server-core/handlers'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { syncPiGlobalToLlmConnections } from './pi-global-sync'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
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

export function registerLlmConnectionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  // Unified handler for LLM connection setup
  server.handle(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, async (_ctx, setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }> => {
    try {
      const manager = getCredentialManager()

      // Ensure connection exists in config
      let connection = getLlmConnection(setup.slug)
      let isNewConnection = false
      if (!connection) {
        // Reauth guard: if updateOnly is set, the connection must already exist.
        // Clean up any orphaned credentials from a preceding OAuth flow.
        if (setup.updateOnly) {
          await manager.deleteLlmCredentials(setup.slug).catch(() => {})
          deps.platform.logger?.warn(`[SETUP_LLM_CONNECTION] updateOnly rejected for missing slug: ${setup.slug}`)
          return { success: false, error: 'Connection not found. Cannot re-authenticate a non-existent connection.' }
        }
        // Create connection with appropriate defaults based on slug
        connection = createBuiltInConnection(setup.slug, setup.baseUrl)
        isNewConnection = true
      }

      const requestedCustomApi = setup.customEndpoint?.api as PiCustomApi | undefined
      const baseUrlApi = requestedCustomApi ?? (connection.piAuthProvider === 'anthropic' ? 'anthropic-messages' : undefined)
      const normalizedSetupBaseUrl = setup.baseUrl?.trim()
        ? normalizePiCustomEndpointBaseUrl(setup.baseUrl, baseUrlApi) ?? setup.baseUrl.trim()
        : undefined
      const updates: Partial<LlmConnection> = {}
      const hasConfiguredBaseUrl = !!normalizedSetupBaseUrl
      if (setup.baseUrl !== undefined) {
        updates.baseUrl = normalizedSetupBaseUrl

        const isAnthropicAuthConnection = connection.piAuthProvider === 'anthropic'
        if (isAnthropicAuthConnection && connection.authType !== 'oauth') {
          if (hasConfiguredBaseUrl) {
            updates.providerType = 'pi_compat'
            updates.authType = 'api_key_with_endpoint'
            updates.customEndpoint = { api: 'anthropic-messages' }
            updates.piAuthProvider = 'anthropic'
          } else {
            updates.providerType = 'pi'
            updates.authType = 'api_key'
            updates.piAuthProvider = 'anthropic'
            updates.models = getDefaultModelsForConnection('pi', 'anthropic')
            updates.defaultModel = getDefaultModelForConnection('pi', 'anthropic')
            updates.modelSelectionMode ??= 'automaticallySyncedFromProvider'
          }
        }
      }

      if (setup.defaultModel !== undefined) {
        updates.defaultModel = setup.defaultModel ?? undefined
      }
      if (setup.models !== undefined) {
        updates.models = setup.models ?? undefined
      }
      if (setup.modelSelectionMode !== undefined) {
        updates.modelSelectionMode = setup.modelSelectionMode
      }

      const customEndpoint = hasConfiguredBaseUrl ? setup.customEndpoint : undefined
      const isCustomEndpointCompat = !!customEndpoint
      if (customEndpoint) {
        updates.customEndpoint = customEndpoint
        updates.providerType = 'pi_compat'
        const branch = resolveCustomEndpointSetup({
          baseUrl: normalizedSetupBaseUrl,
          credential: setup.credential ?? undefined,
          customEndpointApi: customEndpoint.api,
        })
        updates.authType = branch.authType
        if (branch.name !== undefined) updates.name = branch.name
        if (branch.piAuthProvider !== undefined) updates.piAuthProvider = branch.piAuthProvider

        if (isNewConnection && !updates.name && normalizedSetupBaseUrl?.toLowerCase().includes('manifest.build')) {
          updates.name = 'Manifest'
        }
      } else if (setup.baseUrl !== undefined) {
        // Base URL was explicitly updated without custom protocol config.
        // Treat this as non-custom mode and clear stale custom endpoint metadata.
        // Only downgrade existing connections — new ones already have the correct
        // providerType from createBuiltInConnection().
        updates.customEndpoint = undefined
        if (connection.providerType === 'pi_compat' && connection.authType !== 'oauth' && !isNewConnection) {
          updates.providerType = 'pi'
          updates.authType = 'api_key'
          updates.piAuthProvider = updates.piAuthProvider ?? connection.piAuthProvider ?? 'anthropic'
        }
      }

      // Pi API key flow: set piAuthProvider from setup data (e.g. 'anthropic', 'google', 'openai').
      // Skip when custom endpoint protocol is driving routing.
      if (setup.piAuthProvider && !isCustomEndpointCompat) {
        updates.piAuthProvider = setup.piAuthProvider
        // Update connection name to show the actual provider (e.g. "Craft Agents Backend (Google AI Studio)")
        const providerName = piAuthProviderDisplayName(setup.piAuthProvider)
        if (providerName) {
          updates.name = `Pi (${providerName})`
        }
        // Only set default models when using standard Pi provider AND user didn't pick explicit models
        if (!hasConfiguredBaseUrl && !setup.models?.length) {
          updates.models = getDefaultModelsForConnection('pi', setup.piAuthProvider)
          updates.defaultModel = getDefaultModelForConnection('pi', setup.piAuthProvider)
          updates.modelSelectionMode ??= 'automaticallySyncedFromProvider'
        }
      }

      // Pi+Bedrock auth method override — set authType for IAM or environment auth.
      // providerType stays 'pi' (Bedrock routes through Pi SDK).
      if (setup.bedrockAuthMethod) {
        updates.authType = setup.bedrockAuthMethod
      }

      // Resolved Anthropic OAuth identity (issue #838). Threaded through SETUP so
      // it persists on both the new-connection path (addLlmConnection) and the
      // re-auth path (updateLlmConnection) via the shared pendingConnection/updates
      // flow below. Fail-soft: only stamp when at least one identity block arrived.
      const oauthIdentity = setup.oauthIdentity
      if (oauthIdentity?.account || oauthIdentity?.organization) {
        // Set only fields that are actually present, so `updates` never carries an
        // explicit `undefined` (matches the guarded-assignment style used above and
        // keeps the update intent clean). Missing sub-fields are simply not touched;
        // on re-auth the storage allowlist then preserves any prior value.
        if (oauthIdentity.account?.uuid) updates.oauthAccountUuid = oauthIdentity.account.uuid
        if (oauthIdentity.account?.emailAddress) updates.oauthAccountEmail = oauthIdentity.account.emailAddress
        if (oauthIdentity.organization?.uuid) updates.oauthOrganizationUuid = oauthIdentity.organization.uuid
        if (oauthIdentity.organization?.name) updates.oauthOrganizationName = oauthIdentity.organization.name
        updates.oauthProfileVerifiedAt = Date.now()
      }

      const effectiveProviderType = updates.providerType ?? connection.providerType
      if (effectiveProviderType === 'pi') {
        const isBedrockPi = (updates.piAuthProvider ?? connection.piAuthProvider) === 'amazon-bedrock'
        // For Pi+Bedrock, normalize bare Anthropic IDs to Bedrock-native before adding pi/ prefix
        // so that resolvePiModel() can find them in the amazon-bedrock registry.
        // Use the configured AWS region to select the correct inference profile prefix (us/eu).
        const regionPrefix = isBedrockPi ? deriveBedrockRegionPrefix(setup.awsRegion) : undefined
        const toPiModelId = (id: string) => {
          const bare = id.startsWith('pi/') ? id.slice(3) : id
          const normalized = isBedrockPi ? toBedrockNativeId(bare, regionPrefix) : bare
          return `pi/${normalized}`
        }
        if (updates.models) {
          updates.models = updates.models.map(m => typeof m === 'string' ? toPiModelId(m) : { ...m, id: toPiModelId(m.id) })
        }
        if (updates.defaultModel) {
          updates.defaultModel = toPiModelId(updates.defaultModel)
        }
      }

      const pendingConnection: LlmConnection = {
        ...connection,
        ...updates,
      }

      if (pendingConnection.providerType === 'pi') {
        const modelIds = (pendingConnection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
        deps.platform.logger?.info('Pi setup pending connection snapshot', {
          slug: pendingConnection.slug,
          piAuthProvider: pendingConnection.piAuthProvider,
          modelSelectionMode: pendingConnection.modelSelectionMode,
          defaultModel: pendingConnection.defaultModel,
          modelCount: modelIds.length,
          modelsFirst5: modelIds.slice(0, 5),
          setupModelCount: setup.models?.length,
          setupDefaultModel: setup.defaultModel,
        })
      }

      if (pendingConnection.providerType === 'pi' && pendingConnection.piAuthProvider && !pendingConnection.modelSelectionMode) {
        const inferredMode = setup.models?.length
          ? 'userDefined3Tier'
          : 'automaticallySyncedFromProvider'
        pendingConnection.modelSelectionMode = inferredMode
        updates.modelSelectionMode = inferredMode
      }

      if (updates.models && updates.models.length > 0) {
        const validation = validateModelList(updates.models, pendingConnection.defaultModel)
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }
        if (validation.resolvedDefaultModel) {
          pendingConnection.defaultModel = validation.resolvedDefaultModel
          updates.defaultModel = validation.resolvedDefaultModel
        }
      }

      if (isCompatProvider(pendingConnection.providerType) && !pendingConnection.defaultModel) {
        return { success: false, error: 'Default model is required for compatible endpoints.' }
      }

      if (isNewConnection) {
        const added = addLlmConnection(pendingConnection)
        if (!added) {
          deps.platform.logger?.error(`Failed to persist LLM connection: ${setup.slug} (config may be inaccessible)`)
          return { success: false, error: 'Failed to save connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Created LLM connection: ${setup.slug}`)
      } else if (Object.keys(updates).length > 0) {
        const updated = updateLlmConnection(setup.slug, updates)
        if (!updated) {
          deps.platform.logger?.error(`Failed to update LLM connection: ${setup.slug}`)
          return { success: false, error: 'Failed to update connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Updated LLM connection settings: ${setup.slug}`)
      }

      // Store credential if provided (skip masked placeholders from GET_API_KEY)
      const isMasked = setup.credential?.includes('••')
      if (setup.credential && !isMasked) {
        const authType = pendingConnection.authType
        if (authType === 'oauth') {
          await manager.setLlmOAuth(setup.slug, { accessToken: setup.credential })
          deps.platform.logger?.info('Saved OAuth access token to LLM connection')
        } else {
          await manager.setLlmApiKey(setup.slug, setup.credential)
          deps.platform.logger?.info('Saved API key to LLM connection')
        }
      }

      // Pi+Bedrock IAM credentials — stored separately from API keys
      if (setup.iamCredentials) {
        await manager.setLlmIamCredentials(setup.slug, {
          ...setup.iamCredentials,
          region: setup.awsRegion,
        })
        deps.platform.logger?.info('Saved IAM credentials to LLM connection')
      }

      // Set as default only if no default exists yet (first connection)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(setup.slug)
        deps.platform.logger?.info(`Set default LLM connection: ${setup.slug}`)
      }

      // Fetch available models before returning to the UI.
      // Always refresh for auto-synced connections (e.g. Copilot, Bedrock) — the static
      // catalog from setup is just a seed that needs replacing with live API data
      // filtered by the user's policy. For user-defined connections, only refresh
      // when no models were populated during setup.
      // Awaited so the model selector shows real available models immediately.
      const pendingModels = Array.isArray(pendingConnection.models) ? pendingConnection.models : []
      const isAutoSynced = pendingConnection.modelSelectionMode === 'automaticallySyncedFromProvider'
      if (!pendingModels.length || isAutoSynced) {
        try {
          await getModelRefreshService().refreshNow(setup.slug)
        } catch (err) {
          deps.platform.logger?.warn(`Model refresh after setup failed for ${setup.slug}: ${err instanceof Error ? err.message : err}`)
        }
      }

      // Reinitialize auth for the connection that was just created/updated,
      // not the global default (which may be a different connection).
      await sessionManager.reinitializeAuth(setup.slug)
      deps.platform.logger?.info('Reinitialized auth after LLM connection setup')

      // Clear "Setup later" flag now that user has configured a provider
      setSetupDeferred(false)

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error('Failed to setup LLM connection:', message)
      return { success: false, error: message }
    }
  })

  // Unified connection test — uses the agent factory to spawn a real agent subprocess
  // and validate credentials via runMiniCompletion(). Same code path as actual chat.
  server.handle(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, async (_ctx, params: import('@craft-agent/shared/protocol').TestLlmConnectionParams): Promise<import('@craft-agent/shared/protocol').TestLlmConnectionResult> => {
    const { provider, apiKey, baseUrl, model, piAuthProvider, customEndpoint } = params
    const trimmedKey = apiKey?.trim() ?? ''
    const allowEmptyApiKey = !setupTestRequiresApiKey(baseUrl)

    if (!trimmedKey && !allowEmptyApiKey) {
      return { success: false, error: 'API key is required' }
    }

    const setupValidation = validateSetupTestInput({ provider, baseUrl, piAuthProvider })
    if (!setupValidation.valid) {
      return { success: false, error: setupValidation.error }
    }

    const testBaseUrlApi = (customEndpoint?.api as PiCustomApi | undefined)
      ?? (piAuthProvider === 'anthropic' ? 'anthropic-messages' : undefined)
    const normalizedBaseUrl = baseUrl?.trim()
      ? normalizePiCustomEndpointBaseUrl(baseUrl, testBaseUrlApi) ?? baseUrl.trim()
      : baseUrl
    const hint = resolveSetupTestConnectionHint({ provider, baseUrl: normalizedBaseUrl, piAuthProvider, customEndpoint })
    deps.platform.logger?.info(`[testLlmConnectionSetup] Testing: provider=${provider}${piAuthProvider ? ` piAuth=${piAuthProvider}` : ''}${normalizedBaseUrl ? ` baseUrl=${normalizedBaseUrl}` : ''} hasCustomEndpoint=${!!customEndpoint} hintProvider=${hint.providerType}`)

    const startedAt = Date.now()
    try {
      const testModel = model || getDefaultModelForConnection(provider, piAuthProvider)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Resolved model: ${testModel}`)
      const result = await testBackendConnection({
        provider,
        apiKey: trimmedKey,
        allowEmptyApiKey,
        model: testModel,
        baseUrl: normalizedBaseUrl,
        timeoutMs: 45000,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        connection: hint,
      })
      const elapsed = Date.now() - startedAt

      if (!result.success) {
        deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=false`)
        deps.platform.logger?.info(`[testLlmConnectionSetup] Raw error: ${(result.error || '').slice(0, 1000)}`)
        return { success: false, error: parseTestConnectionError(result.error || 'Unknown error') }
      }
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=true`)
      return { success: true }
    } catch (error) {
      const elapsed = Date.now() - startedAt
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, threw: ${msg.slice(0, 1000)}`)
      return { success: false, error: parseTestConnectionError(msg) }
    }
  })

  // ============================================================
  // Pi Provider Discovery (main process only — Pi SDK can't run in renderer)
  // ============================================================

  server.handle(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS, async () => {
    const { getPiApiKeyProviders } = await import('@craft-agent/shared/config/models-pi')
    return getPiApiKeyProviders()
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL, async (_ctx, provider: string) => {
    const { getPiProviderBaseUrl } = await import('@craft-agent/shared/config/models-pi')
    return getPiProviderBaseUrl(provider)
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_MODELS, async (_ctx, provider: string) => {
    const { getPiProviderCatalogModels } = await import('@craft-agent/shared/config/models-pi')
    const models = getPiProviderCatalogModels(provider)
    const sorted = [...models].sort((a, b) => b.costOutput - a.costOutput || b.costInput - a.costInput)
    return {
      models: sorted,
      totalCount: models.length,
    }
  })

  // ============================================================
  // Pi Global Config (~/.pi/agent/) — pure Pi + custom provider mode
  // These read/write the Pi CLI's global config files directly.
  // Sync to ~/.craft-agent/config.json + subprocess runtime is handled separately.
  // ============================================================

  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDERS, async () => {
    const { readPiGlobalProvidersForDisplay } = await import('@craft-agent/shared/config')
    return readPiGlobalProvidersForDisplay()
  })

  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_SETTINGS, async () => {
    const { readPiGlobalSettings } = await import('@craft-agent/shared/config')
    return readPiGlobalSettings()
  })

  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER, async (_ctx, key: string) => {
    const { readPiGlobalProviders } = await import('@craft-agent/shared/config')
    const providers = readPiGlobalProviders()
    return providers[key] ? sanitizePiGlobalProvider(providers[key]) : null
  })

  server.handle(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER_API_KEY, async (_ctx, key: string): Promise<string | null> => {
    const { readPiGlobalApiKey } = await import('@craft-agent/shared/config')
    return readPiGlobalApiKey(key) ?? null
  })

  server.handle(
    RPC_CHANNELS.pi.SAVE_GLOBAL_PROVIDER,
    async (_ctx, args: { key: string; provider: PiGlobalProvider; apiKey?: string }): Promise<{ success: boolean; error?: string }> => {
      const { savePiGlobalProvider } = await import('@craft-agent/shared/config')
      try {
        savePiGlobalProvider(args.key, args.provider, args.apiKey)
        pushTyped(server, RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
        // Sync providers/credentials (thin wrapper: reads ~/.pi/agent/, pi credentials live in auth.json).
        void serializePiSettingsWrite(() => runPiGlobalSync('saveGlobalProvider'))
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.pi.DELETE_GLOBAL_PROVIDER,
    async (_ctx, key: string): Promise<{ success: boolean; error?: string }> => {
      const { deletePiGlobalProvider } = await import('@craft-agent/shared/config')
      try {
        await serializePiSettingsWrite(async () => {
          await deletePiGlobalProvider(key)
          await runPiGlobalSync('deleteGlobalProvider')
        })
        pushTyped(server, RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT,
    async (
      _ctx,
      args: { provider: string; model: string; thinkingLevel?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      const { setPiGlobalDefault } = await import('@craft-agent/shared/config')
      try {
        await serializePiSettingsWrite(async () => {
          await setPiGlobalDefault(args.provider, args.model, args.thinkingLevel)
          await runPiGlobalSync('setGlobalDefault')
        })
        pushTyped(server, RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.pi.FETCH_MODELS_FOR_ENDPOINT,
    async (
      _ctx,
      args: { baseUrl: string; apiKey?: string; api?: PiCustomApi; authHeader?: boolean },
    ): Promise<{ success: boolean; models: FetchedEndpointModel[]; resolvedBaseUrl?: string; error?: string }> => {
      const { fetchModelsForEndpointWithResolution } = await import('@craft-agent/shared/config')
      try {
        const result = await fetchModelsForEndpointWithResolution(args.baseUrl, args.apiKey ?? '', {
          api: args.api,
          authHeader: args.authHeader,
        })
        return { success: true, models: result.models, resolvedBaseUrl: result.resolvedBaseUrl }
      } catch (e) {
        return { success: false, models: [], error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  // ============================================================
  // Pi Global → LlmConnection sync
  // ============================================================
  //
  // ~/.pi/agent/ is the single source of truth for "pure Pi + custom provider"
  // mode. The sync is a thin wrapper that reads ~/.pi/agent/ (pi credentials
  // live in auth.json). It runs on
  // startup and after every pi:saveGlobalProvider / deleteGlobalProvider /
  // setGlobalDefault handler, broadcasting llmConnections.CHANGED so the UI refreshes.
  const broadcastLlmConnectionsChanged = () => {
    pushTyped(server, RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
  }

  // Serialize operations that write ~/.pi/agent/settings.json. Both
  // runPiGlobalSync (auto-fix path) and writeBackToPiGlobal call
  // setPiGlobalDefault which does a read-modify-write on settings.json;
  // without serialization, rapid RPCs (e.g. set-default then save-provider)
  // can interleave and lose updates.
  let piSettingsWriteChain: Promise<unknown> = Promise.resolve()
  const serializePiSettingsWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = piSettingsWriteChain.then(fn)
    piSettingsWriteChain = result.catch(() => {})
    return result
  }

  const runPiGlobalSync = async (reason: string): Promise<void> => {
    try {
      const result = await syncPiGlobalToLlmConnections()
      if (result.error) {
        deps.platform.logger?.warn(`[pi-global-sync] ${reason} failed: ${result.error}`)
        return
      }
      deps.platform.logger?.info(
        `[pi-global-sync] ${reason}: changed=${result.changed}`,
      )
      // Always broadcast so UIs watching llmConnections.CHANGED refresh after
      // a pi provider/default change (not only when auto-fix ran).
      broadcastLlmConnectionsChanged()
      if (result.changed) {
        // Reinitialize auth so env vars / summarization model match the new default
        try {
          await sessionManager.reinitializeAuth()
        } catch (err) {
          deps.platform.logger?.warn(`[pi-global-sync] reinitializeAuth failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      deps.platform.logger?.error(`[pi-global-sync] ${reason} threw:`, err)
    }
  }
  // Fire-and-forget on startup — handlers are already registered when this runs.
  // Serialized to avoid racing with concurrent writeBackToPiGlobal calls.
  void serializePiSettingsWrite(() => runPiGlobalSync('startup'))

  /**
   * Write-back helper: when the user switches the default provider/model or
   * edits a pi-* connection's defaultModel via the existing AiSettingsPage UI,
   * mirror the change into ~/.pi/agent/settings.json so the Pi CLI and our own
   * PiProvidersSettingsPage stay consistent. Only fires for pi-* slugs.
   */
  const writeBackToPiGlobal = async (slug: string, defaultModel?: string): Promise<void> => {
    if (!slug.startsWith('pi-')) return
    const providerKey = slug.slice(3) // strip "pi-" prefix
    try {
      const { readPiGlobalSettings, setPiGlobalDefault, readPiGlobalProviders } = await import('@craft-agent/shared/config')
      const providers = readPiGlobalProviders()
      if (!providers[providerKey]) {
        deps.platform.logger?.warn(`[pi-global-writeback] provider "${providerKey}" not found in ~/.pi/agent/models.json`)
        return
      }
      const settings = readPiGlobalSettings()
      const modelIds = (providers[providerKey]?.models ?? [])
        .map(model => model.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      // Determine the model to persist: explicit valid override > current
      // setting for the same provider > first provider model.
      const model =
        (defaultModel && modelIds.includes(defaultModel) ? defaultModel : undefined)
        || (
          settings.defaultProvider === providerKey
          && settings.defaultModel
          && modelIds.includes(settings.defaultModel)
            ? settings.defaultModel
            : undefined
        )
        || modelIds[0]
      if (!model) {
        deps.platform.logger?.warn(`[pi-global-writeback] no model to persist for "${providerKey}"`)
        return
      }
      await setPiGlobalDefault(providerKey, model, settings.defaultThinkingLevel)
      pushTyped(server, RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
      deps.platform.logger?.info(`[pi-global-writeback] ~/.pi/agent/settings.json updated: provider=${providerKey}, model=${model}`)
    } catch (err) {
      deps.platform.logger?.warn(`[pi-global-writeback] failed for ${slug}: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ============================================================
  // LLM Connections (provider configurations)
  // ============================================================

  // List all LLM connections (includes built-in and custom)
  server.handle(RPC_CHANNELS.llmConnections.LIST, async (): Promise<LlmConnection[]> => {
    return getLlmConnections()
  })

  // List all LLM connections with authentication status
  server.handle(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS, async (): Promise<LlmConnectionWithStatus[]> => {
    const connections = getLlmConnections()
    const credentialManager = getCredentialManager()
    const defaultSlug = getDefaultLlmConnection()

    return Promise.all(connections.map(async (conn): Promise<LlmConnectionWithStatus> => {
      // Check if credentials exist for this connection
      const hasCredentials =
        await credentialManager.hasLlmCredentials(conn.slug, conn.authType)
        || hasPiGlobalAuthForConnection(conn)
      return {
        ...conn,
        isAuthenticated: conn.authType === 'none' || hasCredentials,
        isDefault: conn.slug === defaultSlug,
      }
    }))
  })

  // Get a specific LLM connection by slug
  server.handle(RPC_CHANNELS.llmConnections.GET, async (_ctx, slug: string): Promise<LlmConnection | null> => {
    return getLlmConnection(slug)
  })

  // Get stored API key for an LLM connection (masked — for edit form display only)
  server.handle(RPC_CHANNELS.llmConnections.GET_API_KEY, async (_ctx, slug: string): Promise<string | null> => {
    const manager = getCredentialManager()
    const connection = getLlmConnection(slug)
    const key = await manager.getLlmApiKey(slug) || readPiGlobalApiKeyForConnection(connection)
    if (!key) return null
    // Show provider prefix (first 7 chars) + last 4 chars, mask the middle
    return maskApiKey(key)
  })

  // Save (create or update) an LLM connection
  // If connection.slug exists and is found, updates it; otherwise creates new
  server.handle(RPC_CHANNELS.llmConnections.SAVE, async (_ctx, connection: LlmConnection): Promise<{ success: boolean; error?: string }> => {
    try {
      // Check if this is an update or create
      const existing = getLlmConnection(connection.slug)
      if (existing) {
        // Update existing connection (can't change slug)
        const { slug: _slug, ...updates } = connection
        const success = updateLlmConnection(connection.slug, updates)
        if (!success) {
          return { success: false, error: 'Failed to update connection' }
        }
      } else {
        // Create new connection
        const success = addLlmConnection(connection)
        if (!success) {
          return { success: false, error: 'Connection with this slug already exists' }
        }
      }
      deps.platform.logger?.info(`LLM connection saved: ${connection.slug}`)
      // Push runtime updates (e.g. supportsImages toggle) to live sessions on
      // this connection. Detached so SAVE doesn't block on the per-session
      // 15s `update_runtime_config` timeout when subprocesses are slow or
      // wedged. SessionManager serializes the refresh with the next send via
      // its per-session mutex, and the lazy `getOrCreateAgent` refresh remains
      // the correctness backstop if the detached push fails.
      sessionManager.refreshConnectionRuntime(connection.slug).catch(error => {
        deps.platform.logger?.warn(
          `Detached runtime push failed for ${connection.slug}: ${error instanceof Error ? error.message : error}`,
        )
      })
      // Reinitialize auth if the saved connection is the current default
      // (updates env vars and summarization model override)
      const defaultSlug = getDefaultLlmConnection()
      if (defaultSlug === connection.slug) {
        await sessionManager.reinitializeAuth()
      }
      // Write-back: if this is a pi-* connection, mirror defaultModel into
      // ~/.pi/agent/settings.json so the Pi CLI / PiProvidersSettingsPage stay
      // in sync with the AiSettingsPage edit.
      void serializePiSettingsWrite(() => writeBackToPiGlobal(connection.slug, connection.defaultModel))
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to save LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Delete an LLM connection (at least one connection must remain)
  server.handle(RPC_CHANNELS.llmConnections.DELETE, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }
      // deleteLlmConnection handles the "at least one must remain" check
      const success = deleteLlmConnection(slug)
      if (success) {
        // Stop any periodic model refresh timer for this connection
        getModelRefreshService().stopConnection(slug)
        // Also delete associated credentials
        const credentialManager = getCredentialManager()
        await credentialManager.deleteLlmCredentials(slug)
        deps.platform.logger?.info(`LLM connection deleted: ${slug}`)
      }
      return { success }
    } catch (error) {
      deps.platform.logger?.error('Failed to delete LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Test an LLM connection (validate credentials and connectivity with actual API call)
  server.handle(RPC_CHANNELS.llmConnections.TEST, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await validateStoredBackendConnection({
        slug,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      })

      if (!result.success) {
        return { success: false, error: result.error }
      }

      touchLlmConnection(slug)

      if (result.shouldRefreshModels) {
        getModelRefreshService().refreshNow(slug).catch(err => {
          deps.platform.logger?.warn(`Model refresh failed during validation: ${err instanceof Error ? err.message : err}`)
        })
      }

      deps.platform.logger?.info(`LLM connection validated: ${slug}`)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[LLM_CONNECTION_TEST] Error for ${slug}: ${msg.slice(0, 500)}`)
      const { parseValidationError } = await import('@craft-agent/shared/config')
      return { success: false, error: parseValidationError(msg) }
    }
  })

  // Set global default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_DEFAULT, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const success = setDefaultLlmConnection(slug)
      if (success) {
        deps.platform.logger?.info(`Global default LLM connection set to: ${slug}`)
        // Write-back: if switching to a pi-* connection, update ~/.pi/agent/settings.json
        // so the Pi CLI / PiProvidersSettingsPage reflect the same default provider.
        await serializePiSettingsWrite(() => writeBackToPiGlobal(slug))
        broadcastLlmConnectionsChanged()
        // Reinitialize auth so env vars and summarization model override match the new default.
        await sessionManager.reinitializeAuth()
      }
      return { success, error: success ? undefined : 'Connection not found' }
    } catch (error) {
      deps.platform.logger?.error('Failed to set default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Set workspace default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT, async (_ctx, workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }> => {
    try {
      const workspace = getWorkspaceOrThrow(workspaceId)

      // Validate connection exists if setting (not clearing)
      if (slug) {
        const connection = getLlmConnection(slug)
        if (!connection) {
          return { success: false, error: 'Connection not found' }
        }
      }

      const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
      const config = loadWorkspaceConfig(workspace.rootPath)
      if (!config) {
        return { success: false, error: 'Failed to load workspace config' }
      }

      // Update workspace defaults
      config.defaults = config.defaults || {}
      if (slug) {
        config.defaults.defaultLlmConnection = slug
      } else {
        delete config.defaults.defaultLlmConnection
      }

      saveWorkspaceConfig(workspace.rootPath, config)
      deps.platform.logger?.info(`Workspace ${workspaceId} default LLM connection set to: ${slug}`)
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to set workspace default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Refresh available models for a connection (dynamic model discovery)
  server.handle(RPC_CHANNELS.llmConnections.REFRESH_MODELS, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }

      await getModelRefreshService().refreshNow(slug)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error(`Failed to refresh models for ${slug}: ${msg}`)
      return { success: false, error: msg }
    }
  })
}
