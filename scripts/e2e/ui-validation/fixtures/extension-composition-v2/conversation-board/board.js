export async function mount(context) {
  const kit = await context.dependencies.extension('mortise-ui-kit').module('components').load()
  const stack = kit.Stack({ className: 'conversation-board', semanticId: 'conversation-board.board' })
  const header = kit.Row({ className: 'conversation-board-header' })
  header.append(kit.Badge({ label: 'BOARD' }), kit.Status({ label: context.route.sessionId ? 'Session live' : 'Workspace' }))
  const summary = kit.Row({ className: 'conversation-board-summary' })
  summary.append(kit.Button({ label: 'Pin current turn', semanticId: 'conversation-board.pin', onClick: () => context.backend.channel('board-state').send({ action: 'pin' }) }), kit.EmptyState({ label: 'No pinned turns yet' }))
  stack.append(header, kit.Divider(), summary)
  context.root.append(stack)
  return () => stack.remove()
}
