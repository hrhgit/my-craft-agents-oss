/**
 * useOnboarding Hook
 *
 * Manages the state machine for the onboarding wizard.
 * Flow:
 * 1. Welcome
 * 2. Git Bash (Windows only, if not found)
 * 3. API Setup (API Key)
 * 4. Credentials (API Key)
 * 5. Complete
 */
import { useState, useCallback, useEffect } from 'react'
import type {
  OnboardingState,
  OnboardingStep,
  ApiSetupMethod,
} from '@/components/onboarding'
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import type { LocalModelSubmitData } from '@/components/onboarding/LocalModelStep'
import type { ApiKeySubmitData } from '@/components/apisetup'
import type { CustomEndpointConfig } from '@/components/apisetup/submit-helpers'
import type { SetupNeeds, PiGlobalProvider } from '../../shared/types'

interface UseOnboardingOptions {
  /** Called when onboarding is complete */
  onComplete: () => void
  /** Initial setup needs from auth state check */
  initialSetupNeeds?: SetupNeeds
  /** Start the wizard at a specific step (default: 'welcome') */
  initialStep?: OnboardingStep
  /** Pre-select an API setup method (useful when editing an existing connection) */
  initialApiSetupMethod?: ApiSetupMethod
  /** Called when user goes back from the initial step (dismisses the wizard) */
  onDismiss?: () => void
  /** Called immediately after config is saved to disk (before wizard closes).
   *  Use this to propagate billing/model changes to the UI without waiting for onComplete. */
  onConfigSaved?: () => void
  /** Slug of existing connection being edited (null = creating new) */
  editingSlug?: string | null
  /** Set of slugs already in use (for generating unique slugs when creating new) */
  existingSlugs?: Set<string>
}

interface UseOnboardingReturn {
  // State
  state: OnboardingState

  // Wizard actions
  handleContinue: () => void
  handleBack: () => void

  // Provider select (new flow)
  handleSelectProvider: (choice: ProviderChoice) => void

  // API Setup (legacy — kept for direct edit)
  handleSelectApiSetupMethod: (method: ApiSetupMethod) => void

  // Credentials
  handleSubmitCredential: (data: ApiKeySubmitData) => void

  // Local model
  handleSubmitLocalModel: (data: LocalModelSubmitData) => void

  // Git Bash (Windows)
  handleBrowseGitBash: () => Promise<string | null>
  handleUseGitBashPath: (path: string) => void
  handleRecheckGitBash: () => void
  handleClearError: () => void

  // Skip setup ("Setup later")
  handleSkipSetup: () => void

  // Completion
  handleFinish: () => void
  handleCancel: () => void

  // Direct edit (skip method selection, jump to credentials)
  jumpToCredentials: (method: ApiSetupMethod) => void

  // Reset
  reset: () => void
}

// Base slug for each setup method (used as template key in ipc.ts)
export const BASE_SLUG_FOR_METHOD: Record<ApiSetupMethod, string> = {
  pi_api_key: 'pi-api-key',
}

/**
 * Generate a unique slug for a new connection.
 * If the base slug is taken, appends -2, -3, etc.
 * When editingSlug is provided, reuses that slug (editing existing connection).
 */
