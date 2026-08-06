import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  appendStoredMessagesViaPiSessionManager,
  ensureSharedPiTreeSessionFileAsync,
  getSessionPath,
  setSharedPiSessionsDirForTests,
  writeTreeSessionMortiseMetadataAsync,
  type StoredMessage,
  type StoredSession,
} from '@mortise/shared/sessions'
import {
  MultiWriterStore,
  openMortiseSqliteDatabaseSync,
  type JsonValue,
} from '@mortise/shared/storage'
import {
  GLOBAL_CONFIG_RECORD_KEY,
  GLOBAL_CONFIG_RECORD_NAMESPACE,
  MORTISE_STATE_DATABASE_FILENAME,
  MORTISE_STATE_WRITER_VERSION,
  getMortiseStateDatabasePath,
} from '@mortise/shared/config/state-contract'
import { expandPath } from '@mortise/shared/utils/paths'
import {
  getWorkspaceConfigRecordIdentity,
} from '@mortise/shared/workspaces/state-contract'
import { WorkspaceTopologyStore } from '@mortise/shared/workspaces'
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
  '.server.lock', '.workspace-server.lock', 'logs', 'node_modules', 'cache', '.cache', 'Cache',
  'npm', 'git',
  'Code Cache', 'GPUCache', 'Crashpad', 'window-state.json',
])

const LEGACY_MORTISE_CONFIG_NAMES = new Set([
  'config.json',
  'drafts.json',
  '.config.json.sync',
  '.drafts.json.sync',
  '.mortise-config.sync',
])

const FIXTURE_CREATED_AT = Date.UTC(2026, 0, 1)

function isLegacyMortiseConfigName(name: string): boolean {
  return LEGACY_MORTISE_CONFIG_NAMES.has(name)
    || /^config\.json\.(?:bak-|corrupt-)/.test(name)
    || name === `${MORTISE_STATE_DATABASE_FILENAME}-wal`
    || name === `${MORTISE_STATE_DATABASE_FILENAME}-shm`
    || name === MORTISE_STATE_DATABASE_FILENAME
}

function copyProfileTree(source: string, target: string, excludeLegacyMortiseConfig = false): void {
  if (!existsSync(source)) return
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
    filter(path) {
      if (path === source) return true
      const name = path.split(/[\\/]/).at(-1) ?? ''
      if (EXCLUDED_NAMES.has(name)) return false
      if (excludeLegacyMortiseConfig && isLegacyMortiseConfigName(name)) return false
      // Never traverse links while cloning a profile: their targets may escape
      // the explicitly selected source directory or pull in large caches.
      try { return !lstatSync(path).isSymbolicLink() } catch { return false }
    },
  })
}

function stateDatabasePath(mortiseConfigDir: string): string {
  return getMortiseStateDatabasePath(mortiseConfigDir)
}

function snapshotStateDatabase(sourceMortiseConfigDir: string, targetMortiseConfigDir: string): void {
  const source = stateDatabasePath(sourceMortiseConfigDir)
  if (!existsSync(source)) return
  const target = stateDatabasePath(targetMortiseConfigDir)
  mkdirSync(targetMortiseConfigDir, { recursive: true })
  const database = openMortiseSqliteDatabaseSync(source)
  try {
    database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } finally {
    database.close()
  }
}

function openProfileStateStore(mortiseConfigDir: string): MultiWriterStore {
  return MultiWriterStore.openSync({
    databasePath: stateDatabasePath(mortiseConfigDir),
    writerId: `mortise-ui-profile-${process.pid}-${randomUUID()}`,
    writerVersion: MORTISE_STATE_WRITER_VERSION,
  })
}

function writeStateRecord(
  store: MultiWriterStore,
  namespace: string,
  value: JsonValue,
): void {
  const current = store.getRecord(namespace, GLOBAL_CONFIG_RECORD_KEY)
  const result = store.mutateRecord({
    namespace,
    key: GLOBAL_CONFIG_RECORD_KEY,
    value,
    expectedVersion: current?.version ?? null,
    operationId: `mortise-ui-profile-${randomUUID()}`,
  })
  if (result.status !== 'applied') {
    throw new Error(`Failed to write profile state record ${namespace}/${GLOBAL_CONFIG_RECORD_KEY}`)
  }
}

export interface PreparedMortiseUiProfile {
  root: string
  mortiseConfigDir: string
  mortiseAgentDir: string
  electronUserDataDir: string
  mode: MortiseUiProfileMode
  containsClonedUserData: boolean
  fixture?: MortiseUiFixtureSummary
  mountedExtensions?: MortiseUiMountedExtension[]
}

