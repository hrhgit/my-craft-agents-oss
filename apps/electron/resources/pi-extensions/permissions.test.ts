import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import permissionsExtension, { permissionsExtensionInternals } from './permissions.js'

function loadExtension(entries: unknown[] = [], legacyMode?: string, configuredMode?: string) {
  const handlers = new Map<string, Function>()
  const commands = new Map<string, any>()
  const contributions: any[] = []
  const appended: any[] = []
  const confirmations: string[] = []
  const pi = {
    environment: { config: configuredMode === undefined ? {} : { mode: configuredMode } },
    on(event: string, handler: Function) { handlers.set(event, handler) },
    registerCommand(name: string, command: any) { commands.set(name, command) },
    appendEntry(customType: string, data: unknown) { appended.push({ customType, data }) },
  }
  permissionsExtension(pi as any)
  const ctx = {
    sessionManager: {
      getBranch: () => entries,
      getHeader: () => legacyMode ? { mortise: { permissionMode: legacyMode } } : null,
    },
    ui: {
      capabilities: { dialogs: true, contributions: true },
      upsertContribution(value: unknown) { contributions.push(value) },
      async confirm(_title: string, message: string) {
        confirmations.push(message)
        return true
      },
    },
  }
  return { handlers, commands, contributions, appended, confirmations, ctx }
}

describe('Mortise permissions extension', () => {
  it('owns the only two approval settings outside Mortise core defaults', () => {
    const extensionPackage = JSON.parse(readFileSync(join(import.meta.dir, 'package.json'), 'utf8'))
    const declaration = extensionPackage.pi.extensions.find((entry: any) => entry.id === 'mortise-permissions')
    const modeField = declaration.ui.settings.fields.find((field: any) => field.key === 'mode')
    const coreDefaults = JSON.parse(readFileSync(join(import.meta.dir, '..', 'config-defaults.json'), 'utf8'))

    expect(modeField.options.map((option: any) => option.value)).toEqual(['ask', 'allow-all'])
    expect(coreDefaults.workspaceDefaults).toEqual({ thinkingLevel: 'medium' })
  })

  it('migrates legacy safe state to ask without adding model context', async () => {
    const f = loadExtension([], 'safe')
    await f.handlers.get('session_start')?.({ type: 'session_start', reason: 'resume' }, f.ctx)

    const content = f.contributions.at(-1).content
    expect(content).toMatchObject({ type: 'menu', label: 'Ask' })
    expect(content.options.find((option: any) => option.id === 'ask')?.selected).toBe(true)
    expect(f.appended).toEqual([])
    expect(permissionsExtensionInternals.normalizeMode('safe')).toBe('ask')
  })

  it('persists allow-all in a custom entry and restores it', async () => {
    const f = loadExtension()
    await f.handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, f.ctx)
    await f.commands.get('mortise-permissions-allow-all').handler('', f.ctx)

    expect(f.appended).toEqual([{ customType: 'mortise.permissions.mode', data: { mode: 'allow-all' } }])
    const content = f.contributions.at(-1).content
    expect(content).toMatchObject({ type: 'menu', label: 'Execute' })
    expect(content.options.find((option: any) => option.id === 'allow-all')?.selected).toBe(true)
    expect(permissionsExtensionInternals.restoreMode({
      getBranch: () => [{ type: 'custom', customType: 'mortise.permissions.mode', data: { mode: 'allow-all' } }],
      getHeader: () => null,
    } as any)).toBe('allow-all')
  })

  it('uses extension settings as the default while session state remains authoritative', async () => {
    const configured = loadExtension([], 'ask', 'allow-all')
    await configured.handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, configured.ctx)
    const content = configured.contributions.at(-1).content
    expect(content).toMatchObject({ type: 'menu', label: 'Execute' })
    expect(content.options.find((option: any) => option.id === 'allow-all')?.selected).toBe(true)

    expect(permissionsExtensionInternals.restoreMode({
      getBranch: () => [{ type: 'custom', customType: 'mortise.permissions.mode', data: { mode: 'ask' } }],
      getHeader: () => ({ mortise: { permissionMode: 'allow-all' } }),
    } as any, 'allow-all')).toBe('ask')
  })

  it('allows reads, asks for mutations, and fails closed without dialogs', async () => {
    const f = loadExtension([], undefined, 'ask')
    await f.handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, f.ctx)
    const toolCall = f.handlers.get('tool_call')!

    expect(await toolCall({ toolName: 'read', toolCallId: 'read-1', input: { path: 'README.md' } }, f.ctx)).toBeUndefined()
    expect(await toolCall({ toolName: 'write', toolCallId: 'write-1', input: { path: 'out.txt' } }, f.ctx)).toBeUndefined()
    expect(f.confirmations).toEqual(['write: out.txt'])

    const headless = { ...f.ctx, ui: { ...f.ctx.ui, capabilities: { dialogs: false, contributions: false } } }
    expect(await toolCall({ toolName: 'bash', toolCallId: 'bash-1', input: { command: 'rm file' } }, headless))
      .toEqual({ block: true, reason: 'Tool approval requires an interactive Mortise client.' })
  })
})
