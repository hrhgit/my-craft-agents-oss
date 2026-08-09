import { describe, expect, it } from 'bun:test'
import webSearchExtension from './web-search.js'

describe('Mortise web-search fallback extension', () => {
  it('registers one bounded web_search tool', () => {
    const tools: any[] = []
    webSearchExtension({ registerTool(tool: any) { tools.push(tool) } })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
    expect(tools[0].parameters.required).toEqual(['query'])
    expect(tools[0].parameters.properties.maxResults.maximum).toBe(10)
  })
})
