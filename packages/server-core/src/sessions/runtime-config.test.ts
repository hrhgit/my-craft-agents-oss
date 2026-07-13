import { describe, expect, it } from 'bun:test'
import type { PiGlobalProvider } from '@craft-agent/shared/config'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, filterAttachmentsForModelInput } from './runtime-config'

const provider: PiGlobalProvider = {
  baseUrl: 'http://localhost:11434/v1',
  api: 'openai-completions',
  models: [{ id: 'text', input: ['text'] }, { id: 'vision', input: ['text', 'image'] }],
}

describe('provider runtime signatures', () => {
  const input = { providerKey: 'local', providerConfig: provider, provider: 'pi' as const, authType: 'api_key' as const, resolvedModel: 'text' }

  it('changes runtime signature when the model changes', () => {
    expect(buildBackendRuntimeSignature(input)).not.toBe(buildBackendRuntimeSignature({ ...input, resolvedModel: 'vision' }))
  })

  it('changes restart signature when provider routing changes', () => {
    expect(buildRestartRequiredSignature(input)).not.toBe(buildRestartRequiredSignature({ ...input, providerKey: 'other' }))
  })
})

describe('provider image capability filtering', () => {
  const image = { id: 'image', name: 'image.png', type: 'image' as const, mimeType: 'image/png', path: '/image.png', size: 1 }

  it('omits images for a text-only model', () => {
    expect(filterAttachmentsForModelInput([image], provider, 'text').omittedImages).toHaveLength(1)
  })

  it('keeps images for a vision model', () => {
    expect(filterAttachmentsForModelInput([image], provider, 'vision').attachments).toEqual([image])
  })
})
