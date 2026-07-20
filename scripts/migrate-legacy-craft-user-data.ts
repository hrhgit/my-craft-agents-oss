import { Database } from 'bun:sqlite'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  getAllSessionDrafts,
  loadStoredConfig,
  saveConfig,
  setSessionDraft,
  type SessionDraft,
  type StoredConfig,
} from '../packages/shared/src/config/storage.ts'
import { encodePiSessionCwd } from '../packages/shared/src/config/paths.ts'
import { saveWorkspaceConfig } from '../packages/shared/src/workspaces/storage.ts'
import type { Workspace } from '../packages/shared/src/config/types.ts'
import type { WorkspaceConfig } from '../packages/shared/src/workspaces/types.ts'

interface LegacyConfig extends StoredConfig {
  [key: string]: unknown
}

interface DraftsFile {
  drafts?: Record<string, SessionDraft>
  updatedAt?: number
}

interface SessionHeader {
  type?: unknown
  id?: unknown
  timestamp?: unknown
  cwd?: unknown
  craft?: Record<string, unknown>
  mortise?: Record<string, unknown>
  [key: string]: unknown
}

interface MigrationReport {
  startedAt: string
  completedAt?: string
  legacyConfigDir: string
  targetConfigDir: string
  backupRoot: string
  workspaces: { merged: number; workspaceRecords: number }
  drafts: { legacy: number; current: number; merged: number }
  sessions: {
    buckets: number
    jsonlScanned: number
    craftHeadersRenamed: number
    piHeadersAdopted: number
    alreadyMortise: number
    invalidJsonlSkipped: number
    sidecarDirectories: number
    sidecarFilesCopied: number
    sidecarFilesKept: number
  }
  copiedAppState: string[]
}

const home = homedir()
const legacyConfigDir = join(home, '.craft-agent')
const targetConfigDir = resolve(process.env.MORTISE_CONFIG_DIR || join(home, '.mortise'))
const expectedTargetConfigDir = resolve(join(home, '.mortise'))
const sessionsRoot = resolve(process.env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'sessions')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const backupRoot = resolve(process.argv.find(arg => arg.startsWith('--backup-root='))?.slice('--backup-root='.length)
  || join(home, '.mortise-migration-backups', timestamp))
const markerPath = join(targetConfigDir, '.legacy-craft-migration.json')

if (targetConfigDir.toLowerCase() !== expectedTargetConfigDir.toLowerCase()) {
  throw new Error(`Refusing to migrate into unexpected MORTISE_CONFIG_DIR: ${targetConfigDir}`)
}
if (!existsSync(targetConfigDir)) throw new Error(`Target config directory does not exist: ${targetConfigDir}`)

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readCompletedMigrationMarker(): MigrationReport | null {
  if (!existsSync(markerPath)) return null

  let marker: Partial<MigrationReport>
  try {
    marker = readJson<Partial<MigrationReport>>(markerPath)
  } catch (error) {
    throw new Error(
      `Refusing to rerun legacy migration because its completion marker is unreadable: ${markerPath}. `
      + 'Inspect the marker and restore from the prior migration backup before retrying.',
      { cause: error },
    )
  }
  if (typeof marker.completedAt !== 'string' || !marker.completedAt) {
    throw new Error(
      `Refusing to rerun legacy migration because its completion marker is incomplete: ${markerPath}. `
      + 'Inspect the marker and restore from the prior migration backup before retrying.',
    )
  }
  return marker as MigrationReport
}

const completedMigration = readCompletedMigrationMarker()
if (completedMigration) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: 'legacy-craft-migration-already-completed',
    completedAt: completedMigration.completedAt,
    backupRoot: completedMigration.backupRoot,
  }, null, 2))
  process.exit(0)
}

if (!existsSync(legacyConfigDir)) throw new Error(`Legacy config directory does not exist: ${legacyConfigDir}`)
if (!existsSync(join(legacyConfigDir, 'config.json'))) throw new Error('Legacy config.json is missing')
if (existsSync(backupRoot)) throw new Error(`Backup destination already exists: ${backupRoot}`)

function normalizedRoot(path: string): string {
  const expanded = path.startsWith('~') ? join(home, path.slice(1).replace(/^[\\/]+/, '')) : path
  return resolve(expanded).replace(/\\/g, '/').toLowerCase()
}

function backupPath(source: string, relativeDestination: string): void {
  if (!existsSync(source)) return
  const destination = join(backupRoot, relativeDestination)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, force: true, preserveTimestamps: true })
}

