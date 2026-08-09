import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'settings.app.sending.midStream.steer': '引导',
      'common.delete': '删除',
      'common.edit': '编辑',
    }[key] ?? key),
  }),
}))

const { QueuedMessageList } = await import('../QueuedMessageList')

describe('QueuedMessageList', () => {
  it('renders only the queued content and its steer, delete, and edit actions', () => {
    const markup = renderToStaticMarkup(createElement(QueuedMessageList, {
      items: [{ id: 'queued-1', content: 'Keep this next instruction nearby' }],
      onSteer: () => {},
      onDelete: () => {},
      onEdit: () => {},
    }))

    expect(markup).toContain('Keep this next instruction nearby')
    expect(markup).toContain('conversation.queued-message.queued-1.steer')
    expect(markup).toContain('conversation.queued-message.queued-1.delete')
    expect(markup).toContain('conversation.queued-message.queued-1.edit')
    expect(markup).toContain('>引导</span>')
    expect(markup).not.toContain('chat.queuedBadge')
    expect(markup).not.toContain('Queued')
  })
})
