import { basename, join, resolve } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { mkdir, readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { requirePrimaryLocalWorkspaceRoot } from '@mortise/core/types'
import { RPC_CHANNELS, type SkillFile } from '@mortise/shared/protocol'
import { validateSkillContent } from '@mortise/shared/config'
import { getPiAgentDir } from '@mortise/shared/config/pi-global-config'
import { MORTISE_PROJECT_SKILLS_DIR } from '@mortise/shared/config/paths'
import { atomicWriteFile } from '@mortise/shared/utils'
import { importResources } from '@mortise/shared/resources'
import {
  invalidateSkillsCache,
  loadSkill,
  resolveSkillDir,
  validateSkillSlug,
  type DiscoveredSkill,
  type LoadedSkill,
  type SaveSkillRequestV1,
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
  RPC_CHANNELS.skills.SAVE,
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
    ? join(resolve(workspaceRootPath), '.mortise', 'skills')
    : undefined
  const excludedGlobalSkillsRoot = join(getPiAgentDir(), 'skills')
  const discovered: DiscoveredSkill[] = []
  for (const skillsRoot of [...skillRoots].sort((a, b) => a.localeCompare(b))) {
    const excluded = (excludedWorkspaceSkillsRoot && isPathWithinDirectory(skillsRoot, excludedWorkspaceSkillsRoot))
      || isPathWithinDirectory(skillsRoot, excludedGlobalSkillsRoot)
    if (excluded) continue
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
  const globalSkillsRoot = join(getPiAgentDir(), 'skills')
  const result = await importResources(
    workspaceRootPath,
    {
      version: 3,
      exportedAt: Date.now(),
      resources: { skills: [{ slug, files }] },
    },
    'skip',
    workspaceRootPath,
    undefined,
    undefined,
    globalSkillsRoot,
  )

  const failed = result.skills.failed[0]
  if (failed) throw new Error(failed.error)

  invalidateSkillsCache()
  const skill = loadSkill('', slug)
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

export function validateSkillSaveRequest(request: SaveSkillRequestV1): {
  slug: string
  name: string
  description: string
  content: string
} {
  if (!request || request.schemaVersion !== 1) throw new Error('Unsupported skill save request')
  const slug = validateSkillSlug(request.slug)
  if (!slug) throw new Error('Skill slug must use lowercase letters, numbers, and hyphens')
  const name = request.name.trim()
  const description = request.description.trim()
  const content = request.content.trim()
  if (!name || name.length > 120) throw new Error('Skill name must be between 1 and 120 characters')
  if (description.length > 500) throw new Error('Skill description must be at most 500 characters')
  if (!content) throw new Error('Skill instructions cannot be empty')
  return { slug, name, description, content }
}

export async function writeSkillDefinition(
  skillsRoot: string,
  request: SaveSkillRequestV1,
): Promise<string> {
  const { slug, name, description, content } = validateSkillSaveRequest(request)
  const skillDir = join(skillsRoot, slug)
  await mkdir(skillDir, { recursive: true })
  const serialized = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    content,
    '',
  ].join('\n')
  const skillFile = join(skillDir, 'SKILL.md')
  await atomicWriteFile(skillFile, serialized)
  return skillFile
}

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.skills.GET, async (ctx, workspaceId?: string, ...unexpectedArgs: unknown[]) => {
    if (unexpectedArgs.length > 0) {
      throw new Error('skills:get accepts only an optional workspaceId')
    }
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    const { loadAllSkills } = await import('@mortise/shared/skills')
    if (!wid) {
      const skills = loadAllSkills()
      deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} global skills`)
      return skills
    }
    deps.platform.logger?.info(`SKILLS_GET: Loading effective skills for workspace: ${wid}`)
    const workspace = getWorkspaceOrNull(wid, deps.platform.logger, 'SKILLS_GET')
    if (!workspace) return []
    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)
    const skills = loadAllSkills(workspaceRoot, workspaceRoot)
    deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} skills from ${workspaceRoot}`)
    return skills
  })

  // Get files in a skill directory
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    if (!wid) return []
    const workspace = getWorkspaceOrNull(wid, deps.platform.logger, 'SKILLS_GET_FILES')
    if (!workspace) return []
    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)

    const skillDir = resolveSkillDir(skillSlug, workspaceRoot, workspaceRoot)
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
    const discovered = await discoverSkillsUnderHome(homedir(), requirePrimaryLocalWorkspaceRoot(workspace))
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
    if (!Array.isArray(sourcePaths)) throw new Error('Skill source paths must be an array')

    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)
    const importResult = await importSkillDirectories(workspaceRoot, sourcePaths)
    deps.platform.logger?.info(
      `SKILLS_IMPORT: ${importResult.imported.length} imported, ` +
      `${importResult.skipped.length} skipped, ${importResult.failed.length} failed`,
    )
    return importResult
  })

  server.handle(RPC_CHANNELS.skills.SAVE, async (
    ctx,
    request: SaveSkillRequestV1,
  ): Promise<LoadedSkill> => {
    const { slug } = validateSkillSaveRequest(request)

    let skillsRoot: string
    let workspaceRoot: string | undefined
    if (request.source === 'global') {
      skillsRoot = join(getPiAgentDir(), 'skills')
    } else if (request.source === 'project') {
      const wid = resolveWorkspaceId(ctx.workspaceId, request.workspaceId)
      if (!wid) throw new Error('A Workspace is required for a Workspace skill')
      const workspace = getWorkspaceOrThrow(wid)
      workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)
      skillsRoot = join(workspaceRoot, MORTISE_PROJECT_SKILLS_DIR)
    } else {
      throw new Error('Unknown skill source')
    }

    await writeSkillDefinition(skillsRoot, request)
    invalidateSkillsCache()

    if (workspaceRoot) {
      deps.sessionManager.notifyConfigFileChange(workspaceRoot, `${MORTISE_PROJECT_SKILLS_DIR}/${slug}/SKILL.md`)
    }
    const saved = loadSkill(workspaceRoot ?? '', slug, workspaceRoot)
    if (!saved) throw new Error('Skill was saved but could not be reloaded')
    deps.platform.logger?.info(`SKILLS_SAVE: Saved ${request.source} skill ${slug}`)
    return saved
  })

  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)

    const { deleteSkill } = await import('@mortise/shared/skills')
    deleteSkill(workspaceRoot, skillSlug, workspaceRoot)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
  })

  // Open skill SKILL.md in editor
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)

    const skillDir = resolveSkillDir(skillSlug, workspaceRoot, workspaceRoot)
    if (!skillDir) throw new Error('Skill not found')
    const skillFile = join(skillDir, 'SKILL.md')
    await deps.platform.openPath?.(skillFile)
  })

  // Open skill folder in Finder/Explorer
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(workspace)

    const skillDir = resolveSkillDir(skillSlug, workspaceRoot, workspaceRoot)
    if (!skillDir) throw new Error('Skill not found')
    await deps.platform.showItemInFolder?.(skillDir)
  })
}