function mergeWorkspaces(legacy: Workspace[], current: Workspace[]): Workspace[] {
  const merged: Workspace[] = []
  const roots = new Set<string>()
  for (const workspace of [...legacy, ...current]) {
    const root = normalizedRoot(workspace.rootPath)
    if (roots.has(root)) continue
    roots.add(root)
    merged.push(workspace)
  }
  return merged
}

function copyTreeWithoutOverwriting(source: string, destination: string): { copied: number; kept: number } {
  if (!existsSync(source)) return { copied: 0, kept: 0 }
  mkdirSync(destination, { recursive: true })
  let copied = 0
  let kept = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      const nested = copyTreeWithoutOverwriting(from, to)
      copied += nested.copied
      kept += nested.kept
    } else if (!existsSync(to)) {
      copyFileSync(from, to)
      const sourceStat = statSync(from)
      utimesSync(to, sourceStat.atime, sourceStat.mtime)
      copied++
    } else {
      kept++
    }
  }
  return { copied, kept }
}

function migrateSessionHeader(sessionFile: string, workspaceRootPath: string): 'craft' | 'pi' | 'mortise' | 'skipped' {
  const content = readFileSync(sessionFile)
  const newline = content.indexOf(0x0a)
  const headerEnd = newline >= 0 ? newline : content.length
  const header = JSON.parse(content.subarray(0, headerEnd).toString('utf8')) as SessionHeader
  if (
    header.type !== 'session'
    || typeof header.id !== 'string'
    || typeof header.timestamp !== 'string'
    || typeof header.cwd !== 'string'
  ) {
    return 'skipped'
  }
  if (header.mortise && typeof header.mortise === 'object') return 'mortise'

  const sessionId = typeof header.id === 'string' && header.id.trim()
    ? header.id
    : basename(sessionFile, '.jsonl')
  const sourceKind = header.craft && typeof header.craft === 'object' ? 'craft' : 'pi'
  const metadata: Record<string, unknown> = sourceKind === 'craft' ? { ...header.craft } : {}
  metadata.id = typeof metadata.id === 'string' && metadata.id ? metadata.id : sessionId
  metadata.workspaceRootPath = workspaceRootPath
  if (typeof metadata.createdAt !== 'number' && typeof header.timestamp === 'string') {
    const createdAt = Date.parse(header.timestamp)
    if (Number.isFinite(createdAt)) metadata.createdAt = createdAt
  }
  header.mortise = metadata
  delete header.craft

  const originalStat = statSync(sessionFile)
  const temporary = join(dirname(sessionFile), `.${basename(sessionFile)}.mortise-migrate-${process.pid}-${randomUUID()}`)
  const fd = openSync(temporary, 'wx')
  try {
    const serialized = Buffer.from(JSON.stringify(header), 'utf8')
    writeFileSync(fd, serialized)
    if (newline >= 0) writeFileSync(fd, content.subarray(newline))
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, sessionFile)
    utimesSync(sessionFile, originalStat.atime, originalStat.mtime)
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
  return sourceKind
}

function mergeJsonFile(legacyPath: string, targetPath: string): boolean {
  if (!existsSync(legacyPath)) return false
  const legacy = readJson<Record<string, unknown>>(legacyPath)
  const current = existsSync(targetPath) ? readJson<Record<string, unknown>>(targetPath) : {}
  writeJson(targetPath, { ...current, ...legacy })
  return true
}

mkdirSync(dirname(backupRoot), { recursive: true })
mkdirSync(backupRoot, { recursive: false })
const report: MigrationReport = {
  startedAt: new Date().toISOString(),
  legacyConfigDir,
  targetConfigDir,
  backupRoot,
  workspaces: { merged: 0, workspaceRecords: 0 },
  drafts: { legacy: 0, current: 0, merged: 0 },
  sessions: {
    buckets: 0,
    jsonlScanned: 0,
    craftHeadersRenamed: 0,
    piHeadersAdopted: 0,
    alreadyMortise: 0,
    invalidJsonlSkipped: 0,
    sidecarDirectories: 0,
    sidecarFilesCopied: 0,
    sidecarFilesKept: 0,
  },
  copiedAppState: [],
}

