import { describe, expect, it } from 'bun:test'
import { isKeyboardCloseShortcut } from '../keyboard-close-shortcut'

describe('keyboard close shortcut', () => {
  it('uses Command on macOS and Control elsewhere', () => {
    expect(isKeyboardCloseShortcut({ type: 'keyDown', key: 'W', meta: true, control: false }, 'darwin')).toBe(true)
    expect(isKeyboardCloseShortcut({ type: 'keyDown', key: 'w', meta: false, control: true }, 'win32')).toBe(true)
    expect(isKeyboardCloseShortcut({ type: 'keyDown', key: 'w', meta: true, control: false }, 'win32')).toBe(false)
  })

  it('ignores key-up and unrelated keys', () => {
    expect(isKeyboardCloseShortcut({ type: 'keyUp', key: 'w', meta: false, control: true }, 'win32')).toBe(false)
    expect(isKeyboardCloseShortcut({ type: 'keyDown', key: 'q', meta: false, control: true }, 'win32')).toBe(false)
  })
})
