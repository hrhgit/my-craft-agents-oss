import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  appendStoredMessagesViaPiSessionManager,
  ensureSharedPiTreeSessionFile,
  getSessionPath,
  setSharedPiSessionsDirForTests,
  writeTreeSessionCraftMetadata,
  type StoredMessage,
  type StoredSession,
} from '@mortise/shared/sessions'
import type { MortiseUiMountedExtension, MortiseUiProfileMode } from './protocol.ts'
import { mountMortiseUiExtensions } from './extension-mount.ts'
import {
  DEFAULT_MORTISE_UI_FIXTURE,
  summarizeMortiseUiFixture,
  validateMortiseUiFixtureSpec,
  type MortiseUiFixtureFile,
  type MortiseUiFixtureSpec,
  type MortiseUiFixtureSummary,
} from './fixture.ts'

const EXCLUDED_NAMES = new Set([
  '.server.lock', '.workspace-server.lock', 'logs', 'node_modules', 'cache', 'Cache',
  'Code Cache', 'GPUCache', 'Crashpad', 'window-state.json',
])

const FIXTURE_CREATED_AT = Date.UTC(2026, 0, 1)

function copyProfileTree(source: string, target: string): void {
  if (!existsSync(source)) return
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
    filter(path) {
      if (path === source) return true
      if (EXCLUDED_NAMES.has(path.split(/[\\/]/).at(-1) ?? '')) return false
      // Never traverse links while cloning a profile: their targets may escape
      // the explicitly selected source directory or pull in large caches.
      try { return !lstatSync(path).isSymbolicLink() } catch { return false }
    },
  })
}

export interface PreparedMortiseUiProfile {
  root: string
  mortiseConfigDir: string
  piAgentDir: string
  electronUserDataDir: string
  mode: MortiseUiProfileMode
  containsClonedUserData: boolean
  fixture?: MortiseUiFixtureSummary
  mountedExtensions?: MortiseUiMountedExtension[]
}

function redirectClonedWorkspaceRoots(mortiseConfigDir: string, profileRoot: string): void {
  const configPath = join(mortiseConfigDir, 'config.json')
  if (!existsSync(configPath)) return
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { workspaces?: Array<Record<string, unknown>> }
  if (!Array.isArray(config.workspaces)) return
  const cloneRoot = join(profileRoot, 'workspace-clones')
  mkdirSync(cloneRoot, { recursive: true })
  config.workspaces = config.workspaces.map((workspace, index) => {
    const identity = typeof workspace.id === 'string' && /^[A-Za-z0-9._-]+$/.test(workspace.id)
      ? workspace.id
      : `workspace-${index + 1}`
    const rootPath = join(cloneRoot, identity)
    mkdirSync(rootPath, { recursive: true })
    return { ...workspace, rootPath }
  })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeFixtureFile(basePath: string, file: MortiseUiFixtureFile): void {
  const filePath = join(basePath, ...file.path.split('/'))
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, file.content, 'utf8')
}

