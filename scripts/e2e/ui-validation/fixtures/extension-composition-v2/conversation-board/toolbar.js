export async function mount(context) {
  const kit = await context.dependencies.extension('mortise-ui-kit').module('components').load()
  const node = kit.Toolbar({ className: 'conversation-board-toolbar' })
  node.append(kit.Button({ label: 'Board', onClick: () => context.notify('Conversation board is active', 'success') }), kit.Badge({ label: context.locale }))
  context.root.append(node)
  return () => node.remove()
}
