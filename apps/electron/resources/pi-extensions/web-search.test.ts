import { afterEach, describe, expect, it } from 'bun:test'
import webSearchExtension, { parseBing, parseDuckDuckGo } from './web-search.js'

const originalFetch = globalThis.fetch
const originalBackends = process.env.MORTISE_WEB_SEARCH_BACKENDS

function registeredTool(): any {
  const tools: any[] = []
  webSearchExtension({ registerTool(tool: any) { tools.push(tool) } })
  return tools[0]
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBackends === undefined) delete process.env.MORTISE_WEB_SEARCH_BACKENDS
  else process.env.MORTISE_WEB_SEARCH_BACKENDS = originalBackends
})

describe('Mortise web-search fallback extension', () => {
  it('registers one bounded web_search tool', () => {
    const tools: any[] = []
    webSearchExtension({ registerTool(tool: any) { tools.push(tool) } })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
    expect(tools[0].parameters.required).toEqual(['query'])
    expect(tools[0].parameters.properties.maxResults.maximum).toBe(10)
  })

  it('parses Bing and DuckDuckGo result markup', () => {
    expect(parseBing(
      '<li class="b_algo"><h2><a href="https://example.com/a?x=1">Example &amp; One</a></h2></li>',
      5,
    )).toEqual([{ title: 'Example & One', url: 'https://example.com/a?x=1', domain: 'example.com' }])
    expect(parseDuckDuckGo(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Example Two</a>',
      5,
    )).toEqual([{ title: 'Example Two', url: 'https://example.org/b', domain: 'example.org' }])
  })

  it('uses Bing first when it returns results', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(
        '<li class="b_algo"><h2><a href="https://example.com/result">Bing Result</a></h2></li>',
        { status: 200 },
      )
    }) as typeof fetch

    const result = await registeredTool().execute('call-1', { query: 'mortise' }, new AbortController().signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toStartWith('https://www.bing.com/search?')
    expect(result.isError).toBeUndefined()
    expect(result.details.backend).toBe('bing')
    expect(result.details.sources[0].url).toBe('https://example.com/result')
  })

  it('falls back to DuckDuckGo after a Bing connection failure', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (calls.length === 1) throw new Error('Unable to connect')
      return new Response(
        '<a class="result__a" href="https://example.org/fallback">Fallback Result</a>',
        { status: 200 },
      )
    }) as typeof fetch

    const result = await registeredTool().execute('call-2', { query: 'mortise' }, new AbortController().signal)

    expect(calls).toHaveLength(2)
    expect(result.isError).toBeUndefined()
    expect(result.details.backend).toBe('duckduckgo')
    expect(result.details.attempts).toEqual([
      { backend: 'bing', status: 'failed', error: 'Unable to connect' },
      { backend: 'duckduckgo', status: 'success' },
    ])
  })

  it('reports every failed backend instead of exposing one raw fetch error', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      throw new Error(String(url).includes('bing.com') ? 'Bing blocked' : 'DuckDuckGo blocked')
    }) as typeof fetch

    const result = await registeredTool().execute('call-3', { query: 'mortise' }, new AbortController().signal)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('网页搜索后端均不可用')
    expect(result.content[0].text).toContain('Bing blocked')
    expect(result.content[0].text).toContain('DuckDuckGo blocked')
    expect(result.details.sources).toEqual([])
  })
})
