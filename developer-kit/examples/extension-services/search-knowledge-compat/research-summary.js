export async function mount(context) {
  const module = await context.dependencies.use('search').module('search-result-view').load()
  const root = document.createElement('section')
  root.className = 'example-research-summary'
  root.dataset.mortiseUiSemantic = 'example.research.summary'
  root.append(module.createSearchResultView())
  const label = document.createElement('p')
  label.textContent = 'Research composition is active'
  root.append(label)
  context.root.append(root)
  return () => root.remove()
}
