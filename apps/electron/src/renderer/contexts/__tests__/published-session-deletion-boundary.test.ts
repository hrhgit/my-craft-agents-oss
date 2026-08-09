import { describe, expect, it } from 'bun:test'

const navigationSource = await Bun.file(new URL('../NavigationContext.tsx', import.meta.url)).text()
const appSource = await Bun.file(new URL('../../App.tsx', import.meta.url)).text()

describe('published Session deletion boundary', () => {
  it('does not infer persistent Session cleanup from renderer metadata', () => {
    expect(navigationSource).not.toContain('onAutoDeleteEmptySession')
    expect(navigationSource).not.toContain('EMPTY SESSION CLEANUP')
    expect(navigationSource).not.toContain('!meta.lastFinalMessageId && !meta.name')
    expect(appSource).not.toContain('handleAutoDeleteEmptySession')
  })

  it('routes every navigation deletion through the explicit confirmation owner', () => {
    const deleteAction = navigationSource.slice(
      navigationSource.indexOf("case 'delete-session':"),
      navigationSource.indexOf("case 'set-mode':"),
    )

    expect(deleteAction).toContain('await onDeleteSession(parsed.id)')
    expect(deleteAction).not.toContain('window.electronAPI.deleteSession')
  })

  it('never skips confirmation by guessing that a published Session is empty', () => {
    const deleteHandler = appSource.slice(
      appSource.indexOf('const handleDeleteSession'),
      appSource.indexOf('const handleSetActiveViewingSession'),
    )

    expect(deleteHandler).toContain('showDeleteSessionConfirmation')
    expect(deleteHandler).not.toContain('const isEmpty')
    expect(deleteHandler).not.toContain('lastFinalMessageId')
  })
})
