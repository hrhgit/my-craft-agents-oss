type KeyboardCloseInput = Pick<Electron.Input, 'type' | 'key' | 'control' | 'meta'>

export function isKeyboardCloseShortcut(
  input: KeyboardCloseInput | null | undefined,
  platform = process.platform,
): boolean {
  if (!input || input.type !== 'keyDown' || input.key?.toLowerCase() !== 'w') return false
  return platform === 'darwin' ? Boolean(input.meta) : Boolean(input.control)
}