try {
  const legacyConfig = readJson<LegacyConfig>(join(legacyConfigDir, 'config.json'))
  const currentConfig = loadStoredConfig()
  if (!currentConfig) throw new Error('Current Mortise config could not be loaded')

  const sessionBuckets = legacyConfig.workspaces.map(workspace => ({
    workspaceRootPath: resolve(workspace.rootPath),
    bucketPath: join(sessionsRoot, encodePiSessionCwd(workspace.rootPath)),
  }))

  backupPath(legacyConfigDir, 'legacy-craft-agent')
  backupPath(targetConfigDir, 'mortise-before')
  for (const bucket of sessionBuckets) {
    backupPath(bucket.bucketPath, join('pi-sessions', basename(bucket.bucketPath)))
  }

  const mergedWorkspaces = mergeWorkspaces(legacyConfig.workspaces, currentConfig.workspaces)
  const activeWorkspaceId = mergedWorkspaces.some(workspace => workspace.id === legacyConfig.activeWorkspaceId)
    ? legacyConfig.activeWorkspaceId
    : currentConfig.activeWorkspaceId
  const mergedConfig = {
    ...currentConfig,
    ...legacyConfig,
    workspaces: mergedWorkspaces,
    activeWorkspaceId,
    activeSessionId: legacyConfig.activeSessionId ?? currentConfig.activeSessionId ?? null,
  } as StoredConfig
  saveConfig(mergedConfig)
  report.workspaces.merged = mergedWorkspaces.length

  const legacyDatabase = new Database(join(legacyConfigDir, 'state.sqlite'), { readonly: true })
  try {
    const rows = legacyDatabase.query<{ namespace: string; value_json: string }, []>(
      'SELECT namespace, value_json FROM craft_records WHERE record_key = \'root\'',
    ).all()
    const records = new Map(rows.map(row => [row.namespace.toLowerCase(), row.value_json]))
    for (const workspace of legacyConfig.workspaces) {
      const key = resolve(workspace.rootPath).replace(/\\/g, '/').toLowerCase()
      const serialized = records.get(key)
      if (!serialized) continue
      saveWorkspaceConfig(resolve(workspace.rootPath), JSON.parse(serialized) as WorkspaceConfig)
      report.workspaces.workspaceRecords++
    }
  } finally {
    legacyDatabase.close()
  }

  const legacyDraftData = existsSync(join(legacyConfigDir, 'drafts.json'))
    ? readJson<DraftsFile>(join(legacyConfigDir, 'drafts.json'))
    : { drafts: {} }
  const currentDrafts = getAllSessionDrafts()
  const legacyDrafts = legacyDraftData.drafts ?? {}
  const mergedDrafts = { ...legacyDrafts, ...currentDrafts }
  report.drafts = {
    legacy: Object.keys(legacyDrafts).length,
    current: Object.keys(currentDrafts).length,
    merged: Object.keys(mergedDrafts).length,
  }
  for (const [sessionId, draft] of Object.entries(mergedDrafts)) setSessionDraft(sessionId, draft)

  if (mergeJsonFile(join(legacyConfigDir, 'preferences.json'), join(targetConfigDir, 'preferences.json'))) {
    report.copiedAppState.push('preferences.json')
  }
  for (const name of ['app-layout.v1.json', 'window-state.json']) {
    const source = join(legacyConfigDir, name)
    if (!existsSync(source)) continue
    copyFileSync(source, join(targetConfigDir, name))
    report.copiedAppState.push(name)
  }
  for (const name of ['permissions', 'themes', 'tool-icons', 'workspaces']) {
    const source = join(legacyConfigDir, name)
    if (!existsSync(source)) continue
    const copied = copyTreeWithoutOverwriting(source, join(targetConfigDir, name))
    if (copied.copied > 0) report.copiedAppState.push(`${name}/ (${copied.copied} files)`)
  }

  for (const bucket of sessionBuckets) {
    if (!existsSync(bucket.bucketPath)) continue
    report.sessions.buckets++
    for (const entry of readdirSync(bucket.bucketPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      report.sessions.jsonlScanned++
      const migrated = migrateSessionHeader(join(bucket.bucketPath, entry.name), bucket.workspaceRootPath)
      if (migrated === 'craft') report.sessions.craftHeadersRenamed++
      else if (migrated === 'pi') report.sessions.piHeadersAdopted++
      else if (migrated === 'mortise') report.sessions.alreadyMortise++
      else report.sessions.invalidJsonlSkipped++
    }

    const legacySidecars = join(bucket.bucketPath, '.craft')
    if (!existsSync(legacySidecars)) continue
    for (const entry of readdirSync(legacySidecars, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      report.sessions.sidecarDirectories++
      const result = copyTreeWithoutOverwriting(
        join(legacySidecars, entry.name),
        join(bucket.bucketPath, '.mortise', entry.name),
      )
      report.sessions.sidecarFilesCopied += result.copied
      report.sessions.sidecarFilesKept += result.kept
    }
  }

  report.completedAt = new Date().toISOString()
  writeJson(join(backupRoot, 'migration-report.json'), report)
  writeJson(markerPath, report)
  console.log(JSON.stringify({ ok: true, report }, null, 2))
} catch (error) {
  writeJson(join(backupRoot, 'migration-failure.json'), {
    ...report,
    failedAt: new Date().toISOString(),
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  })
  throw error
}
