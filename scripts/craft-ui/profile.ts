import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CraftUiProfileMode } from './protocol.ts'

const EXCLUDED_NAMES = new Set([
  '.server.lock', '.workspace-server.lock', 'logs', 'node_modules', 'cache', 'Cache',
  'Code Cache', 'GPUCache', 'Crashpad', 'window-state.json',
])

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

export interface PreparedCraftUiProfile {
  root: string
  craftConfigDir: string
  piAgentDir: string
  electronUserDataDir: string
  mode: CraftUiProfileMode
  containsClonedUserData: boolean
}

function redirectClonedWorkspaceRoots(craftConfigDir: string, profileRoot: string): void {
  const configPath = join(craftConfigDir, 'config.json')
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

export function prepareProfile(args: {
  profileDir: string
  mode: CraftUiProfileMode
  sourceCraftConfigDir?: string
  sourcePiAgentDir?: string
}): PreparedCraftUiProfile {
  const root = resolve(args.profileDir)
  const craftConfigDir = join(root, 'craft-config')
  const piAgentDir = join(root, 'pi-agent')
  const electronUserDataDir = join(root, 'electron-user-data')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  if (args.mode === 'clone') {
    copyProfileTree(resolve(args.sourceCraftConfigDir ?? process.env.CRAFT_CONFIG_DIR ?? join(homedir(), '.craft-agent')), craftConfigDir)
    copyProfileTree(resolve(args.sourcePiAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')), piAgentDir)
    redirectClonedWorkspaceRoots(craftConfigDir, root)
  }
  mkdirSync(craftConfigDir, { recursive: true })
  mkdirSync(piAgentDir, { recursive: true })
  mkdirSync(electronUserDataDir, { recursive: true })
  return { root, craftConfigDir, piAgentDir, electronUserDataDir, mode: args.mode, containsClonedUserData: args.mode === 'clone' }
}
