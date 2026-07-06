import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerFilesHandlers } from './files'

const FILES_MODULE = pathToFileURL(join(import.meta.dir, 'files.ts')).href

function createTestHarness(options?: { withWindowManager?: boolean }) {
  const handlers = new Map<string, HandlerFn>()
  const warnings: unknown[][] = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: (...args: unknown[]) => {
          warnings.push(args)
        },
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }
  if (options?.withWindowManager !== false) {
    deps.windowManager = {
      getWorkspaceForWindow: () => 'ws-1',
      updateWindowWorkspace: () => true,
      getWindowByWebContentsId: () => null,
      registerWindow: () => {},
      getAllWindowsForWorkspace: () => [],
    }
  }

  registerFilesHandlers(server, deps)

  const readUserAttachment = handlers.get(RPC_CHANNELS.file.READ_USER_ATTACHMENT)
  if (!readUserAttachment) {
    throw new Error('READ_USER_ATTACHMENT handler not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'ws-1',
    webContentsId: 101,
  }

  return { readUserAttachment, ctx, warnings }
}

describe('registerFilesHandlers READ_USER_ATTACHMENT', () => {
  it('rejects requests without a trusted local Electron window', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-user-attachment-'))
    try {
      const filePath = join(tmp, 'notes.txt')
      await writeFile(filePath, 'hello')

      const { readUserAttachment, ctx, warnings } = createTestHarness({ withWindowManager: false })

      await expect(readUserAttachment(ctx, filePath)).resolves.toBeNull()
      expect(warnings.some((args) => String(args[0]).includes('rejected non-local'))).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('blocks symlink aliases whose real target is a sensitive path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-user-attachment-'))
    try {
      const sshDir = join(tmp, '.ssh')
      await mkdir(sshDir)
      const sensitiveTarget = join(sshDir, 'id_rsa')
      const symlinkAlias = join(tmp, 'notes.txt')
      await writeFile(sensitiveTarget, 'private-key')

      try {
        await symlink(sensitiveTarget, symlinkAlias, 'file')
      } catch {
        return
      }

      const { readUserAttachment, ctx, warnings } = createTestHarness()

      await expect(readUserAttachment(ctx, symlinkAlias)).resolves.toBeNull()
      expect(warnings.some((args) => String(args[0]).includes('.ssh'))).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('registerFilesHandlers READ', () => {
  it('rejects home-directory reads from remote clients without a trusted local window', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-read-remote-'))
    try {
      const configDir = join(tmp, 'config')
      const piAgentDir = join(tmp, 'pi-agent')
      const workspaceRoot = join(tmp, 'workspace')
      await mkdir(configDir, { recursive: true })
      await mkdir(piAgentDir, { recursive: true })
      await mkdir(workspaceRoot, { recursive: true })
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({
          workspaces: [{ id: 'ws-1', name: 'Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
          activeWorkspaceId: 'ws-1',
          activeSessionId: null,
        }, null, 2),
        'utf-8',
      )

      const script = `
        import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
        import { registerFilesHandlers } from ${JSON.stringify(FILES_MODULE)}

        const handlers = new Map()
        const server = {
          handle(channel, handler) { handlers.set(channel, handler) },
          push() {},
          async invokeClient() { return undefined },
          hasClientCapability() { return false },
          findClientsWithCapability() { return [] },
        }
        const deps = {
          sessionManager: {},
          oauthFlowStore: {},
          platform: {
            appRootPath: '/',
            resourcesPath: '/',
            isPackaged: false,
            appVersion: '0.0.0-test',
            isDebugMode: true,
            logger: {
              info() {},
              warn() {},
              error() {},
              debug() {},
            },
            imageProcessor: {
              async getMetadata() { return null },
              async process() { return Buffer.from('') },
            },
          },
        }

        registerFilesHandlers(server, deps)
        const readFile = handlers.get(RPC_CHANNELS.file.READ)
        if (!readFile) {
          console.error('READ handler not registered')
          process.exit(1)
        }

        try {
          await readFile(
            { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: null },
            process.env.TEST_HOME_PATH,
          )
          console.error('Expected home path rejection')
          process.exit(1)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('Access denied')) {
            console.error(message)
            process.exit(1)
          }
        }
      `
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
          PI_CODING_AGENT_DIR: piAgentDir,
          TEST_HOME_PATH: join(homedir(), 'craft-agent-home-read-regression.txt'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, `${run.stdout.toString()}\n${run.stderr.toString()}`).toBe(0)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 15000)
})

describe('registerFilesHandlers STORE_ATTACHMENT', () => {
  it('rejects path-only attachments without a trusted local Electron window', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-store-attachment-'))
    try {
      const configDir = join(tmp, 'config')
      const piAgentDir = join(tmp, 'pi-agent')
      const workspaceRoot = join(tmp, 'workspace')
      await mkdir(configDir, { recursive: true })
      await mkdir(piAgentDir, { recursive: true })
      await mkdir(workspaceRoot, { recursive: true })
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({
          workspaces: [{ id: 'ws-1', name: 'Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
          activeWorkspaceId: 'ws-1',
          activeSessionId: null,
        }, null, 2),
        'utf-8',
      )

      const filePath = join(tmp, 'notes.txt')
      await writeFile(filePath, 'hello')

      const script = `
        import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
        import { registerFilesHandlers } from ${JSON.stringify(FILES_MODULE)}

        const handlers = new Map()
        const server = {
          handle(channel, handler) { handlers.set(channel, handler) },
          push() {},
          async invokeClient() { return undefined },
          hasClientCapability() { return false },
          findClientsWithCapability() { return [] },
        }
        const deps = {
          sessionManager: {},
          oauthFlowStore: {},
          platform: {
            appRootPath: '/',
            resourcesPath: '/',
            isPackaged: false,
            appVersion: '0.0.0-test',
            isDebugMode: true,
            logger: {
              info() {},
              warn() {},
              error() {},
              debug() {},
            },
            imageProcessor: {
              async getMetadata() { return null },
              async process() { return Buffer.from('') },
            },
          },
        }

        registerFilesHandlers(server, deps)
        const storeAttachment = handlers.get(RPC_CHANNELS.file.STORE_ATTACHMENT)
        if (!storeAttachment) {
          console.error('STORE_ATTACHMENT handler not registered')
          process.exit(1)
        }

        const attachment = {
          type: 'text',
          path: process.env.TEST_ATTACHMENT_PATH,
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
        }

        try {
          await storeAttachment(
            { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 101 },
            'session-1',
            attachment,
          )
          console.error('Expected path-only attachment rejection')
          process.exit(1)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('Path-only attachments are only accepted')) {
            console.error(message)
            process.exit(1)
          }
        }
      `
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
          PI_CODING_AGENT_DIR: piAgentDir,
          TEST_ATTACHMENT_PATH: filePath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, `${run.stdout.toString()}\n${run.stderr.toString()}`).toBe(0)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 15000)
})
