import { describe, expect, it } from 'bun:test'
import permissionsExtension from './index.js'

function loadExtension(entries: unknown[] = [], legacyMode?: string, configuredMode?: string) {
  const handlers = new Map<string, Function>()
  const commands = new Map<string, any>()
  const channels = new Map<string, any>()
  const appended: any[] = []
  const published: Array<{ channel: string; state: any }> = []
  const pi = {
    environment: { config: configuredMode === undefined ? {} : { mode: configuredMode } },
    on(event: string, handler: Function) { handlers.set(event, handler) },
    registerCommand(name: string, command: any) { commands.set(name, command) },
    registerFrontendChannel(name: string, channel: any) { channels.set(name, channel) },
    appendEntry(customType: string, data: unknown) { appended.push({ customType, data }) },
  }
  permissionsExtension(pi as any)
  const ctx = {
    sessionManager: {
      getBranch: () => entries,
      getHeader: () => legacyMode ? { mortise: { permissionMode: legacyMode } } : null,
    },
    ui: {
      capabilities: { dialogs: false, contributions: true },
      publishFrontendState(channel: string, state: unknown) { published.push({ channel, state }) },
    },
  }
  return { handlers, commands, channels, appended, published, ctx }
}

function latestApproval(fixture: ReturnType<typeof loadExtension>) {
  return fixture.published.filter(item => item.channel === 'permission-approval').at(-1)?.state
}

describe('Mortise permissions extension', () => {
  it('restores the latest extension state and legacy values without persisting a duplicate', async () => {
    const fixture = loadExtension([
      { type: 'custom', customType: 'mortise.permissions.mode', data: { mode: 'ask' } },
      { type: 'custom', customType: 'mortise.permissions.mode', data: { mode: 'allow-all' } },
    ], 'safe')
    await fixture.handlers.get('session_start')?.({ type: 'session_start' }, fixture.ctx)
    expect(fixture.published.find(item => item.channel === 'permission-mode')?.state).toEqual({ mode: 'allow-all' })
    expect(fixture.appended).toEqual([])
  })

  it('uses generic extension bootstrap before legacy core fields', async () => {
    const fixture = loadExtension()
    fixture.ctx.sessionManager.getHeader = () => ({
      spawnConfig: {
        extensionBootstrap: { 'mortise-permissions': { 'permission-mode': { mode: 'ask' } } },
        permissionMode: 'allow-all',
      },
    })
    await fixture.handlers.get('session_start')?.({ type: 'session_start' }, fixture.ctx)
    expect(fixture.published.find(item => item.channel === 'permission-mode')?.state).toEqual({ mode: 'ask' })
    expect(fixture.channels.get('permission-mode').sessionBootstrap).toBe(true)
  })

  it('persists mode changes sent by the extension frontend', async () => {
    const fixture = loadExtension()
    await fixture.handlers.get('session_start')?.({ type: 'session_start' }, fixture.ctx)
    await fixture.channels.get('permission-mode').onMessage({ mode: 'allow-all' }, fixture.ctx)
    expect(fixture.appended).toEqual([{ customType: 'mortise.permissions.mode', data: { mode: 'allow-all' } }])
    expect(fixture.published.at(-1)).toEqual({ channel: 'permission-mode', state: { mode: 'allow-all' } })
  })

  it('queues concurrent approvals and settles each request by id', async () => {
    const fixture = loadExtension([], undefined, 'ask')
    await fixture.handlers.get('session_start')?.({ type: 'session_start' }, fixture.ctx)
    const toolCall = fixture.handlers.get('tool_call')!
    const first = toolCall({ toolName: 'write', input: { path: 'one.txt' } }, fixture.ctx)
    const second = toolCall({ toolName: 'bash', input: { command: 'rm two.txt' } }, fixture.ctx)
    await Bun.sleep(0)

    expect(latestApproval(fixture)).toMatchObject({ queueLength: 2, request: { toolName: 'write' } })
    const firstId = latestApproval(fixture).request.requestId
    expect(await fixture.channels.get('permission-approval').onMessage({ type: 'respond', requestId: firstId, allowed: true }, fixture.ctx)).toEqual({ accepted: true })
    await expect(first).resolves.toBeUndefined()
    expect(latestApproval(fixture)).toMatchObject({ queueLength: 1, request: { toolName: 'bash' } })

    const secondId = latestApproval(fixture).request.requestId
    expect(await fixture.channels.get('permission-approval').onMessage({ type: 'respond', requestId: secondId, allowed: false }, fixture.ctx)).toEqual({ accepted: true })
    await expect(second).resolves.toEqual({ block: true, reason: 'Tool call denied or approval was cancelled.' })
    expect(latestApproval(fixture)).toEqual({ request: null, queueLength: 0 })
  })

  it('remembers always-allowed calls for the session and cancels all waiting calls on shutdown', async () => {
    const fixture = loadExtension([], undefined, 'ask')
    await fixture.handlers.get('session_start')?.({ type: 'session_start' }, fixture.ctx)
    const toolCall = fixture.handlers.get('tool_call')!
    const first = toolCall({ toolName: 'write', input: { path: 'same.txt' } }, fixture.ctx)
    await Bun.sleep(0)
    const requestId = latestApproval(fixture).request.requestId
    await fixture.channels.get('permission-approval').onMessage({ type: 'respond', requestId, allowed: true, alwaysAllow: true }, fixture.ctx)
    await expect(first).resolves.toBeUndefined()
    await expect(toolCall({ toolName: 'write', input: { path: 'same.txt' } }, fixture.ctx)).resolves.toBeUndefined()

    const pending = toolCall({ toolName: 'edit', input: { path: 'other.txt' } }, fixture.ctx)
    await Bun.sleep(0)
    await fixture.handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, fixture.ctx)
    await expect(pending).resolves.toEqual({ block: true, reason: 'Tool call denied or approval was cancelled.' })
  })

  it('fails closed when the host cannot mount extension frontends', async () => {
    const fixture = loadExtension([], undefined, 'ask')
    await fixture.handlers.get('session_start')?.({ type: 'session_start' }, fixture.ctx)
    const headless = { ...fixture.ctx, ui: { ...fixture.ctx.ui, capabilities: { dialogs: false, contributions: false } } }
    expect(await fixture.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'rm file' } }, headless)).toEqual({
      block: true,
      reason: 'Tool approval requires an interactive Mortise client.',
    })
  })
})
