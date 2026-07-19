import type { LlmAuthType, ModelProvider } from '@mortise/shared/agent/backend'
import type { PiGlobalProvider } from '@mortise/shared/config'
import type { FileAttachment } from '@mortise/shared/protocol'

export interface BackendRuntimeSignatureInput {
  providerKey?: string
  providerConfig: PiGlobalProvider | null
  provider: ModelProvider
  authType?: LlmAuthType
  resolvedModel: string
}

export interface ModelAttachmentFilterResult {
  attachments?: FileAttachment[]
  omittedImages: FileAttachment[]
}

function stableModels(provider: PiGlobalProvider | null): unknown[] {
  return (provider?.models ?? []).map(model => ({
    id: model.id,
    input: model.input,
    contextWindow: model.contextWindow,
  })).sort((a, b) => a.id.localeCompare(b.id))
}

export function normalizeProviderRuntimeBaseUrl(provider: PiGlobalProvider | null | undefined): string | undefined {
  return provider?.baseUrl?.trim() || undefined
}

export function buildRestartRequiredSignature(input: BackendRuntimeSignatureInput): string {
  return JSON.stringify({
    provider: input.provider,
    providerKey: input.providerKey,
    authType: input.authType,
    api: input.providerConfig?.api,
  })
}

export function buildBackendRuntimeSignature(input: BackendRuntimeSignatureInput): string {
  return JSON.stringify({
    provider: input.provider,
    providerKey: input.providerKey,
    authType: input.authType,
    resolvedModel: input.resolvedModel,
    baseUrl: normalizeProviderRuntimeBaseUrl(input.providerConfig),
    api: input.providerConfig?.api,
    models: stableModels(input.providerConfig),
  })
}

export function isImageAttachment(attachment: Pick<FileAttachment, 'type' | 'mimeType'>): boolean {
  return attachment.type === 'image' || attachment.mimeType?.startsWith('image/') === true
}

export function filterAttachmentsForModelInput(
  attachments: FileAttachment[] | undefined,
  provider: PiGlobalProvider | null,
  modelId: string,
): ModelAttachmentFilterResult {
  if (!attachments?.length) return { attachments, omittedImages: [] }
  const model = provider?.models?.find(item => item.id === modelId)
  if (!model || model.input?.includes('image')) return { attachments, omittedImages: [] }

  const modelAttachments: FileAttachment[] = []
  const omittedImages: FileAttachment[] = []
  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) omittedImages.push(attachment)
    else modelAttachments.push(attachment)
  }
  return { attachments: modelAttachments.length ? modelAttachments : undefined, omittedImages }
}
