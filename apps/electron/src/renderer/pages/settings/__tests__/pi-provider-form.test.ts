import { describe, expect, it } from 'bun:test'
import type { FetchedEndpointModel } from '../../../../shared/types'
import {
  addSelectedFetchedModel,
  applyFetchedEndpointResolution,
  type FormState,
} from '../PiProviderFormDialog'

function formState(overrides: Partial<FormState> = {}): FormState {
  return {
    key: 'example',
    baseUrl: 'https://api.example.test/v1',
    apiKey: '',
    api: 'openai-completions',
    authHeader: true,
    defaultModel: '',
    models: [],
    ...overrides,
  }
}

const fetchedModels: FetchedEndpointModel[] = [
  { id: 'model-a', name: 'Model A', ownedBy: 'Example' },
  { id: 'model-b', name: 'Model B', ownedBy: 'Example' },
]

describe('Pi provider model fetching', () => {
  it('keeps fetched models as candidates instead of adding them to the form', () => {
    const existing = { id: 'existing-model', name: 'Existing Model' }
    const state = formState({
      defaultModel: existing.id,
      models: [existing],
    })

    const next = applyFetchedEndpointResolution(state, 'https://api.example.test/v1/')

    expect(next.baseUrl).toBe('https://api.example.test/v1/')
    expect(next.defaultModel).toBe(existing.id)
    expect(next.models).toEqual([existing])
  })

  it('adds only the model explicitly selected from fetched candidates', () => {
    const next = addSelectedFetchedModel(formState(), fetchedModels, 'model-b')

    expect(next.defaultModel).toBe('model-b')
    expect(next.models).toEqual([{ id: 'model-b', name: 'Model B' }])
  })

  it('does not duplicate an already configured selected model', () => {
    const state = formState({
      defaultModel: 'model-a',
      models: [{ id: 'model-a', name: 'Customized name' }],
    })

    expect(addSelectedFetchedModel(state, fetchedModels, 'model-a')).toBe(state)
  })
})
