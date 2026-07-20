import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getSessionFilePath, getSessionPath, listSessions, loadSession, setSharedPiSessionsDirForTests } from '@mortise/shared/sessions'
import { prepareProfile } from '../profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('mortise-ui profiles', () => {
  it('creates a disposable fixture profile that opens the main application', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'fixture' })
    const config = JSON.parse(readFileSync(join(profile.mortiseConfigDir, 'config.json'), 'utf8'))

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
      expect(existsSync(join(workspace.rootPath, 'config.json'))).toBe(true)
      expect(existsSync(join(workspace.rootPath, 'README.md'))).toBe(true)
      expect(existsSync(join(workspace.rootPath, 'sources'))).toBe(false)
    }
    const productRoot = config.workspaces.find((workspace: { id: string }) => workspace.id === 'product-launch').rootPath as string
    const researchRoot = config.workspaces.find((workspace: { id: string }) => workspace.id === 'customer-research').rootPath as string
    const supportRoot = config.workspaces.find((workspace: { id: string }) => workspace.id === 'support-operations').rootPath as string
    expect(existsSync(join(productRoot, 'src', 'search.ts'))).toBe(true)
    expect(existsSync(join(researchRoot, 'data', 'interviews.csv'))).toBe(true)
    expect(existsSync(join(supportRoot, 'runbooks', 'login-loop.md'))).toBe(true)

    setSharedPiSessionsDirForTests(join(profile.piAgentDir, 'sessions'))
    try {
      const productSessions = listSessions(productRoot)
      expect(productSessions.some(session => session.mortiseId === 'release-readiness')).toBe(true)
      expect(productSessions.map(session => session.mortiseId)).toEqual(expect.arrayContaining([
        'release-readiness', 'verify-search-child', 'search-regression', 'onboarding-copy',
      ]))
      expect(listSessions(researchRoot)).toHaveLength(2)
      expect(listSessions(supportRoot)).toHaveLength(2)
      expect(productSessions.find(session => session.mortiseId === 'search-regression'))
        .toMatchObject({ messageCount: 4, hasUnread: true })
      expect(loadSession(productRoot, 'release-readiness')?.messages).toHaveLength(4)
      const parentHeader = JSON.parse(readFileSync(getSessionFilePath(productRoot, 'release-readiness'), 'utf8').split(/\r?\n/, 1)[0]!)
      const childHeader = JSON.parse(readFileSync(getSessionFilePath(productRoot, 'verify-search-child'), 'utf8').split(/\r?\n/, 1)[0]!)
      expect(childHeader.spawnedFrom).toBe(parentHeader.id)
      expect(existsSync(join(getSessionPath(productRoot, 'release-readiness'), 'plans', 'release-readiness.md'))).toBe(true)
    } finally {
      setSharedPiSessionsDirForTests(undefined)
    }
    expect(existsSync(join(profile.piAgentDir, 'auth.json'))).toBe(false)
  })

  it('materializes AI-composed workspaces, files, session history, and sidecar files', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const profile = prepareProfile({
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
            messages: [
              { role: 'user', content: 'What does this export?', timestamp: 1000 },
              { role: 'assistant', content: 'It exports the value 42.', timestamp: 2000 },
            ],
            files: [{ path: 'plans/inspection.md', content: '# Inspection\n' }],
          }],
        }],
      },
    })
    const config = JSON.parse(readFileSync(join(profile.mortiseConfigDir, 'config.json'), 'utf8'))
    const workspaceRoot = config.workspaces[0].rootPath as string
    expect(profile.fixture).toEqual({
      version: 1, workspaceCount: 1, sessionCount: 1, messageCount: 2, fileCount: 2,
      activeWorkspaceId: 'workspace-a', activeSessionId: 'session-a',
    })
    expect(config).toMatchObject({ activeWorkspaceId: 'workspace-a', activeSessionId: 'session-a' })
    expect(readFileSync(join(workspaceRoot, 'src', 'index.ts'), 'utf8')).toContain('answer = 42')

    setSharedPiSessionsDirForTests(join(profile.piAgentDir, 'sessions'))
    try {
      expect(listSessions(workspaceRoot)).toEqual([expect.objectContaining({
        mortiseId: 'session-a', name: 'Inspect source', messageCount: 2, hasUnread: true,
      })])
      expect(loadSession(workspaceRoot, 'session-a')?.messages.map(message => message.content)).toEqual([
        'What does this export?', 'It exports the value 42.',
      ])
      expect(readFileSync(join(getSessionPath(workspaceRoot, 'session-a'), 'plans', 'inspection.md'), 'utf8')).toContain('# Inspection')
    } finally {
      setSharedPiSessionsDirForTests(undefined)
    }
  })

  it('creates an empty isolated profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'isolated' })
    expect(profile.containsClonedUserData).toBe(false)
    expect(existsSync(profile.mortiseConfigDir)).toBe(true)
    expect(existsSync(join(profile.mortiseConfigDir, 'config.json'))).toBe(false)
    expect(existsSync(profile.piAgentDir)).toBe(true)
    expect(existsSync(profile.electronUserDataDir)).toBe(true)
  })

  it('clones requested config while excluding locks, logs, and caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise'); const pi = join(root, 'source-pi')
    mkdirSync(join(mortise, 'logs'), { recursive: true }); mkdirSync(join(pi, 'cache'), { recursive: true })
    writeFileSync(join(mortise, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(mortise, '.server.lock'), 'unsafe')
    writeFileSync(join(mortise, 'logs', 'runtime.log'), 'noise')
    writeFileSync(join(pi, 'settings.json'), '{"provider":"test"}')
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'clone', sourceMortiseConfigDir: mortise, sourcePiAgentDir: pi })
    expect(profile.containsClonedUserData).toBe(true)
    expect(readFileSync(join(profile.mortiseConfigDir, 'settings.json'), 'utf8')).toContain('dark')
    expect(existsSync(join(profile.mortiseConfigDir, '.server.lock'))).toBe(false)
    expect(existsSync(join(profile.mortiseConfigDir, 'logs'))).toBe(false)
    expect(existsSync(join(profile.piAgentDir, 'cache'))).toBe(false)
  })

  it('redirects cloned workspace roots into the temporary profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise'); const pi = join(root, 'source-pi')
    mkdirSync(mortise); mkdirSync(pi)
    const sourceWorkspace = join(root, 'real-workspace')
    writeFileSync(join(mortise, 'config.json'), JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'Real', rootPath: sourceWorkspace }],
    }))
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'clone', sourceMortiseConfigDir: mortise, sourcePiAgentDir: pi })
    const cloned = JSON.parse(readFileSync(join(profile.mortiseConfigDir, 'config.json'), 'utf8'))
    expect(cloned.workspaces[0].rootPath).toStartWith(join(profile.root, 'workspace-clones'))
    expect(cloned.workspaces[0].rootPath).not.toBe(sourceWorkspace)
    expect(existsSync(cloned.workspaces[0].rootPath)).toBe(true)
  })

  it('mounts a Manifest V1 extension from its development directory without copying source', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const extensionRoot = createExtensionPackage(root, 'dev-extension')
    const profile = prepareProfile({
      profileDir: join(root, 'profile'),
      mode: 'fixture',
      extensionPaths: [extensionRoot],
    })
    const settings = JSON.parse(readFileSync(join(profile.piAgentDir, 'settings.json'), 'utf8'))

    expect(settings.extensions).toEqual([expect.objectContaining({
      id: 'dev-extension',
      path: resolve(extensionRoot, 'index.ts'),
      targets: ['mortise'],
      manifest: expect.objectContaining({ schemaVersion: 1, version: '1.2.3' }),
    })])
    expect(profile.mountedExtensions).toEqual([{
      packageRoot: resolve(extensionRoot),
      packageName: 'dev-extension-package',
      entries: [{
        id: 'dev-extension',
        path: resolve(extensionRoot, 'index.ts'),
        version: '1.2.3',
        targets: ['mortise'],
        overrodeExisting: false,
      }],
    }])
    expect(existsSync(join(profile.piAgentDir, 'extensions'))).toBe(false)
    expect(readFileSync(join(extensionRoot, 'index.ts'), 'utf8')).toContain('dev_extension')
  })

  it('overrides a cloned extension entry with the mounted development directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const mortise = join(root, 'source-mortise'); const pi = join(root, 'source-pi')
    mkdirSync(mortise); mkdirSync(pi)
    writeFileSync(join(pi, 'settings.json'), JSON.stringify({
      provider: 'test',
      extensions: [
        { id: 'keep-extension', path: 'C:\\keep.ts', targets: ['mortise'] },
        { id: 'dev-extension', path: 'C:\\old.ts', targets: ['mortise'] },
      ],
    }))
    const extensionRoot = createExtensionPackage(root, 'dev-extension')
    const profile = prepareProfile({
      profileDir: join(root, 'profile'), mode: 'clone',
      sourceMortiseConfigDir: mortise, sourcePiAgentDir: pi,
      extensionPaths: [extensionRoot],
    })
    const settings = JSON.parse(readFileSync(join(profile.piAgentDir, 'settings.json'), 'utf8'))

    expect(settings.provider).toBe('test')
    expect(settings.extensions).toHaveLength(2)
    expect(settings.extensions.find((entry: { id: string }) => entry.id === 'keep-extension')).toBeDefined()
    expect(settings.extensions.find((entry: { id: string }) => entry.id === 'dev-extension').path)
      .toBe(resolve(extensionRoot, 'index.ts'))
    expect(profile.mountedExtensions?.[0]?.entries[0]?.overrodeExisting).toBe(true)
  })

  it('rejects duplicate mounted IDs and non-Mortise packages before startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-profile-')); roots.push(root)
    const first = createExtensionPackage(root, 'duplicate', 'first')
    const second = createExtensionPackage(root, 'duplicate', 'second')
    expect(() => prepareProfile({
      profileDir: join(root, 'duplicate-profile'), mode: 'isolated', extensionPaths: [first, second],
    })).toThrow('Mounted extension id is duplicated: duplicate')

    const piOnly = createExtensionPackage(root, 'pi-only', 'pi-only', ['pi'])
    expect(() => prepareProfile({
      profileDir: join(root, 'pi-only-profile'), mode: 'isolated', extensionPaths: [piOnly],
    })).toThrow('targets must include mortise')
  })
})

function createExtensionPackage(root: string, id: string, directory = id, targets = ['mortise']): string {
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
        targets,
        manifest: {
          schemaVersion: 1,
          name: id,
          version: '1.2.3',
          author: { name: 'Test Author' },
          engines: { mortise: '^0.1.0' },
          capabilities: [],
          permissions: [],
        },
      }],
    },
  }))
  return extensionRoot
}
