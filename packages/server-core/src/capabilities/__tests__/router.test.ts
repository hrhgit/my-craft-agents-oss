import { describe, expect, it, mock } from 'bun:test'
import { CapabilityRouter } from '../router.ts'
import { createSystemNotificationProvider } from '../providers/system-notification.ts'
import { createFilePreviewProvider, createFilesProvider, FILE_PREVIEW_MAX_BYTES } from '../providers/files.ts'
import { createBrowserCommandProvider, createBrowserControlProvider, createBrowserProvider } from '../providers/browser.ts'
import { createKeychainCapabilityProvider, createOAuthCapabilityProvider } from '../providers/oauth.ts'
import type { CapabilityRequestV1 } from '../types.ts'

function request(overrides: Partial<CapabilityRequestV1> = {}): CapabilityRequestV1 {
  return {
    version: 1,
    requestId: 'req-1',
    capability: 'test.echo',
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    extensionId: 'extension-1',
    operation: 'run',
    input: { value: 'hello' },
    ...overrides,
  }
}

describe('CapabilityRouter', () => {
  it('denies undeclared operations before authorization', async () => {
    const authorize = mock(() => ({ allowed: true as const }))
    const invoke = mock(async () => 'ok')
    const router = new CapabilityRouter({ requireDeclarations: true, authorize })
    router.register({ capability: 'test.echo', invoke })

    expect(await router.invoke(request())).toMatchObject({
      status: 'denied', error: { code: 'CAPABILITY_NOT_DECLARED' },
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('allows an explicitly declared operation and still applies policy', async () => {
    const authorize = mock(() => ({ allowed: true as const }))
    const router = new CapabilityRouter({ requireDeclarations: true, authorize })
    router.register({ capability: 'test.echo', invoke: async () => 'ok' })
    router.declare({
      version: 1, sessionId: 'session-1', runtimeId: 'runtime-1', extensionId: 'extension-1',
      declarations: [{ capability: 'test.echo', operations: ['run'] }],
    })

    expect(await router.invoke(request())).toMatchObject({ status: 'success', output: 'ok' })
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('clears declarations when a runtime is released', async () => {
    const router = new CapabilityRouter({ requireDeclarations: true })
    router.register({ capability: 'test.echo', invoke: async () => 'ok' })
    router.declare({
      version: 1, sessionId: 'session-1', runtimeId: 'runtime-1', extensionId: 'extension-1',
      declarations: [{ capability: 'test.echo', operations: ['run'] }],
    })
    expect(await router.invoke(request())).toMatchObject({ status: 'success' })
    router.releaseRuntime('runtime-1')

    expect(await router.invoke(request())).toMatchObject({
      status: 'denied', error: { code: 'CAPABILITY_NOT_DECLARED' },
    })
  })

  it('binds declarations to the Host session', async () => {
    const router = new CapabilityRouter({ requireDeclarations: true })
    router.register({ capability: 'test.echo', invoke: async () => 'ok' })
    router.declare({
      version: 1, sessionId: 'session-1', runtimeId: 'runtime-1', extensionId: 'extension-1',
      declarations: [{ capability: 'test.echo', operations: ['run'] }],
    })

    expect(await router.invoke(request({ requestId: 'other-session', sessionId: 'session-2' }))).toMatchObject({
      status: 'denied', error: { code: 'CAPABILITY_NOT_DECLARED' },
    })
  })

  it('validates requests and returns unsupported for an absent provider', async () => {
    const router = new CapabilityRouter()
    expect(await router.invoke(request({ version: 2 as 1 }))).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } })
    expect(await router.invoke(request())).toMatchObject({ status: 'unsupported', error: { code: 'UNSUPPORTED_CAPABILITY' } })
  })

  it('authorizes, reports progress, and audits without including input', async () => {
    const audit = mock(() => {})
    const onProgress = mock(() => {})
    const router = new CapabilityRouter({ audit, onProgress })
    router.register({
      capability: 'test.echo',
      async invoke(_operation, input, context) {
        context.reportProgress({ step: 1 })
        return input
      },
    })
    expect(await router.invoke(request())).toMatchObject({ status: 'success', output: { value: 'hello' } })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1', sequence: 1 }))
    expect(audit).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(audit.mock.calls)).not.toContain('hello')
  })

  it('returns denied without invoking the provider', async () => {
    const invoke = mock(async () => 'no')
    const router = new CapabilityRouter({ authorize: () => ({ allowed: false, reason: 'blocked' }) })
    router.register({ capability: 'test.echo', invoke })
    expect(await router.invoke(request())).toMatchObject({ status: 'denied', error: { message: 'blocked' } })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('deduplicates pending and completed request ids', async () => {
    let resolve!: (value: { ok: true }) => void
    const gate = new Promise<{ ok: true }>((done) => { resolve = done })
    const invoke = mock(() => gate)
    const router = new CapabilityRouter()
    router.register({ capability: 'test.echo', invoke })
    const firstPending = router.invoke(request())
    const secondPending = router.invoke(request())
    expect(await router.invoke(request({ input: { value: 'different' } })))
      .toMatchObject({ status: 'failed', error: { code: 'REQUEST_ID_CONFLICT' } })
    resolve({ ok: true })
    const [first, second] = await Promise.all([firstPending, secondPending])
    const third = await router.invoke(request())
    expect(first).toEqual(second)
    expect(third).toEqual(first)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await router.invoke(request({ input: { value: 'different' } })))
      .toMatchObject({ status: 'failed', error: { code: 'REQUEST_ID_CONFLICT' } })
  })

  it('supports explicit cancellation, timeout, and runtime cleanup', async () => {
    const router = new CapabilityRouter({ defaultTimeoutMs: 5 })
    router.register({ capability: 'test.echo', invoke: () => new Promise(() => {}) })

    const cancelled = router.invoke(request({ requestId: 'cancel-me' }))
    expect(router.cancel('cancel-me', 'other-runtime')).toBe(false)
    expect(router.cancel('cancel-me')).toBe(true)
    expect(await cancelled).toMatchObject({ status: 'cancelled', error: { code: 'CAPABILITY_CANCELLED' } })

    expect(await router.invoke(request({ requestId: 'timeout' }))).toMatchObject({ status: 'cancelled', error: { code: 'CAPABILITY_TIMEOUT' } })

    const released = router.invoke(request({ requestId: 'release-me', runtimeId: 'gone' }))
    expect(router.releaseRuntime('gone')).toBe(1)
    expect(await released).toMatchObject({ status: 'cancelled', error: { code: 'CAPABILITY_CANCELLED' } })
  })
})

describe('system.notification provider', () => {
  it('validates and delegates show to the host adapter', async () => {
    const show = mock(async () => {})
    const router = new CapabilityRouter()
    router.register(createSystemNotificationProvider(show))
    const result = await router.invoke(request({
      capability: 'system.notification',
      operation: 'show',
      input: { title: 'Done', body: 'Task complete' },
    }))
    expect(result).toMatchObject({ status: 'success', output: { shown: true } })
    expect(show).toHaveBeenCalledWith({ title: 'Done', body: 'Task complete' }, { sessionId: 'session-1' })
  })

  it('returns a provider error for invalid notification input', async () => {
    const router = new CapabilityRouter()
    router.register(createSystemNotificationProvider(() => {}))
    expect(await router.invoke(request({ capability: 'system.notification', operation: 'show', input: {} })))
      .toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } })
  })
})