function redirectClonedWorkspaceRoots(mortiseConfigDir: string, profileRoot: string): void {
  const databasePath = stateDatabasePath(mortiseConfigDir)
  if (!existsSync(databasePath)) return
  const store = openProfileStateStore(mortiseConfigDir)
  try {
    const configRecord = store.getRecord(GLOBAL_CONFIG_RECORD_NAMESPACE, GLOBAL_CONFIG_RECORD_KEY)
    if (!configRecord) return
    const config = configRecord.value as { workspaces?: Array<Record<string, JsonValue>> }
    if (!Array.isArray(config.workspaces)) return
    const cloneRoot = join(profileRoot, 'workspace-clones')
    mkdirSync(cloneRoot, { recursive: true })
    const workspaces = config.workspaces.map((workspace, index) => {
      const identity = typeof workspace.id === 'string' && /^[A-Za-z0-9._-]+$/.test(workspace.id)
        ? workspace.id
        : `workspace-${index + 1}`
      const sourceRootPath = workspace.rootPath
      if (typeof sourceRootPath !== 'string' || sourceRootPath.length === 0) {
        throw new Error(`Cloned workspace ${identity} has no current rootPath`)
      }
      const rootPath = join(cloneRoot, identity)
      mkdirSync(rootPath, { recursive: true })
      const sourceIdentity = getWorkspaceConfigRecordIdentity(expandPath(sourceRootPath))
      const workspaceRecord = store.getRecord(sourceIdentity.namespace, sourceIdentity.key)
      if (!workspaceRecord) {
        throw new Error(`Cloned workspace ${identity} has no SQLite workspace configuration`)
      }
      writeStateRecord(store, getWorkspaceConfigRecordIdentity(rootPath).namespace, workspaceRecord.value)
      return { ...workspace, rootPath }
    })
    writeStateRecord(store, GLOBAL_CONFIG_RECORD_NAMESPACE, { ...config, workspaces } as JsonValue)
  } finally {
    store.close()
  }
}

export function reusePreparedProfile(args: {
  profileDir: string
  mode: MortiseUiProfileMode
  containsClonedUserData: boolean
  fixture?: MortiseUiFixtureSummary
  mountedExtensions?: MortiseUiMountedExtension[]
}): PreparedMortiseUiProfile {
  const root = resolve(args.profileDir)
  const mortiseConfigDir = join(root, 'mortise-config')
  const mortiseAgentDir = join(mortiseConfigDir, 'agent')
  const electronUserDataDir = join(root, 'electron-user-data')
  for (const path of [root, mortiseConfigDir, mortiseAgentDir, electronUserDataDir]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`Reusable Mortise UI profile directory is missing: ${path}`)
  }
  return {
    root,
    mortiseConfigDir,
    mortiseAgentDir,
    electronUserDataDir,
    mode: args.mode,
    containsClonedUserData: args.containsClonedUserData,
    fixture: args.fixture,
    mountedExtensions: args.mountedExtensions,
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeFixtureFile(basePath: string, file: MortiseUiFixtureFile): void {
  const filePath = join(basePath, ...file.path.split('/'))
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, file.content, 'utf8')
}

