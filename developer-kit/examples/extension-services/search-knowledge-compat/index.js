export default function searchKnowledgeComposition(pi) {
  const search = pi.services.use('search')
  const knowledge = pi.services.use('knowledge')
  pi.services.provide('research.summary', {
    async compose(input, context) {
      const searched = await search.invoke('query', { query: input.query }, { signal: context.signal })
      let text = ''
      if (knowledge.available) {
        try { text = (await knowledge.invoke('read', { topic: input.topic ?? input.query }, { signal: context.signal })).text } catch { text = '' }
      }
      return { summary: text || 'Knowledge provider is unavailable; returning search results only.', results: searched.results, knowledgeAvailable: Boolean(text) }
    },
  })
}
