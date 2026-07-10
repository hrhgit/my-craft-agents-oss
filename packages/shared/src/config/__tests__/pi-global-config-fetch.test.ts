import { afterEach, describe, expect, it } from 'bun:test'
import { fetchModelsForEndpoint, fetchModelsForEndpointWithResolution, normalizePiCustomEndpointBaseUrl } from '../pi-global-config'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    ...init,
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('normalizePiCustomEndpointBaseUrl', () => {
  it('adds /v1 for pathless OpenAI-compatible endpoints', () => {
    expect(normalizePiCustomEndpointBaseUrl('https://api.example.com', 'openai-completions')).toBe('https://api.example.com/v1')
  })

  it('collapses duplicate OpenAI-compatible version suffixes', () => {
    expect(normalizePiCustomEndpointBaseUrl('https://api.example.com/v1/v1', 'openai-responses')).toBe('https://api.example.com/v1')
  })

  it('uses /api/v1 for OpenRouter root URLs', () => {
    expect(normalizePiCustomEndpointBaseUrl('https://openrouter.ai', 'openai-completions')).toBe('https://openrouter.ai/api/v1')
    expect(normalizePiCustomEndpointBaseUrl('https://openrouter.ai/api/v1/v1', 'openai-completions')).toBe('https://openrouter.ai/api/v1')
  })

  it('preserves custom version paths and strips copied resource endpoints', () => {
    expect(normalizePiCustomEndpointBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'openai-completions')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('removes trailing /v1 for Anthropic-compatible runtime base URLs', () => {
    expect(normalizePiCustomEndpointBaseUrl('https://api.anthropic.com/v1', 'anthropic-messages')).toBe('https://api.anthropic.com')
    expect(normalizePiCustomEndpointBaseUrl('https://proxy.example.com/anthropic/v1/messages', 'anthropic-messages')).toBe('https://proxy.example.com/anthropic')
  })

  it('adds /v1beta for pathless Google Generative AI endpoints', () => {
    expect(normalizePiCustomEndpointBaseUrl('https://generativelanguage.googleapis.com', 'google-generative-ai')).toBe('https://generativelanguage.googleapis.com/v1beta')
  })
})

describe('fetchModelsForEndpoint', () => {
  it('fetches OpenAI-compatible models with optional bearer auth', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      })
      return jsonResponse({ data: [{ id: 'gpt-5-mini', owned_by: 'openai' }] })
    }) as typeof fetch

    const models = await fetchModelsForEndpoint('https://api.example.com/v1/', 'sk-test', {
      api: 'openai-responses',
    })

    expect(calls[0]).toEqual({
      url: 'https://api.example.com/v1/models',
      headers: { Accept: 'application/json', Authorization: 'Bearer sk-test' },
    })
    expect(models).toEqual([{ id: 'gpt-5-mini', name: 'gpt-5-mini', ownedBy: 'openai' }])
  })

  it('omits bearer auth for OpenAI-compatible local endpoints when authHeader is off', async () => {
    const calls: Array<{ headers: Record<string, string> }> = []
    globalThis.fetch = (async (_input, init) => {
      calls.push({ headers: init?.headers as Record<string, string> })
      return jsonResponse({ models: [{ id: 'local-model' }] })
    }) as typeof fetch

    const models = await fetchModelsForEndpoint('http://localhost:11434/v1', '', {
      api: 'openai-completions',
      authHeader: false,
    })

    expect(calls[0]?.headers).toEqual({ Accept: 'application/json' })
    expect(models[0]?.id).toBe('local-model')
  })

  it('fetches Anthropic-compatible models with x-api-key headers', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
      return jsonResponse({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }] })
    }) as typeof fetch

    const result = await fetchModelsForEndpointWithResolution('https://api.anthropic.com/v1', 'sk-ant-test', {
      api: 'anthropic-messages',
    })

    expect(calls[0]).toEqual({
      url: 'https://api.anthropic.com/v1/models',
      headers: {
        Accept: 'application/json',
        'x-api-key': 'sk-ant-test',
        'anthropic-version': '2023-06-01',
      },
    })
    expect(result.resolvedBaseUrl).toBe('https://api.anthropic.com')
    expect(result.models).toEqual([{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', ownedBy: 'Anthropic' }])
  })

  it('fetches Google Generative AI models with key query auth and normalized ids', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      })
      return jsonResponse({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }] })
    }) as typeof fetch

    const models = await fetchModelsForEndpoint('https://generativelanguage.googleapis.com/v1beta', 'AIza-test', {
      api: 'google-generative-ai',
    })

    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test')
    expect(calls[0]?.headers).toEqual({ Accept: 'application/json', 'x-goog-api-key': 'AIza-test' })
    expect(models).toEqual([{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', ownedBy: 'Google' }])
  })

  it('auto-detects missing /v1 for third-party OpenAI-compatible endpoints', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input, _init) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://api.third-party.example/v1/models') {
        return jsonResponse({ data: [{ id: 'third-party-chat' }] })
      }
      return textResponse('<!doctype html><html></html>', {
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    const result = await fetchModelsForEndpointWithResolution('https://api.third-party.example', 'sk-test', {
      api: 'openai-completions',
    })

    expect(calls).toEqual([
      'https://api.third-party.example/models',
      'https://api.third-party.example/v1/models',
    ])
    expect(result.resolvedBaseUrl).toBe('https://api.third-party.example/v1')
    expect(result.models[0]?.id).toBe('third-party-chat')
  })

  it('auto-detects /api/v1 for OpenRouter root URLs', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input, _init) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://openrouter.ai/api/v1/models') {
        return jsonResponse({ data: [{ id: 'openrouter/auto' }] })
      }
      return textResponse('<!doctype html><html></html>', {
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    const result = await fetchModelsForEndpointWithResolution('https://openrouter.ai', 'sk-test', {
      api: 'openai-completions',
    })

    expect(calls).toEqual([
      'https://openrouter.ai/models',
      'https://openrouter.ai/api/v1/models',
    ])
    expect(result.resolvedBaseUrl).toBe('https://openrouter.ai/api/v1')
    expect(result.models[0]?.id).toBe('openrouter/auto')
  })

  it('does not append common paths when a custom version path is already present', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input, _init) => {
      calls.push(String(input))
      return jsonResponse({ data: [{ id: 'qwen-plus' }] })
    }) as typeof fetch

    const result = await fetchModelsForEndpointWithResolution('https://dashscope.aliyuncs.com/compatible-mode/v1', 'sk-test', {
      api: 'openai-completions',
    })

    expect(calls).toEqual([
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    ])
    expect(result.resolvedBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('reports HTML endpoint responses as a wrong API base URL', async () => {
    globalThis.fetch = (async (_input, _init) => textResponse('<!doctype html><html><body>Dashboard</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch

    await expect(fetchModelsForEndpoint('https://openrouter.ai', 'sk-test', {
      api: 'openai-completions',
    })).rejects.toThrow(/returned HTML instead of JSON/)
  })

  it('redacts query API keys in parse errors', async () => {
    globalThis.fetch = (async (_input, _init) => textResponse('not-json', {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    await expect(fetchModelsForEndpoint('https://example.com/v1/models?key=secret-key', '', {
      api: 'google-generative-ai',
    })).rejects.toThrow(/key=REDACTED/)
  })
})