describe('desktop capability providers', () => {
  it('validates and delegates file picking', async () => {
    const pick = mock(async () => ({ cancelled: false, paths: ['C:/file.txt'] }))
    const router = new CapabilityRouter()
    router.register(createFilesProvider(pick))
    const result = await router.invoke(request({
      capability: 'files.pick', operation: 'open', input: { mode: 'file', extensions: ['txt'] },
    }))
    expect(result).toMatchObject({ status: 'success', output: { paths: ['C:/file.txt'] } })
    expect(pick).toHaveBeenCalledWith({ mode: 'file', extensions: ['txt'] })
  })

  it('bounds and delegates workspace file previews without exposing host paths', async () => {
    const read = mock(async () => ({ mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,b2s=' }))
    const router = new CapabilityRouter()
    router.register(createFilePreviewProvider(read))
    const result = await router.invoke(request({
      requestId: 'preview', capability: 'files.preview', operation: 'read',
      input: { path: 'C:/workspace/readme.txt', maxBytes: FILE_PREVIEW_MAX_BYTES * 4 },
    }))
    expect(result).toMatchObject({ status: 'success', output: { mimeType: 'text/plain', size: 2 } })
    expect(read).toHaveBeenCalledWith(
      { path: 'C:/workspace/readme.txt', maxBytes: FILE_PREVIEW_MAX_BYTES },
      { sessionId: 'session-1' },
    )
    expect(JSON.stringify(result)).not.toContain('C:/workspace/readme.txt')
  })

  it('rejects malformed file preview requests', async () => {
    const router = new CapabilityRouter()
    router.register(createFilePreviewProvider(async () => ({ mimeType: '', size: 0, dataUrl: '' })))
    expect(await router.invoke(request({ capability: 'files.preview', operation: 'read', input: { path: '', maxBytes: -1 } })))
      .toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } })
  })

  it('validates browser URLs and binds routing identity', async () => {
    const open = mock(async () => ({ instanceId: 'browser-1', url: 'https://example.com/', title: 'Example' }))
    const router = new CapabilityRouter()
    router.register(createBrowserProvider(open))
    expect(await router.invoke(request({ capability: 'browser.open', operation: 'navigate', input: { url: 'file:///secret' } })))
      .toMatchObject({ status: 'failed' })
    const result = await router.invoke(request({ requestId: 'browser-ok', capability: 'browser.open', operation: 'navigate', input: { url: 'https://example.com' } }))
    expect(result.status).toBe('success')
    expect(open).toHaveBeenCalledWith({ url: 'https://example.com/', focus: undefined }, { sessionId: 'session-1', workspaceId: undefined })
  })

  it('only delegates bounded browser control operations with session identity', async () => {
    const control = mock(async () => {})
    const router = new CapabilityRouter()
    router.register(createBrowserControlProvider(control))
    const result = await router.invoke(request({
      requestId: 'browser-control', capability: 'browser.control', operation: 'close',
      input: { instanceId: 'browser-1' },
    }))
    expect(result).toMatchObject({ status: 'success', output: { completed: true } })
    expect(control).toHaveBeenCalledWith('close', { instanceId: 'browser-1' }, { sessionId: 'session-1' })
    expect(await router.invoke(request({
      requestId: 'browser-evaluate', capability: 'browser.control', operation: 'evaluate',
      input: { instanceId: 'browser-1' },
    }))).toMatchObject({ status: 'failed' })
  })

  it('executes browser commands through the adapter resolved for the Host session', async () => {
    const resolve = mock((route: { sessionId: string }) => route.sessionId === 'session-1' ? ({} as never) : undefined)
    const router = new CapabilityRouter()
    router.register(createBrowserCommandProvider(resolve))
    const result = await router.invoke(request({
      requestId: 'browser-command', capability: 'browser.command', operation: 'execute', input: { command: '--help' },
    }))
    expect(result).toMatchObject({ status: 'success', output: { text: expect.stringContaining('browser_tool command help') } })
    expect(resolve).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(await router.invoke(request({
      requestId: 'browser-command-other', sessionId: 'session-2', capability: 'browser.command', operation: 'execute', input: { command: '--help' },
    }))).toMatchObject({ status: 'failed' })
  })
})

