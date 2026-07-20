import { basename, join, resolve } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { RPC_CHANNELS, type SkillFile } from '@mortise/shared/protocol'
import { validateSkillContent } from '@mortise/shared/config'
import { importResources } from '@mortise/shared/resources'
import {
  invalidateSkillsCache,
  loadSkill,
  resolveSkillDir,
  type DiscoveredSkill,
  type SkillImportBatchResult,
  type SkillImportResult,
} from '@mortise/shared/skills'
import { collectDirectoryFiles, isPathWithinDirectory } from '@mortise/shared/utils'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrNull, getWorkspaceOrThrow, resolveWorkspaceId } from '../utils'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DISCOVER,
  RPC_CHANNELS.skills.IMPORT,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
] as const

const MAX_DISCOVERY_DIRECTORIES = 50_000
const MAX_DISCOVERED_SKILLS = 1_000
const MAX_HOME_SCAN_DEPTH = 4
const MAX_SKILL_ROOT_DEPTH = 4
const DISCOVERY_CONCURRENCY = 16
const SKIPPED_DISCOVERY_DIRECTORIES = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'dist', 'build', 'out',
  'cache', 'caches', 'logs', 'temp', 'tmp',
])

async function directoryContainsValidSkill(directory: string): Promise<boolean> {
  const skillFile = join(directory, 'SKILL.md')
  try {
    const content = await readFile(skillFile, 'utf-8')
    return validateSkillContent(content, basename(directory)).valid
  } catch {
    return false
  }
}

async function discoverUnderSkillsRoot(skillsRoot: string): Promise<DiscoveredSkill[]> {
  const candidates: DiscoveredSkill[] = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: skillsRoot, depth: 0 }]

  while (queue.length > 0 && candidates.length < MAX_DISCOVERED_SKILLS) {
    const current = queue.shift()!
    if (await directoryContainsValidSkill(current.directory)) {
      candidates.push({
        sourcePath: current.directory,
        skillsRoot,
        slug: basename(current.directory),
      })
      continue
    }
    if (current.depth >= MAX_SKILL_ROOT_DEPTH) continue

    try {
      const entries = await readdir(current.directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIPPED_DISCOVERY_DIRECTORIES.has(entry.name.toLowerCase())) continue
        queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 })
      }
    } catch {
      // User directories can contain inaccessible application data. Skip them.
    }
  }
  return candidates
}

/** Find valid skills below every directory named "skills" in the user's home tree. */
export async function discoverSkillsUnderHome(
  homePath = homedir(),
  workspaceRootPath?: string,
): Promise<DiscoveredSkill[]> {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: resolve(homePath), depth: 0 }]
  const skillRoots = new Set<string>()
  let visited = 0

  while (queue.length > 0 && visited < MAX_DISCOVERY_DIRECTORIES) {
    const batch = queue.splice(0, DISCOVERY_CONCURRENCY)
    const results = await Promise.all(batch.map(async ({ directory }) => {
      visited += 1
      try {
        return await readdir(directory, { withFileTypes: true })
      } catch {
        return []
      }
    }))

    for (let index = 0; index < batch.length; index += 1) {
      const { directory, depth } = batch[index]!
      for (const entry of results[index]!) {
        if (!entry.isDirectory()) continue
        const name = entry.name.toLowerCase()
        if (SKIPPED_DISCOVERY_DIRECTORIES.has(name)) continue
        const child = join(directory, entry.name)
        const childDepth = depth + 1
        if (name === 'skills' && childDepth <= MAX_HOME_SCAN_DEPTH) skillRoots.add(child)
        else if (childDepth < MAX_HOME_SCAN_DEPTH) queue.push({ directory: child, depth: childDepth })
      }
    }
  }

  const excludedWorkspaceSkillsRoot = workspaceRootPath
    ? join(resolve(workspaceRootPath), '.pi', 'skills')
    : undefined
  const discovered: DiscoveredSkill[] = []
  for (const skillsRoot of [...skillRoots].sort((a, b) => a.localeCompare(b))) {
    if (excludedWorkspaceSkillsRoot && isPathWithinDirectory(skillsRoot, excludedWorkspaceSkillsRoot)) continue
    discovered.push(...await discoverUnderSkillsRoot(skillsRoot))
    if (discovered.length >= MAX_DISCOVERED_SKILLS) break
  }

  const unique = new Map<string, DiscoveredSkill>()
  for (const candidate of discovered) {
    const key = process.platform === 'win32' ? candidate.sourcePath.toLowerCase() : candidate.sourcePath
    unique.set(key, candidate)
  }
  return [...unique.values()].sort((a, b) =>
    a.slug.localeCompare(b.slug) || a.sourcePath.localeCompare(b.sourcePath))
}

export async function importSkillDirectory(
  workspaceRootPath: string,
  sourceDirectory: string,
): Promise<SkillImportResult> {
  const resolvedSource = resolve(sourceDirectory)
  if (!existsSync(resolvedSource) || !statSync(resolvedSource).isDirectory()) {
    throw new Error('The selected path is not a skill directory')
  }

  const slug = basename(resolvedSource)
  const skillFile = join(resolvedSource, 'SKILL.md')
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    throw new Error('The selected directory does not contain SKILL.md')
  }

  const validation = validateSkillContent(readFileSync(skillFile, 'utf-8'), slug)
  if (!validation.valid) {
    throw new Error(validation.errors.map(issue => issue.message).join('; '))
  }

  const files = collectDirectoryFiles(resolvedSource)
  const result = await importResources(workspaceRootPath, {
    version: 1,
    exportedAt: Date.now(),
    resources: { skills: [{ slug, files }] },
  }, 'skip')

  const failed = result.skills.failed[0]
  if (failed) throw new Error(failed.error)

  invalidateSkillsCache()
  const skill = loadSkill(workspaceRootPath, slug, workspaceRootPath)
  const name = skill?.metadata.name ?? slug
  if (result.skills.skipped.includes(slug)) return { status: 'skipped', slug, name }
  if (!result.skills.imported.includes(slug) || !skill) {
    throw new Error('The skill was copied but could not be loaded')
  }
  return { status: 'imported', slug, name }
}

