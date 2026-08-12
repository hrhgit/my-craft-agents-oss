const records = [
  { title: 'Extension composition', snippet: 'Capabilities are the composition unit; extensions remain isolated installation units.' },
  { title: 'Mortise Developer Kit', snippet: 'The project CLI validates real Electron and WebUI extension workflows.' },
]

export default function searchProvider(pi) {
  pi.services.provide('search.query', {
    async query(input, context) {
      const query = String(input.query).toLowerCase()
      context.reportProgress({ message: 'Searching local example index', completed: 1, total: 2 })
      const results = records.filter(record => `${record.title} ${record.snippet}`.toLowerCase().includes(query))
      context.reportProgress({ message: 'Search complete', completed: 2, total: 2, data: { resultCount: results.length } })
      return { results }
    },
  })
}
