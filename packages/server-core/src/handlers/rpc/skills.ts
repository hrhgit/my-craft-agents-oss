import { join } from 'path'
import { readdirSync, statSync } from 'fs'
import { RPC_CHANNELS, type SkillFile } from '@craft-agent/shared/protocol'
import { resolveSkillDir } from '@craft-agent/shared/skills'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrNull, getWorkspaceOrThrow, resolveWorkspaceId } from '../utils'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
] as const

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
    const { loadAllSkills } = await import('@craft-agent/shared/skills')
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

  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (ctx, workspaceId: string, skillSlug: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)

    const { deleteSkill } = await import('@craft-agent/shared/skills')
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
