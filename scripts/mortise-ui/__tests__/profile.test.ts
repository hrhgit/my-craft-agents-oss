import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { getSessionFilePath, getSessionPath, listSessions, loadSession, setSharedPiSessionsDirForTests } from '@mortise/shared/sessions'
import { MultiWriterStore, type JsonValue } from '@mortise/shared/storage'
import { prepareProfile } from '../profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface ProfileWorkspaceRecord {
  id: string
  name: string
  rootPath: string
}

interface ProfileConfigRecord {
  workspaces: ProfileWorkspaceRecord[]
  activeWorkspaceId: string | null
  activeSessionId: string | null
  setupDeferred?: boolean
  notificationsEnabled?: boolean
}

describe('mortise-ui profiles', () => {
  it('creates a disposable fixture profile that opens the main application', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const profile = await prepareProfile({ profileDir: join(root, 'profile'), mode: 'fixture' })
    const config = readConfigRecord(profile.mortiseConfigDir)

    expect(profile.containsClonedUserData).toBe(false)
    expect(profile.fixture).toEqual({
      version: 1, workspaceCount: 3, sessionCount: 8, messageCount: 20, fileCount: 17,
      activeWorkspaceId: 'product-launch', activeSessionId: 'release-readiness',
    })
    expect(config).toMatchObject({
      activeWorkspaceId: 'product-launch',
      activeSessionId: 'release-readiness',
      setupDeferred: true,
      notificationsEnabled: false,
    })
    expect(config.workspaces).toHaveLength(3)
    expect(config.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      'product-launch',
      'customer-research',
      'support-operations',
    ])
    for (const workspace of config.workspaces) {
      expect(workspace.rootPath).toStartWith(profile.root)
      expect(existsSync(join(workspace.rootPath, 'config.json'))).toBe(false)
      expect(readWorkspaceRecord(profile.mortiseConfigDir, workspace.rootPath)).toMatchObject({
        id: workspace.id,
        name: workspace.name,
      })
      expect(existsSync(join(workspace.rootPath, 'README.md'))).toBe(true)
      expect(existsSync(join(workspace.rootPath, 'sources'))).toBe(false)
    }
    const productRoot = config.workspaces.find((workspace: { id: string }) => workspace.id === 'product-launch').rootPath as string
    const researchRoot = config.workspaces.find((workspace: { id: string }) => workspace.id === 'customer-research').rootPath as string
    const supportRoot = config.workspaces.find((workspace: { id: string }) => workspace.id === 'support-operations').rootPath as string
    expect(existsSync(join(productRoot, 'src', 'search.ts'))).toBe(true)
    expect(existsSync(join(researchRoot, 'data', 'interviews.csv'))).toBe(true)
    expect(existsSync(join(supportRoot, 'runbooks', 'login-loop.md'))).toBe(true)

    setSharedPiSessionsDirForTests(join(profile.mortiseAgentDir, 'sessions'))
    try {
      const productSessions = listSessions('product-launch', productRoot)
      expect(productSessions.some(session => session.mortiseId === 'release-readiness')).toBe(true)
      expect(productSessions.map(session => session.mortiseId)).toEqual(expect.arrayContaining([
        'release-readiness', 'verify-search-child', 'search-regression', 'onboarding-copy',
      ]))
      expect(listSessions('customer-research', researchRoot)).toHaveLength(2)
      expect(listSessions('support-operations', supportRoot)).toHaveLength(2)
      expect(productSessions.find(session => session.mortiseId === 'search-regression'))
        .toMatchObject({ messageCount: 4, hasUnread: true })
      expect(loadSession('product-launch', 'release-readiness')?.messages).toHaveLength(4)
      const parentHeader = JSON.parse(readFileSync(getSessionFilePath('product-launch', 'release-readiness'), 'utf8').split(/\r?\n/, 1)[0]!)
      const childHeader = JSON.parse(readFileSync(getSessionFilePath('product-launch', 'verify-search-child'), 'utf8').split(/\r?\n/, 1)[0]!)
      expect(childHeader.spawnedFrom).toBe(parentHeader.id)
      expect(existsSync(join(getSessionPath('product-launch', 'release-readiness'), 'plans', 'release-readiness.md'))).toBe(true)
    } finally {
      setSharedPiSessionsDirForTests(undefined)
    }
    expect(existsSync(join(profile.mortiseAgentDir, 'auth.json'))).toBe(false)
  })

  it('materializes AI-composed workspaces, files, session history, and sidecar files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const profile = await prepareProfile({
      profileDir: join(root, 'profile'),
      mode: 'fixture',
      fixtureSpec: {
        version: 1,
        active: { workspaceId: 'workspace-a', sessionId: 'session-a' },
        workspaces: [{
          id: 'workspace-a', name: 'Workspace A', permissionMode: 'ask',
          files: [{ path: 'src/index.ts', content: 'export const answer = 42\n' }],
          sessions: [{
            id: 'session-a', name: 'Inspect source', hasUnread: true,
            pendingPlanExecution: {
              planPath: 'plans/inspection.md',
              draftInputSnapshot: 'Run the inspection plan.',
              awaitingCompaction: true,
              executionDispatched: false,
            },
            messages: [
              { role: 'user', content: 'What does this export?', timestamp: 1000 },
              { role: 'assistant', content: 'It exports the value 42.', timestamp: 2000 },
            ],
            files: [{ path: 'plans/inspection.md', content: '# Inspection\n' }],
          }],
        }],
      },
    })
    const config = readConfigRecord(profile.mortiseConfigDir)
    const workspaceRoot = config.workspaces[0].rootPath as string
    expect(profile.fixture).toEqual({
      version: 1, workspaceCount: 1, sessionCount: 1, messageCount: 2, fileCount: 2,
      activeWorkspaceId: 'workspace-a', activeSessionId: 'session-a',
    })
    expect(config).toMatchObject({ activeWorkspaceId: 'workspace-a', activeSessionId: 'session-a' })
    expect(readFileSync(join(workspaceRoot, 'src', 'index.ts'), 'utf8')).toContain('answer = 42')

    setSharedPiSessionsDirForTests(join(profile.mortiseAgentDir, 'sessions'))
    try {
      expect(listSessions('workspace-a', workspaceRoot)).toEqual([expect.objectContaining({
        mortiseId: 'session-a', name: 'Inspect source', messageCount: 2, hasUnread: true,
      })])
      expect(loadSession('workspace-a', 'session-a')?.messages.map(message => message.content)).toEqual([
        'What does this export?', 'It exports the value 42.',
      ])
      expect(loadSession('workspace-a', 'session-a')?.pendingPlanExecution).toEqual({
        planPath: 'plans/inspection.md',
        draftInputSnapshot: 'Run the inspection plan.',
        awaitingCompaction: true,
        executionDispatched: false,
      })
      expect(readFileSync(join(getSessionPath('workspace-a', 'session-a'), 'plans', 'inspection.md'), 'utf8')).toContain('# Inspection')
    } finally {
      setSharedPiSessionsDirForTests(undefined)
    }
  })

  it('creates an empty isolated profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const profile = await prepareProfile({ profileDir: join(root, 'profile'), mode: 'isolated' })
    expect(profile.containsClonedUserData).toBe(false)
    expect(existsSync(profile.mortiseConfigDir)).toBe(true)
    expect(existsSync(join(profile.mortiseConfigDir, 'config.json'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, 'drafts.json'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, 'state.sqlite'))).toBe(false)
    expect(existsSync(profile.mortiseAgentDir)).toBe(true)
    expect(existsSync(profile.electronUserDataDir)).toBe(true)
  })

  it('clones requested config while excluding locks, logs, and caches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise')
    mkdirSync(join(mortise, 'logs'), { recursive: true })
    for (const directory of ['.cache', 'npm', 'git']) {
      mkdirSync(join(mortise, 'agent', directory), { recursive: true })
      writeFileSync(join(mortise, 'agent', directory, 'rebuildable'), directory)
    }
    writeFileSync(join(mortise, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(mortise, 'config.json'), '{"legacy":true}')
    writeFileSync(join(mortise, 'drafts.json'), '{"drafts":{}}')
    writeFileSync(join(mortise, '.config.json.sync'), '{"legacy":true}')
    writeFileSync(join(mortise, '.drafts.json.sync'), '{"drafts":{}}')
    writeFileSync(join(mortise, '.server.lock'), 'unsafe')
    writeFileSync(join(mortise, 'logs', 'runtime.log'), 'noise')
    const profile = await prepareProfile({ profileDir: join(root, 'profile'), mode: 'clone', sourceMortiseConfigDir: mortise })
    expect(profile.containsClonedUserData).toBe(true)
    expect(readFileSync(join(profile.mortiseConfigDir, 'settings.json'), 'utf8')).toContain('dark')
    expect(existsSync(join(profile.mortiseConfigDir, 'config.json'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, 'drafts.json'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, '.config.json.sync'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, '.drafts.json.sync'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, '.server.lock'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, 'logs'))).toBe(false)
    expect(existsSync(join(profile.mortiseAgentDir, 'cache'))).toBe(false)
    expect(existsSync(join(profile.mortiseAgentDir, '.cache'))).toBe(false)
    expect(existsSync(join(profile.mortiseAgentDir, 'npm'))).toBe(false)
    expect(existsSync(join(profile.mortiseAgentDir, 'git'))).toBe(false)
  })

  it('redirects cloned workspace roots into the temporary profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise')
    mkdirSync(mortise)
    const sourceWorkspace = join(root, 'real-workspace')
    seedStateRecord(mortise, sourceWorkspace.replace(/\\/g, '/'), {
      id: 'ws-1', name: 'Real', slug: 'real', createdAt: 1, updatedAt: 1,
    })
    seedStateRecord(mortise, 'config', {
      workspaces: [{ id: 'ws-1', name: 'Real', rootPath: sourceWorkspace }],
      activeWorkspaceId: 'ws-1', activeSessionId: null,
    })
    const profile = await prepareProfile({ profileDir: join(root, 'profile'), mode: 'clone', sourceMortiseConfigDir: mortise })
    const cloned = readConfigRecord(profile.mortiseConfigDir)
    expect(cloned.workspaces[0].rootPath).toStartWith(join(profile.root, 'workspace-clones'))
    expect(cloned.workspaces[0].rootPath).not.toBe(sourceWorkspace)
    expect(existsSync(cloned.workspaces[0].rootPath)).toBe(true)
    expect(readWorkspaceRecord(profile.mortiseConfigDir, cloned.workspaces[0].rootPath)).toMatchObject({
      id: 'ws-1', name: 'Real', slug: 'real',
    })
    expect(existsSync(join(profile.mortiseConfigDir, 'config.json'))).toBe(false)
  })

  it('resolves portable workspace roots before reading their SQLite records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise')
    mkdirSync(mortise)
    const sourceWorkspace = join(root, 'portable-workspace')
    const portableRoot = `~/${relative(homedir(), sourceWorkspace).replace(/\\/g, '/')}`
    seedStateRecord(mortise, sourceWorkspace.replace(/\\/g, '/'), {
      id: 'ws-portable', name: 'Portable', slug: 'portable', createdAt: 1, updatedAt: 1,
    })
    seedStateRecord(mortise, 'config', {
      workspaces: [{ id: 'ws-portable', name: 'Portable', rootPath: portableRoot }],
      activeWorkspaceId: 'ws-portable', activeSessionId: null,
    })

    const profile = await prepareProfile({
      profileDir: join(root, 'profile'), mode: 'clone',
      sourceMortiseConfigDir: mortise,
    })
    const cloned = readConfigRecord(profile.mortiseConfigDir)

    expect(readWorkspaceRecord(profile.mortiseConfigDir, cloned.workspaces[0].rootPath)).toMatchObject({
      id: 'ws-portable', name: 'Portable', slug: 'portable',
    })
  })

  it('mounts a Manifest V1 extension from its development directory without copying source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const extensionRoot = createExtensionPackage(root, 'dev-extension')
    const profile = await prepareProfile({
      profileDir: join(root, 'profile'),
      mode: 'fixture',
      extensionPaths: [extensionRoot],
    })
    const settings = JSON.parse(readFileSync(join(profile.mortiseAgentDir, 'settings.json'), 'utf8'))

    expect(settings.extensions).toEqual([expect.objectContaining({
      id: 'dev-extension',
      path: resolve(extensionRoot, 'index.ts'),
      manifest: expect.objectContaining({ schemaVersion: 1, version: '1.2.3' }),
    })])
    expect(profile.mountedExtensions).toEqual([{
      packageRoot: resolve(extensionRoot),
      packageName: 'dev-extension-package',
      entries: [{
        id: 'dev-extension',
        path: resolve(extensionRoot, 'index.ts'),
        version: '1.2.3',
        overrodeExisting: false,
      }],
    }])
    expect(existsSync(join(profile.mortiseAgentDir, 'extensions'))).toBe(false)
    expect(readFileSync(join(extensionRoot, 'index.ts'), 'utf8')).toContain('dev_extension')
  })

  it('overrides a cloned extension entry with the mounted development directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise')
    mkdirSync(join(mortise, 'agent'), { recursive: true })
    writeFileSync(join(mortise, 'agent', 'settings.json'), JSON.stringify({
      provider: 'test',
      extensions: [
        { id: 'keep-extension', path: 'C:\\keep.ts' },
        { id: 'dev-extension', path: 'C:\\old.ts' },
      ],
    }))
    const extensionRoot = createExtensionPackage(root, 'dev-extension')
    const profile = await prepareProfile({
      profileDir: join(root, 'profile'), mode: 'clone',
      sourceMortiseConfigDir: mortise,
      extensionPaths: [extensionRoot],
    })
    const settings = JSON.parse(readFileSync(join(profile.mortiseAgentDir, 'settings.json'), 'utf8'))

    expect(settings.provider).toBe('test')
    expect(settings.extensions).toHaveLength(2)
    expect(settings.extensions.find((entry: { id: string }) => entry.id === 'keep-extension')).toBeDefined()
    expect(settings.extensions.find((entry: { id: string }) => entry.id === 'dev-extension').path)
      .toBe(resolve(extensionRoot, 'index.ts'))
    expect(profile.mountedExtensions?.[0]?.entries[0]?.overrodeExisting).toBe(true)
  })

  it('rejects duplicate mounted IDs and removed host-specific fields before startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const first = createExtensionPackage(root, 'duplicate', 'first')
    const second = createExtensionPackage(root, 'duplicate', 'second')
    await expect(prepareProfile({
      profileDir: join(root, 'duplicate-profile'), mode: 'isolated', extensionPaths: [first, second],
    })).rejects.toThrow('Mounted extension id is duplicated: duplicate')

    for (const [directory, entryOverrides] of [
      ['pi-target', { targets: ['pi'] }],
      ['craft-target', { targets: ['craft'] }],
      ['host-engines', { engines: { mortise: '*' } }],
    ] as const) {
      const extension = createExtensionPackage(root, directory, directory, entryOverrides)
      await expect(prepareProfile({
        profileDir: join(root, `${directory}-profile`), mode: 'isolated', extensionPaths: [extension],
      })).rejects.toThrow('extension entry contains unknown fields')
    }
  })
})

