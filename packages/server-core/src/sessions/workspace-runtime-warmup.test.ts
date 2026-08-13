import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import type { AgentBackend } from '@mortise/shared/agent/backend'
import type { CoreBackendConfig } from '@mortise/shared/agent/backend'
import { SessionManager } from './SessionManager'

function createWorkspace(rootPath: string): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-warmup',
    revision: 1,
    name: 'Warmup Workspace',
    nameSource: 'custom',
    slug: 'warmup-workspace',
    primaryLocationId: 'primary',
    locations: [{
      id: 'primary',
      name: 'Primary',
      rootName: 'workspace',
      endpoint: { kind: 'local', rootPath },
    }],
    createdAt: Date.now(),
  }
}

function extensionRuntimeStub() {
  return {
    backendType: 'electron',
    clear: () => undefined,
    getGlobalSnapshot: () => null,
    getWorkspaceSnapshot: () => null,
  } as never
}

describe('SessionManager Workspace runtime warmup', () => {
  it('single-flights preparation and keeps the warm runtime alive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-warmup-'))
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const prepareRuntime = mock(async () => blocked)
    const disposeForRestart = mock(async () => undefined)
    const factory = mock(() => ({
      postInit: async () => ({ authInjected: true }),
      prepareRuntime,
      disposeForRestart,
    } as unknown as AgentBackend))
    const manager = new SessionManager({
      extensionRuntime: extensionRuntimeStub(),
      createWorkspaceRuntimeBackend: factory,
    })
    const workspace = createWorkspace(root)
    const internals = manager as unknown as {
      ensureWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
      disposeWorkspaceRuntimeWarmup: (workspaceId: string, reason: string) => Promise<void>
    }

    try {
      const first = internals.ensureWorkspaceRuntimeWarmup(workspace)
      const second = internals.ensureWorkspaceRuntimeWarmup(workspace)
      expect(factory).toHaveBeenCalledTimes(1)
      await Bun.sleep(0)
      expect(prepareRuntime).toHaveBeenCalledTimes(1)
      expect(manager.getExtensionRuntimeState(workspace.id).preparationStatus).toBe('warming')

      release()
      await Promise.all([first, second])
      expect(manager.getExtensionRuntimeState(workspace.id).preparationStatus).toBe('ready')

      await internals.disposeWorkspaceRuntimeWarmup(workspace.id, 'test')
      expect(disposeForRestart).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('isolates a preparation failure and does not retry until reload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-warmup-failure-'))
    const destroy = mock(() => undefined)
    const factory = mock(() => ({
      postInit: async () => ({ authInjected: true }),
      prepareRuntime: async () => { throw new Error('optional resource failed') },
      destroy,
    } as unknown as AgentBackend))
    const manager = new SessionManager({
      extensionRuntime: extensionRuntimeStub(),
      createWorkspaceRuntimeBackend: factory,
    })
    const workspace = createWorkspace(root)
    const internals = manager as unknown as {
      ensureWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
      waitForWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
    }

    try {
      await expect(internals.ensureWorkspaceRuntimeWarmup(workspace)).resolves.toBeUndefined()
      await expect(internals.waitForWorkspaceRuntimeWarmup(workspace)).resolves.toBeUndefined()
      await internals.ensureWorkspaceRuntimeWarmup(workspace)

      expect(factory).toHaveBeenCalledTimes(1)
      expect(destroy).toHaveBeenCalledTimes(1)
      expect(manager.getExtensionRuntimeState(workspace.id)).toMatchObject({
        preparationStatus: 'degraded',
        preparationError: 'optional resource failed',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts this host process Workspace warmup when the send path arrives first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-warmup-send-first-'))
    const prepareRuntime = mock(async () => undefined)
    const factory = mock(() => ({
      postInit: async () => ({ authInjected: true }),
      prepareRuntime,
      destroy: () => undefined,
    } as unknown as AgentBackend))
    const manager = new SessionManager({
      extensionRuntime: extensionRuntimeStub(),
      createWorkspaceRuntimeBackend: factory,
    })
    const workspace = createWorkspace(root)
    const internals = manager as unknown as {
      waitForWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
    }

    try {
      await internals.waitForWorkspaceRuntimeWarmup(workspace)

      expect(factory).toHaveBeenCalledTimes(1)
      expect(prepareRuntime).toHaveBeenCalledTimes(1)
      expect(manager.getExtensionRuntimeState(workspace.id).preparationStatus).toBe('ready')
    } finally {
      await manager.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades instead of rejecting when Workspace resolution fails before backend creation', async () => {
    const workspace = createWorkspace(process.cwd())
    workspace.locations[0] = {
      ...workspace.locations[0],
      endpoint: {
        kind: 'remote',
        url: 'https://example.invalid',
        remoteWorkspaceId: 'remote-workspace',
        credentialRef: 'test-credential',
      },
    }
    const factory = mock(() => ({}) as AgentBackend)
    const manager = new SessionManager({
      extensionRuntime: extensionRuntimeStub(),
      createWorkspaceRuntimeBackend: factory,
    })
    const internals = manager as unknown as {
      ensureWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
      waitForWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
    }

    await expect(internals.ensureWorkspaceRuntimeWarmup(workspace)).resolves.toBeUndefined()
    await expect(internals.waitForWorkspaceRuntimeWarmup(workspace)).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    expect(manager.getExtensionRuntimeState(workspace.id)).toMatchObject({
      preparationStatus: 'degraded',
      preparationError: 'Workspace location primary is remote and has no local root',
    })
  })

  it('waits for preparation before reloading the warm runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-warmup-reload-'))
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const reloadExtensions = mock(async () => ({ reloaded: true, deferred: false }))
    const manager = new SessionManager({
      extensionRuntime: extensionRuntimeStub(),
      createWorkspaceRuntimeBackend: () => ({
        postInit: async () => ({ authInjected: true }),
        prepareRuntime: async () => blocked,
        reloadExtensions,
      } as unknown as AgentBackend),
    })
    const workspace = createWorkspace(root)
    const internals = manager as unknown as {
      ensureWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
    }

    try {
      const warmup = internals.ensureWorkspaceRuntimeWarmup(workspace)
      await Bun.sleep(0)
      const reload = manager.requestExtensionReload(false)
      await Bun.sleep(0)
      expect(reloadExtensions).not.toHaveBeenCalled()

      release()
      await Promise.all([warmup, reload])
      expect(reloadExtensions).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('routes bootstrap frontend state and messages through the Workspace warm runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-warmup-frontend-'))
    const workspace = createWorkspace(root)
    let coreConfig: CoreBackendConfig | undefined
    const sendExtensionFrontendMessage = mock(async () => ({ accepted: true }))
    const manager = new SessionManager({
      resolveWorkspaceByNameOrId: value => value === workspace.id ? workspace : null,
      extensionRuntime: extensionRuntimeStub(),
      createWorkspaceRuntimeBackend: args => {
        coreConfig = args.coreConfig
        return {
          postInit: async () => ({ authInjected: true }),
          prepareRuntime: async () => undefined,
          sendExtensionFrontendMessage,
        } as unknown as AgentBackend
      },
    })
    const internals = manager as unknown as {
      ensureWorkspaceRuntimeWarmup: (workspace: Workspace) => Promise<void>
    }

    try {
      await internals.ensureWorkspaceRuntimeWarmup(workspace)
      coreConfig?.onExtensionEvent?.({
        type: 'extension_frontend_state',
        extensionId: 'mortise-permissions',
        runtimeId: 'warm-runtime',
        sessionId: '',
        workspaceId: workspace.id,
        state: {
          schemaVersion: 2,
          channelId: 'permission-mode',
          scope: 'session',
          revision: 1,
          state: { mode: 'ask' },
          sessionBootstrap: true,
        },
      })

      expect(manager.getExtensionFrontendStates('', workspace.id)).toEqual([
        expect.objectContaining({
          extensionId: 'mortise-permissions',
          sessionId: '',
          workspaceId: workspace.id,
        }),
      ])
      await expect(manager.sendExtensionFrontendMessage(
        '',
        'mortise-permissions',
        'permission-mode',
        { type: 'set-mode', mode: 'allow-all' },
        workspace.id,
      )).resolves.toEqual({ accepted: true })
      expect(sendExtensionFrontendMessage).toHaveBeenCalledWith(
        'mortise-permissions',
        'permission-mode',
        { type: 'set-mode', mode: 'allow-all' },
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
