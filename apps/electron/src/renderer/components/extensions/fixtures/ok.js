export function mount(context) {
  const node = document.createElement('span')
  node.textContent = context.root.dataset.mortiseExtensionMode === 'append' ? 'mounted' : 'other'
  context.root.append(node)
  return { dispose: async () => node.remove() }
}