describe('OAuth and keychain capability providers', () => {
  it('exposes only a host-managed OAuth flow reference and binds session identity', async () => {
    const begin = mock(async (input: { sourceSlug: string; sessionId: string }) => ({ flowId: 'flow-1', status: 'pending' as const, userAction: 'open_authorization' as const }))
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }) })
    router.register(createOAuthCapabilityProvider({
      begin,
      status: async ({ flowId }) => ({ flowId, status: 'completed' as const, accountLabel: 'user@example.test' }),
      cancel: async ({ flowId }) => ({ flowId, status: 'cancelled' as const }),
      revoke: async ({ sourceSlug }) => ({ sourceSlug, revoked: true }),
    }))
    const result = await router.invoke(request({ capability: 'oauth.flow', operation: 'begin', input: { sourceSlug: 'github' } }))
    expect(result).toMatchObject({ status: 'success', output: { flowId: 'flow-1', status: 'pending' } })
    expect(JSON.stringify(result)).not.toContain('authUrl')
    expect(begin).toHaveBeenCalledWith({ sourceSlug: 'github', sessionId: 'session-1' }, expect.any(AbortSignal))
  })

  it('rejects malformed OAuth input and never accepts codes or tokens', async () => {
    const audit = mock(() => {})
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }), audit })
    router.register(createOAuthCapabilityProvider({
      begin: async () => ({ flowId: 'flow', status: 'pending' }),
      status: async ({ flowId }) => ({ flowId, status: 'pending' }),
      cancel: async ({ flowId }) => ({ flowId, status: 'cancelled' }),
      revoke: async ({ sourceSlug }) => ({ sourceSlug, revoked: true }),
    }))
    expect(await router.invoke(request({ capability: 'oauth.flow', operation: 'begin', input: { sourceSlug: '' } }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke(request({ requestId: 'code', capability: 'oauth.flow', operation: 'complete', input: { code: 'secret' } }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke(request({ requestId: 'token', capability: 'oauth.flow', operation: 'begin', input: { sourceSlug: 'github', accessToken: 'secret-token' } }))).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-token')
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret')
  })

  it('keeps keychain operations secret-free and routes session identity to the Host', async () => {
    const has = mock(async (id: { type: string }, sessionId: string) => ({ present: id.type === 'source_oauth' && sessionId === 'session-1' }))
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }) })
    router.register(createKeychainCapabilityProvider({
      has,
      remove: async () => ({ removed: true }),
    }))
    const result = await router.invoke(request({ capability: 'credentials.keychain', operation: 'has', input: { type: 'source_oauth' } }))
    expect(result).toEqual({ requestId: 'req-1', status: 'success', output: { present: true } })
    expect(has).toHaveBeenCalledWith({ type: 'source_oauth' }, 'session-1')
    expect(await router.invoke(request({ requestId: 'secret', capability: 'credentials.keychain', operation: 'has', input: { type: 'source_oauth', value: 'do-not-forward' } })))
      .toMatchObject({ status: 'failed' })
  })

  it('whitelists sensitive provider outputs at runtime', async () => {
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }) })
    router.register(createOAuthCapabilityProvider({
      begin: async () => ({ flowId: 'flow-1', status: 'pending', accessToken: 'leak' } as never),
      status: async ({ flowId }) => ({ flowId, status: 'completed', accountLabel: 'user', refreshToken: 'leak' } as never),
      cancel: async ({ flowId }) => ({ flowId, status: 'cancelled', code: 'leak' } as never),
      revoke: async ({ sourceSlug }) => ({ sourceSlug, revoked: true, credential: 'leak' } as never),
    }))
    const begin = await router.invoke(request({ capability: 'oauth.flow', operation: 'begin', input: { sourceSlug: 'github' } }))
    const status = await router.invoke(request({ requestId: 'status', capability: 'oauth.flow', operation: 'status', input: { flowId: 'flow-1' } }))
    expect(JSON.stringify([begin, status])).not.toContain('leak')
  })
})
