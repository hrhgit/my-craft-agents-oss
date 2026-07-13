/**
 * CredentialsStep - Onboarding step wrapper for API key flow
 *
 * Thin wrapper that composes ApiKeyInput with StepFormLayout for the
 * onboarding wizard context.
 */

import { useTranslation } from "react-i18next"
import type { ApiSetupMethod } from "./APISetupStep"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import {
  ApiKeyInput,
  type ApiKeyStatus,
  type ApiKeySubmitData,
} from "../apisetup"
import type { PiCustomApi as CustomEndpointApi } from '@craft-agent/shared/config/pi-provider-models'

export type CredentialStatus = ApiKeyStatus

interface CredentialsStepProps {
  apiSetupMethod: ApiSetupMethod
  status: CredentialStatus
  errorMessage?: string
  onSubmit: (data: ApiKeySubmitData) => void
  onBack: () => void
  // Edit mode (pre-fill existing connection values)
  editInitialValues?: {
    apiKey?: string
    baseUrl?: string
    providerDefaultModel?: string
    activePreset?: string
    models?: string[]
    customApi?: CustomEndpointApi
  }
}

export function CredentialsStep({
  apiSetupMethod,
  status,
  errorMessage,
  onSubmit,
  onBack,
  editInitialValues,
}: CredentialsStepProps) {
  const { t } = useTranslation()

  // --- API Key flow ---
  const providerType = 'pi_api_key'
  const apiKeyDescription = "Select a provider preset and enter the API key."

  const apiKeyInputKey = [
    apiSetupMethod,
    editInitialValues?.activePreset ?? '',
    editInitialValues?.baseUrl ?? '',
    editInitialValues?.providerDefaultModel ?? '',
    (editInitialValues?.models ?? []).join('|'),
    editInitialValues?.customApi ?? '',
  ].join('::')

  return (
    <StepFormLayout
      title={t("onboarding.credentials.apiConfiguration")}
      description={apiKeyDescription}
      actions={
        <>
          <BackButton onClick={onBack} disabled={status === 'validating'} />
          <ContinueButton
            type="submit"
            form="api-key-form"
            disabled={false}
            loading={status === 'validating'}
            loadingText={t("common.validating")}
          />
        </>
      }
    >
      <ApiKeyInput
        key={apiKeyInputKey}
        status={status as ApiKeyStatus}
        errorMessage={errorMessage}
        onSubmit={onSubmit}
        providerType={providerType}
        initialValues={editInitialValues}
      />
    </StepFormLayout>
  )
}
