export default function conversationBoard(pi) {
  pi.registerFrontendChannel('board-state', { scope: 'session', snapshot: { pinned: 0 }, onMessage(message, ctx) { const pinned = message?.action === 'pin' ? 1 : 0; ctx.ui.publishFrontendState('board-state', { pinned }); return { pinned } } })
}