function openStateStore(mortiseConfigDir: string): MultiWriterStore {
  return MultiWriterStore.openSync({
    databasePath: join(mortiseConfigDir, 'state.sqlite'),
    writerId: `profile-test-${randomUUID()}`,
    writerVersion: 1,
  })
}

function seedStateRecord(mortiseConfigDir: string, namespace: string, value: JsonValue): void {
  const store = openStateStore(mortiseConfigDir)
  try {
    const result = store.mutateRecord({
      namespace,
      key: 'root',
      value,
      expectedVersion: null,
      operationId: randomUUID(),
    })
    expect(result.status).toBe('applied')
  } finally {
    store.close()
  }
}

function readConfigRecord(mortiseConfigDir: string): ProfileConfigRecord {
  return readStateRecord(mortiseConfigDir, 'config') as unknown as ProfileConfigRecord
}

function readWorkspaceRecord(mortiseConfigDir: string, rootPath: string): Record<string, JsonValue> {
  return readStateRecord(mortiseConfigDir, rootPath.replace(/\\/g, '/')) as Record<string, JsonValue>
}

function readStateRecord(mortiseConfigDir: string, namespace: string): JsonValue {
  const store = openStateStore(mortiseConfigDir)
  try {
    const record = store.getRecord(namespace, 'root')
    expect(record).not.toBeNull()
    return record!.value
  } finally {
    store.close()
  }
}

function createExtensionPackage(
  root: string,
  id: string,
  directory = id,
  entryOverrides: Record<string, unknown> = {},
): string {
  const extensionRoot = join(root, directory)
  mkdirSync(extensionRoot, { recursive: true })
  writeFileSync(join(extensionRoot, 'index.ts'), `export default function ${id.replaceAll('-', '_')}() {}\n`)
  writeFileSync(join(extensionRoot, 'package.json'), JSON.stringify({
    name: `${id}-package`,
    type: 'module',
    pi: {
      extensions: [{
        id,
        path: './index.ts',
        ...entryOverrides,
        manifest: {
          schemaVersion: 1,
          name: id,
          version: '1.2.3',
          author: { name: 'Test Author' },
          capabilities: [],
          permissions: [],
        },
      }],
    },
  }))
  return extensionRoot
}
