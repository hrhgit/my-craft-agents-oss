export async function mount(context) {
  await new Promise((resolve) => setTimeout(resolve, 25))
  const node = document.createElement('span')
  node.textContent = 'slow'
  context.root.append(node)
  return () => node.remove()
}
