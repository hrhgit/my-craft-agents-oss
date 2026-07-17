import { ElectronUiDriverError } from './electron-ui-driver-error'

export interface BrowserViewKeyAction {
  instanceId: string
  key: 'F6' | '[' | ']'
  modifiers: Array<'control' | 'meta'>
}

export function parseBrowserViewKeyAction(params: Record<string, unknown>): BrowserViewKeyAction {
  const instanceId = typeof params.instanceId === 'string' ? params.instanceId.trim() : ''
  if (!instanceId || instanceId.length > 200) {
    throw new ElectronUiDriverError('INVALID_REQUEST', 'Browser key action requires a bounded instanceId.')
  }

  const key = params.key
  const rawModifiers = Array.isArray(params.modifiers) ? params.modifiers : []
  if (!rawModifiers.every(modifier => modifier === 'control' || modifier === 'meta')) {
    throw new ElectronUiDriverError('UNSUPPORTED', 'Browser key action accepts only control or meta modifiers.')
  }
  const modifiers = [...new Set(rawModifiers)] as Array<'control' | 'meta'>

  if (key === 'F6' && modifiers.length === 0) return { instanceId, key, modifiers }
  if ((key === '[' || key === ']') && modifiers.length === 1) {
    return { instanceId, key, modifiers }
  }
  throw new ElectronUiDriverError(
    'UNSUPPORTED',
    'Browser key action is limited to F6, Ctrl/Cmd+[, and Ctrl/Cmd+].',
  )
}