export async function importSkillDirectories(
  workspaceRootPath: string,
  sourcePaths: string[],
  userHomePath = homedir(),
): Promise<SkillImportBatchResult> {
  const result: SkillImportBatchResult = { imported: [], skipped: [], failed: [] }
  const uniquePaths = [...new Set(sourcePaths.map(sourcePath => resolve(sourcePath)))]

  for (const sourcePath of uniquePaths.slice(0, MAX_DISCOVERED_SKILLS)) {
    if (!isPathWithinDirectory(sourcePath, userHomePath)) {
      result.failed.push({ sourcePath, error: 'Skill source must be inside the user home directory' })
      continue
    }
    try {
      const imported = await importSkillDirectory(workspaceRootPath, sourcePath)
      const summary = { slug: imported.slug, name: imported.name }
      if (imported.status === 'imported') result.imported.push(summary)
      else result.skipped.push(summary)
    } catch (error) {
      result.failed.push({
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Get all skills for a workspace. The optional workingDirectory argument is
  // accepted for older renderers but ignored: project-level skills are rooted
  // at workspace.rootPath under complete-unification semantics.
  server.handle(RPC_CHANNELS.skills.GET, async (ctx, workspaceId: string, _workingDirectory?: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    if (!wid) return []
    deps.platform.logger?.info(`SKILLS_GET: Loading skills for workspace: ${wid}`)
    const workspace = getWorkspaceOrNull(wid, deps.platform.logger, 'SKILLS_GET')
    if (!workspace) return []
    const { loadAllSkills } = await import('@mortise/shared/skills')
    const skills = loadAllSkills(workspace.rootPath, workspace.rootPath)
    deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} skills from ${workspace.rootPath}`)
    return skills
  })

  // Get files in a skill directory
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    if (!wid) return []
    const workspace = getWorkspaceOrNull(wid, deps.platform.logger, 'SKILLS_GET_FILES')
    if (!workspace) return []

    const skillDir = resolveSkillDir(skillSlug, workspace.rootPath, workspace.rootPath)
    if (!skillDir) {
      deps.platform.logger?.error(`SKILLS_GET_FILES: Skill not found: ${skillSlug}`)
      return []
    }

    function scanDirectory(dirPath: string): SkillFile[] {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter(entry => !entry.name.startsWith('.')) // Skip hidden files
          .map(entry => {
            const fullPath = join(dirPath, entry.name)
            if (entry.isDirectory()) {
              return {
                name: entry.name,
                type: 'directory' as const,
                children: scanDirectory(fullPath),
              }
            } else {
              const stats = statSync(fullPath)
              return {
                name: entry.name,
                type: 'file' as const,
                size: stats.size,
              }
            }
          })
          .sort((a, b) => {
            // Directories first, then files
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      } catch (err) {
        deps.platform.logger?.error(`SKILLS_GET_FILES: Error scanning ${dirPath}:`, err)
        return []
      }
    }

    return scanDirectory(skillDir)
  })

  server.handle(RPC_CHANNELS.skills.DISCOVER, async (ctx, workspaceId: string): Promise<DiscoveredSkill[]> => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    if (workspace.remoteServer) throw new Error('Skill discovery is not available for remote workspaces')
    const discovered = await discoverSkillsUnderHome(homedir(), workspace.rootPath)
    deps.platform.logger?.info(`SKILLS_DISCOVER: Found ${discovered.length} skills under the user home directory`)
    return discovered
  })

  server.handle(RPC_CHANNELS.skills.IMPORT, async (
    ctx,
    workspaceId: string,
    sourcePaths: string[],
  ): Promise<SkillImportBatchResult> => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    if (workspace.remoteServer) throw new Error('Skill import is not available for remote workspaces')
    if (!Array.isArray(sourcePaths)) throw new Error('Skill source paths must be an array')

    const importResult = await importSkillDirectories(workspace.rootPath, sourcePaths)
    for (const imported of importResult.imported) {
      deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `.pi/skills/${imported.slug}/SKILL.md`)
    }
    deps.platform.logger?.info(
      `SKILLS_IMPORT: ${importResult.imported.length} imported, ` +
      `${importResult.skipped.length} skipped, ${importResult.failed.length} failed`,
    )
    return importResult
  })

  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)

    const { deleteSkill } = await import('@mortise/shared/skills')
    deleteSkill(workspace.rootPath, skillSlug, workspace.rootPath)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
  })

  // Open skill SKILL.md in editor
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    if (workspace.remoteServer) throw new Error('Open in editor is not available for remote workspaces')

    const skillDir = resolveSkillDir(skillSlug, workspace.rootPath, workspace.rootPath)
    if (!skillDir) throw new Error('Skill not found')
    const skillFile = join(skillDir, 'SKILL.md')
    await deps.platform.openPath?.(skillFile)
  })

  // Open skill folder in Finder/Explorer
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    if (workspace.remoteServer) throw new Error('Show in Finder is not available for remote workspaces')

    const skillDir = resolveSkillDir(skillSlug, workspace.rootPath, workspace.rootPath)
    if (!skillDir) throw new Error('Skill not found')
    await deps.platform.showItemInFolder?.(skillDir)
  })
}