async function seedFixtureProfile(root: string, mortiseConfigDir: string, mortiseAgentDir: string, input?: MortiseUiFixtureSpec): Promise<MortiseUiFixtureSummary> {
  const spec = validateMortiseUiFixtureSpec(input ?? DEFAULT_MORTISE_UI_FIXTURE)
  const fixtureRoot = join(root, 'workspaces')
  const workspaces = spec.workspaces.map((workspace, index) => ({
    ...workspace,
    slug: workspace.slug ?? workspace.id,
    rootPath: join(fixtureRoot, `${String(index + 1).padStart(2, '0')}-${workspace.slug ?? workspace.id}`),
  }))

  for (const workspace of workspaces) {
    mkdirSync(workspace.rootPath, { recursive: true })
    for (const file of workspace.files ?? []) writeFixtureFile(workspace.rootPath, file)
  }

  const stateStore = openProfileStateStore(mortiseConfigDir)
  try {
    for (const workspace of workspaces) {
      writeStateRecord(stateStore, getWorkspaceConfigRecordIdentity(workspace.rootPath).namespace, {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
      })
    }
    writeStateRecord(stateStore, GLOBAL_CONFIG_RECORD_NAMESPACE, {
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
    })
  } finally {
    stateStore.close()
  }

  // The workspace authority is topology-based now. Keep the legacy per-root
  // records above for older fixture consumers, but also seed the canonical
  // registry so a real renderer can resolve the active workspace.
  const topologyStore = new WorkspaceTopologyStore({
    databasePath: stateDatabasePath(mortiseConfigDir),
    writerId: `mortise-ui-profile-topology-${process.pid}-${randomUUID()}`,
  })
  try {
    for (const workspace of workspaces) {
      topologyStore.create({
        schemaVersion: 2,
        id: workspace.id,
        name: workspace.name,
        nameSource: 'custom',
        slug: workspace.slug ?? workspace.id,
        revision: 1,
        primaryLocationId: 'primary',
        locations: [{
          id: 'primary',
          name: workspace.name,
          rootName: workspace.slug ?? workspace.id,
          endpoint: { kind: 'local', rootPath: workspace.rootPath },
        }],
        createdAt: FIXTURE_CREATED_AT,
      })
    }
  } finally {
    topologyStore.close()
  }

  setSharedPiSessionsDirForTests(join(mortiseAgentDir, 'sessions'))
  try {
    const sessionFiles = new Map<string, string>()
    const fixtureSessions: Array<{ id: string; parentSessionId?: string; sessionFile: string }> = []
    for (const [workspaceIndex, workspace] of workspaces.entries()) {
      for (const [sessionIndex, session] of (workspace.sessions ?? []).entries()) {
        const createdAt = session.createdAt ?? FIXTURE_CREATED_AT + workspaceIndex * 86_400_000 + sessionIndex * 60_000
        const messages = (session.messages ?? []).map((message, messageIndex): StoredMessage => ({
          id: message.id ?? `m-${workspaceIndex + 1}-${sessionIndex + 1}-${messageIndex + 1}`,
          type: message.role as StoredMessage['type'],
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
          workspaceId: workspace.id,
          workspaceRootPath: workspace.rootPath,
          name: session.name,
          createdAt,
          lastUsedAt: session.lastUsedAt ?? messages.at(-1)?.timestamp ?? createdAt,
          lastMessageAt: messages.at(-1)?.timestamp,
          sdkCwd: workspace.rootPath,
          permissionMode: session.permissionMode ?? 'ask',
          hasUnread: session.hasUnread,
          hidden: session.hidden,
          pendingPlanExecution: session.pendingPlanExecution,
          messages,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
        }
        const sessionFile = await ensureSharedPiTreeSessionFileAsync(storedSession, { workspaceId: workspace.id })
        sessionFiles.set(session.id, sessionFile)
        fixtureSessions.push({ id: session.id, parentSessionId: session.parentSessionId, sessionFile })
        const idMap = await appendStoredMessagesViaPiSessionManager(sessionFile, dirname(sessionFile), workspace.rootPath, messages)
        if (idMap.size > 0) {
          await writeTreeSessionMortiseMetadataAsync(sessionFile, {
            ...storedSession,
            messages: messages.map(message => ({ ...message, id: idMap.get(message.id) ?? message.id })),
          })
        }
        for (const file of session.files ?? []) writeFixtureFile(getSessionPath(workspace.id, session.id), file)
      }
    }
    for (const child of fixtureSessions) {
      if (!child.parentSessionId) continue
      const parentFile = sessionFiles.get(child.parentSessionId)
      if (!parentFile) throw new Error(`Fixture child session ${child.id} references missing parent ${child.parentSessionId}`)
      linkFixtureChildSession(child.sessionFile, parentFile)
    }
  } finally {
    setSharedPiSessionsDirForTests(undefined)
  }

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

export async function prepareProfile(args: {
  profileDir: string
  mode: MortiseUiProfileMode
  sourceMortiseConfigDir?: string
  fixtureSpec?: MortiseUiFixtureSpec
  extensionPaths?: string[]
}): Promise<PreparedMortiseUiProfile> {
  const root = resolve(args.profileDir)
  const mortiseConfigDir = join(root, 'mortise-config')
  const mortiseAgentDir = join(mortiseConfigDir, 'agent')
  const electronUserDataDir = join(root, 'electron-user-data')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  if (args.mode === 'clone') {
    const sourceMortiseConfigDir = resolve(args.sourceMortiseConfigDir ?? process.env.MORTISE_CONFIG_DIR ?? join(homedir(), '.mortise'))
    copyProfileTree(sourceMortiseConfigDir, mortiseConfigDir, true)
    snapshotStateDatabase(sourceMortiseConfigDir, mortiseConfigDir)
    redirectClonedWorkspaceRoots(mortiseConfigDir, root)
  }
  mkdirSync(mortiseConfigDir, { recursive: true })
  mkdirSync(mortiseAgentDir, { recursive: true })
  mkdirSync(electronUserDataDir, { recursive: true })
  const fixture = args.mode === 'fixture' ? await seedFixtureProfile(root, mortiseConfigDir, mortiseAgentDir, args.fixtureSpec) : undefined
  const mountedExtensions = mountMortiseUiExtensions(mortiseAgentDir, args.extensionPaths ?? [])
  return {
    root, mortiseConfigDir, mortiseAgentDir, electronUserDataDir, mode: args.mode,
    containsClonedUserData: args.mode === 'clone', fixture,
    ...(mountedExtensions.length > 0 ? { mountedExtensions } : {}),
  }
}