function seedFixtureProfile(root: string, mortiseConfigDir: string, piAgentDir: string, input?: MortiseUiFixtureSpec): MortiseUiFixtureSummary {
  const spec = validateMortiseUiFixtureSpec(input ?? DEFAULT_MORTISE_UI_FIXTURE)
  const fixtureRoot = join(root, 'workspaces')
  const workspaces = spec.workspaces.map((workspace, index) => ({
    ...workspace,
    slug: workspace.slug ?? workspace.id,
    rootPath: join(fixtureRoot, `${String(index + 1).padStart(2, '0')}-${workspace.slug ?? workspace.id}`),
  }))

  for (const workspace of workspaces) {
    mkdirSync(join(workspace.rootPath, 'sources'), { recursive: true })
    writeJson(join(workspace.rootPath, 'config.json'), {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      defaults: {
        enabledSourceSlugs: [],
        permissionMode: workspace.permissionMode ?? 'safe',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
      },
      localMcpServers: { enabled: false },
      createdAt: FIXTURE_CREATED_AT,
      updatedAt: FIXTURE_CREATED_AT,
    })
    for (const file of workspace.files ?? []) writeFixtureFile(workspace.rootPath, file)
  }

  setSharedPiSessionsDirForTests(join(piAgentDir, 'sessions'))
  try {
    const sessionFiles = new Map<string, string>()
    const fixtureSessions: Array<{ id: string; parentSessionId?: string; sessionFile: string }> = []
    workspaces.forEach((workspace, workspaceIndex) => {
      ;(workspace.sessions ?? []).forEach((session, sessionIndex) => {
        const createdAt = session.createdAt ?? FIXTURE_CREATED_AT + workspaceIndex * 86_400_000 + sessionIndex * 60_000
        const messages = (session.messages ?? []).map((message, messageIndex): StoredMessage => ({
          id: message.id ?? `m-${workspaceIndex + 1}-${sessionIndex + 1}-${messageIndex + 1}`,
          type: message.role,
          content: message.content,
          timestamp: message.timestamp ?? createdAt + (messageIndex + 1) * 1_000,
          toolName: message.toolName,
          toolUseId: message.toolUseId,
          toolInput: message.toolInput,
          toolResult: message.toolResult,
          toolStatus: message.toolStatus,
          isError: message.isError,
        }))
        const storedSession: StoredSession = {
          mortiseId: session.id,
          workspaceRootPath: workspace.rootPath,
          name: session.name,
          createdAt,
          lastUsedAt: session.lastUsedAt ?? messages.at(-1)?.timestamp ?? createdAt,
          lastMessageAt: messages.at(-1)?.timestamp,
          workingDirectory: workspace.rootPath,
          sdkCwd: workspace.rootPath,
          permissionMode: session.permissionMode ?? workspace.permissionMode ?? 'safe',
          hasUnread: session.hasUnread,
          hidden: session.hidden,
          messages,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
        }
        const sessionFile = ensureSharedPiTreeSessionFile(storedSession)
        sessionFiles.set(session.id, sessionFile)
        fixtureSessions.push({ id: session.id, parentSessionId: session.parentSessionId, sessionFile })
        const idMap = appendStoredMessagesViaPiSessionManager(sessionFile, dirname(sessionFile), workspace.rootPath, messages)
        if (idMap.size > 0) {
          writeTreeSessionCraftMetadata(sessionFile, {
            ...storedSession,
            messages: messages.map(message => ({ ...message, id: idMap.get(message.id) ?? message.id })),
          })
        }
        for (const file of session.files ?? []) writeFixtureFile(getSessionPath(workspace.rootPath, session.id), file)
      })
    })
    for (const child of fixtureSessions) {
      if (!child.parentSessionId) continue
      const parentFile = sessionFiles.get(child.parentSessionId)
      if (!parentFile) throw new Error(`Fixture child session ${child.id} references missing parent ${child.parentSessionId}`)
      linkFixtureChildSession(child.sessionFile, parentFile)
    }
  } finally {
    setSharedPiSessionsDirForTests(undefined)
  }

  writeJson(join(mortiseConfigDir, 'config.json'), {
    workspaces: workspaces.map(workspace => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      rootPath: workspace.rootPath,
      createdAt: FIXTURE_CREATED_AT,
    })),
    activeWorkspaceId: spec.active?.workspaceId ?? workspaces[0]!.id,
    activeSessionId: spec.active?.sessionId ?? null,
    setupDeferred: true,
    notificationsEnabled: false,
    colorTheme: 'default',
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    browserToolEnabled: true,
    dataSourcesEnabled: true,
  })
  writeJson(join(mortiseConfigDir, 'preferences.json'), {
    name: 'Mortise UI Tester',
    timezone: 'UTC',
    notes: 'Disposable profile generated by mortise-ui.',
    updatedAt: FIXTURE_CREATED_AT,
  })
  return summarizeMortiseUiFixture(spec)
}

function linkFixtureChildSession(childFile: string, parentFile: string): void {
  const parentHeader = readTreeHeader(parentFile)
  const childContents = readFileSync(childFile, 'utf8')
  const lineEnd = childContents.indexOf('\n')
  const childHeaderText = lineEnd === -1 ? childContents : childContents.slice(0, lineEnd)
  const childHeader = JSON.parse(childHeaderText) as Record<string, unknown>
  if (typeof parentHeader.id !== 'string' || parentHeader.id.length === 0) throw new Error(`Fixture parent header has no session id: ${parentFile}`)
  childHeader.spawnedFrom = parentHeader.id
  const remainder = lineEnd === -1 ? '\n' : childContents.slice(lineEnd)
  writeFileSync(childFile, `${JSON.stringify(childHeader)}${remainder}`, 'utf8')
}

function readTreeHeader(path: string): Record<string, unknown> {
  const firstLine = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0]
  if (!firstLine) throw new Error(`Fixture tree session is missing its header: ${path}`)
  return JSON.parse(firstLine) as Record<string, unknown>
}

export function prepareProfile(args: {
  profileDir: string
  mode: MortiseUiProfileMode
  sourceMortiseConfigDir?: string
  sourcePiAgentDir?: string
  fixtureSpec?: MortiseUiFixtureSpec
  extensionPaths?: string[]
}): PreparedMortiseUiProfile {
  const root = resolve(args.profileDir)
  const mortiseConfigDir = join(root, 'mortise-config')
  const piAgentDir = join(root, 'pi-agent')
  const electronUserDataDir = join(root, 'electron-user-data')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  if (args.mode === 'clone') {
    copyProfileTree(resolve(args.sourceMortiseConfigDir ?? process.env.MORTISE_CONFIG_DIR ?? join(homedir(), '.mortise')), mortiseConfigDir)
    copyProfileTree(resolve(args.sourcePiAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')), piAgentDir)
    redirectClonedWorkspaceRoots(mortiseConfigDir, root)
  }
  mkdirSync(mortiseConfigDir, { recursive: true })
  mkdirSync(piAgentDir, { recursive: true })
  mkdirSync(electronUserDataDir, { recursive: true })
  const fixture = args.mode === 'fixture' ? seedFixtureProfile(root, mortiseConfigDir, piAgentDir, args.fixtureSpec) : undefined
  const mountedExtensions = mountMortiseUiExtensions(piAgentDir, args.extensionPaths ?? [])
  return {
    root, mortiseConfigDir, piAgentDir, electronUserDataDir, mode: args.mode,
    containsClonedUserData: args.mode === 'clone', fixture,
    ...(mountedExtensions.length > 0 ? { mountedExtensions } : {}),
  }
}