export function resolveSlugForMethod(
  method: ApiSetupMethod,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  // Editing an existing connection — reuse its slug
  if (editingSlug) return editingSlug

  const base = BASE_SLUG_FOR_METHOD[method]
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

function isLoopbackEndpoint(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

export function useOnboarding({
  onComplete,
  initialSetupNeeds,
  initialStep = 'provider-select',
  initialApiSetupMethod,
  onDismiss,
  onConfigSaved,
  editingSlug = null,
  existingSlugs = new Set(),
}: UseOnboardingOptions): UseOnboardingReturn {
  // Main wizard state
  const [state, setState] = useState<OnboardingState>({
    step: initialStep,
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: initialApiSetupMethod ?? null,
    isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
    gitBashStatus: undefined,
    isRecheckingGitBash: false,
    isCheckingGitBash: true, // Start as true until check completes
  })

  // Check Git Bash on Windows at mount. If missing, redirect to git-bash step
  // regardless of the initial step (provider-select skips the welcome gate).
  useEffect(() => {
    const checkGitBash = async () => {
      try {
        const status = await window.electronAPI.checkGitBash()
        setState(s => ({
          ...s,
          gitBashStatus: status,
          isCheckingGitBash: false,
          // Redirect to git-bash step when missing on Windows
          ...(status.platform === 'win32' && !status.found ? { step: 'git-bash' as const } : {}),
        }))
      } catch (error) {
        console.error('[Onboarding] Failed to check Git Bash:', error)
        // Even on error, allow continuing (will skip git-bash step)
        setState(s => ({ ...s, isCheckingGitBash: false }))
      }
    }
    checkGitBash()
  }, [])

  // Save provider metadata and credentials directly to Pi's global config.
  // Returns true on success, false on failure (sets errorMessage on failure)
  // `methodOverride` lets callers pass the method explicitly to avoid stale-closure issues
  // (e.g. when called from an async OAuth flow whose closure predates the state update).
  const handleSaveConfig = useCallback(async (
    credential?: string,
    options?: {
      baseUrl?: string
      providerDefaultModel?: string
      models?: string[]
      piAuthProvider?: string
      modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
      customEndpoint?: CustomEndpointConfig
    },
    methodOverride?: ApiSetupMethod,
    providerKeyOverride?: string,
    updateOnly?: boolean,
  ): Promise<boolean> => {
    const method = methodOverride ?? state.apiSetupMethod
    if (!method) {
      return false
    }

    setState(s => ({ ...s, completionStatus: 'saving' }))

    try {
      const key = options?.piAuthProvider || providerKeyOverride || editingSlug || resolveSlugForMethod(method, null, existingSlugs)
      const models = options?.models?.map(id => ({ id, name: id })) ?? []
      const provider: PiGlobalProvider = {
        ...(options?.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options?.customEndpoint?.api ? { api: options.customEndpoint.api } : {}),
        models,
      }
      const result = await window.electronAPI.savePiGlobalProvider({ key, provider, apiKey: credential })

      if (result.success) {
        setState(s => ({ ...s, completionStatus: 'complete' }))
        // Notify caller immediately so UI can reflect billing/model changes
        onConfigSaved?.()
        return true
      } else {
        console.error('[Onboarding] Save failed:', result.error)
        setState(s => ({
          ...s,
          completionStatus: 'saving',
          errorMessage: result.error || 'Failed to save configuration',
        }))
        return false
      }
    } catch (error) {
      console.error('[Onboarding] handleSaveConfig error:', error)
      setState(s => ({
        ...s,
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
      return false
    }
  }, [state.apiSetupMethod, onConfigSaved, editingSlug, existingSlugs])

  // Continue to next step
  const handleContinue = useCallback(async () => {
    switch (state.step) {
      case 'provider-select':
        // Handled by handleSelectProvider (card click navigates directly)
        break

      case 'welcome':
        // On Windows, check if Git Bash is needed
        if (state.gitBashStatus?.platform === 'win32' && !state.gitBashStatus?.found) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else {
          setState(s => ({ ...s, step: 'provider-select' }))
        }
        break

      case 'git-bash':
        setState(s => ({ ...s, step: 'provider-select' }))
        break

      case 'local-model':
        // Handled by handleSubmitLocalModel
        break

      case 'credentials':
        // Handled by handleSubmitCredential
        break

      case 'complete':
        onComplete()
        break
    }
  }, [state.step, state.gitBashStatus, state.apiSetupMethod, onComplete])

  // Go back to previous step. If at the initial step, call onDismiss instead.
  const handleBack = useCallback(() => {
    if (state.step === initialStep && onDismiss) {
      onDismiss()
      return
    }
    switch (state.step) {
      case 'git-bash':
        if (onDismiss) {
          onDismiss()
        }
        break
      case 'provider-select':
        // If on Windows and Git Bash was needed, go back to git-bash step
        if (state.gitBashStatus?.platform === 'win32' && state.gitBashStatus?.found === false) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else if (onDismiss) {
          onDismiss()
        }
        break
      case 'credentials':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'local-model':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
    }
  }, [state.step, state.gitBashStatus, initialStep, onDismiss])

  // Select API setup method (legacy — kept for direct edit flows)
  const handleSelectApiSetupMethod = useCallback((method: ApiSetupMethod) => {
    setState(s => ({ ...s, apiSetupMethod: method }))
  }, [])

  // Submit credential (API key + optional endpoint config)
  // Tests the connection first before saving to catch issues early
  const handleSubmitCredential = useCallback(async (data: ApiKeySubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    const isPiApiKeyFlow = state.apiSetupMethod === 'pi_api_key'

    try {
      // When editing an existing connection, API key is optional (empty = keep existing credential)
      if (!data.apiKey.trim() && editingSlug) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          providerDefaultModel: data.providerDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          customEndpoint: data.customEndpoint,
        })
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // API key validation differs by endpoint locality:
      // - Local/loopback custom endpoints may be keyless (e.g. Ollama)
      // - Non-local endpoints require an API key
      const isLoopbackCustomEndpoint = isLoopbackEndpoint(data.baseUrl)
      if (isPiApiKeyFlow) {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      } else {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      }

      const saved = await handleSaveConfig(data.apiKey, {
        baseUrl: data.baseUrl,
        providerDefaultModel: data.providerDefaultModel,
        models: data.models,
        piAuthProvider: data.piAuthProvider,
        modelSelectionMode: data.modelSelectionMode,
        customEndpoint: data.customEndpoint,
      })

      if (saved) {
        setState(s => ({
          ...s,
          credentialStatus: 'success',
          step: 'complete',
        }))
      } else {
        // Save failed — error is already set by handleSaveConfig, stay on credentials step
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Validation failed',
      }))
    }
  }, [handleSaveConfig, state.apiSetupMethod])

  // Map ProviderChoice → ApiSetupMethod and navigate to the right step
  const handleSelectProvider = useCallback((choice: ProviderChoice) => {
    if (choice === 'local') {
      setState(s => ({ ...s, step: 'local-model', apiSetupMethod: 'pi_api_key', credentialStatus: 'idle', errorMessage: undefined }))
      return
    }

    const method: ApiSetupMethod = 'pi_api_key'
    setState(s => ({
      ...s,
      apiSetupMethod: method,
      step: 'credentials',
      credentialStatus: 'idle',
      errorMessage: undefined,
    }))
  }, [])

  // Submit local model configuration (Ollama or any OpenAI-compatible local server)
  const handleSubmitLocalModel = useCallback(async (data: LocalModelSubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      const saved = await handleSaveConfig(undefined, {
        baseUrl: data.baseUrl,
        providerDefaultModel: data.model,
        models: data.models,
        customEndpoint: { api: 'openai-completions' },
      })

      if (saved) {
        setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      } else {
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
    }
  }, [handleSaveConfig])

  // Git Bash handlers (Windows only)
  const handleBrowseGitBash = useCallback(async () => {
    return window.electronAPI.browseForGitBash()
  }, [])

  const handleUseGitBashPath = useCallback(async (path: string) => {
    const result = await window.electronAPI.setGitBashPath(path)
    if (result.success) {
      // Update state to mark Git Bash as found and continue
      setState(s => ({
        ...s,
        gitBashStatus: { ...s.gitBashStatus!, found: true, path },
        step: 'provider-select',
      }))
    } else {
      setState(s => ({
        ...s,
        errorMessage: result.error || 'Invalid path',
      }))
    }
  }, [])

  const handleRecheckGitBash = useCallback(async () => {
    setState(s => ({ ...s, isRecheckingGitBash: true }))
    try {
      const status = await window.electronAPI.checkGitBash()
      setState(s => ({
        ...s,
        gitBashStatus: status,
        isRecheckingGitBash: false,
        // If found, automatically continue to next step
        step: status.found ? 'provider-select' : s.step,
      }))
    } catch (error) {
      console.error('[Onboarding] Failed to recheck Git Bash:', error)
      setState(s => ({ ...s, isRecheckingGitBash: false }))
    }
  }, [])

  const handleClearError = useCallback(() => {
    setState(s => ({ ...s, errorMessage: undefined }))
  }, [])

  // Skip setup — user chose "Setup later"
  const handleSkipSetup = useCallback(async () => {
    try {
      await window.electronAPI.deferSetup()
    } catch (error) {
      console.error('[Onboarding] Failed to defer setup:', error)
    }
    onComplete()
  }, [onComplete])

  // Finish onboarding
  const handleFinish = useCallback(() => {
    onComplete()
  }, [onComplete])

  // Cancel onboarding
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, step: 'welcome' }))
  }, [])

  // Jump directly to credentials step with a pre-set method (for editing existing connections)
  const jumpToCredentials = useCallback((method: ApiSetupMethod) => {
    setState(s => ({
      ...s,
      step: 'credentials' as const,
      apiSetupMethod: method,
      credentialStatus: 'idle' as const,
      errorMessage: undefined,
    }))
  }, [])

  // Reset onboarding to initial state (used after modal close)
  const reset = useCallback(() => {
    setState({
      step: initialStep,
      loginStatus: 'idle',
      credentialStatus: 'idle',
      completionStatus: 'saving',
      apiSetupMethod: initialApiSetupMethod ?? null,
      isExistingUser: false,
      errorMessage: undefined,
    })
  }, [initialStep, initialApiSetupMethod])

  return {
    state,
    handleContinue,
    handleBack,
    handleSelectProvider,
    handleSelectApiSetupMethod,
    handleSubmitCredential,
    handleSubmitLocalModel,
    // Git Bash (Windows)
    handleBrowseGitBash,
    handleUseGitBashPath,
    handleRecheckGitBash,
    handleClearError,
    handleSkipSetup,
    handleFinish,
    handleCancel,
    jumpToCredentials,
    reset,
  }
}

