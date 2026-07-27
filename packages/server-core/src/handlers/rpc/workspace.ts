import { existsSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { CONFIG_DIR, getWorkspaceByNameOrId, addWorkspace, setActiveWorkspace } from '@mortise/shared/config'
import type { Workspace, WorkspaceLocationInfo } from '@mortise/core/types'
import {
  getDefaultWorkspaceTopologyStore,
  readWorkspaceMarker,
  type LegacyWorkspaceV1,
  type WorkspaceTopologyStore,
} from '@mortise/shared/workspaces'
import { perf } from '@mortise/shared/utils'
import { pushTyped, type RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { isValidWorkspaceRootPath } from '../../utils/path-validation'
import { getWorkspaceOrThrow } from '../utils'
import {
  ensureWorkspaceTopology,
  registerWorkspaceTopologyHandlers,
  WORKSPACE_TOPOLOGY_HANDLED_CHANNELS,
} from './workspace-topology'

function redactPrimaryLocation(workspace: Workspace): WorkspaceLocationInfo {
  const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)!
  return {
    id: primary.id,
    name: primary.name,
    endpoint: primary.endpoint.kind === 'local'
      ? { kind: 'local' }
      : {
          kind: 'remote',
          url: primary.endpoint.url,
          remoteWorkspaceId: primary.endpoint.remoteWorkspaceId,
          ...(primary.endpoint.allowInsecureTls === undefined
            ? {}
            : { allowInsecureTls: primary.endpoint.allowInsecureTls }),
        },
  }
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const nested = relative(rootPath, candidatePath)
  return nested === ''
    || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
}

export const CORE_HANDLED_CHANNELS = [
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.workspaces.CREATE,
  RPC_CHANNELS.workspaces.CHECK_SLUG,
  RPC_CHANNELS.workspaces.UPDATE_REMOTE,
  RPC_CHANNELS.window.GET_WORKSPACE,
  RPC_CHANNELS.window.GET_MODE,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  RPC_CHANNELS.workspace.READ_IMAGE,
  RPC_CHANNELS.workspace.WRITE_IMAGE,
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.LOAD_PRESET,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.SET_COLOR_THEME,
  RPC_CHANNELS.theme.BROADCAST_PREFERENCES,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME,
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,
  ...WORKSPACE_TOPOLOGY_HANDLED_CHANNELS,
] as const

export function registerWorkspaceCoreHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  topologyStore: WorkspaceTopologyStore = getDefaultWorkspaceTopologyStore(),
): void {
  const { sessionManager } = deps
  const windowManager = deps.windowManager
  registerWorkspaceTopologyHandlers(server, deps, topologyStore)

  const resolveWorkspace = (workspaceId: string): Workspace => {
    const candidate = sessionManager.getWorkspaces().find(workspace => workspace.id === workspaceId)
      ?? getWorkspaceOrThrow(workspaceId)
    ensureWorkspaceTopology(topologyStore, candidate)
    const workspace = topologyStore.get(workspaceId)
    if (!workspace) throw new Error(`Workspace topology not found: ${workspaceId}`)
    return workspace
  }

  const requireLocalPrimaryRoot = (workspaceId: string): string => {
    const workspace = resolveWorkspace(workspaceId)
    const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)!
    if (primary.endpoint.kind !== 'local') {
      throw new Error(`Workspace ${workspaceId} has a remote primary location`)
    }
    readWorkspaceMarker(primary.endpoint.rootPath, workspaceId)
    return primary.endpoint.rootPath
  }

  // Client projections never expose local paths or credential references.
  server.handle(RPC_CHANNELS.workspaces.GET, async () => {
    return sessionManager.getWorkspaces().map(candidate => ensureWorkspaceTopology(topologyStore, candidate))
  })

  // Create a new workspace at a folder path (Obsidian-style: folder IS the workspace)
  server.handle(RPC_CHANNELS.workspaces.CREATE, async (_ctx, folderPath: string, name: string, remoteServer?: { url: string; token: string; remoteWorkspaceId: string }) => {
    const rootPath = folderPath.trim()
    const validation = isValidWorkspaceRootPath(rootPath)
    if (!validation.valid) {
      throw new Error(validation.reason!)
    }

    if (remoteServer) {
      throw new Error('Remote Workspace creation requires the credential-backed remote connection flow')
    }
    // The registry owner still publishes the initial identity. Topology becomes
    // authoritative immediately and all later location changes bypass that
    // legacy single-root record.
    const candidate = addWorkspace({ name, rootPath } as never) as unknown as LegacyWorkspaceV1
    const workspace = ensureWorkspaceTopology(topologyStore, candidate)
    // Make it active
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${name}" at ${rootPath}`)
    return workspace
  })

  // Check if a workspace slug already exists (for validation before creation)
  server.handle(RPC_CHANNELS.workspaces.CHECK_SLUG, async (_ctx, slug: string) => {
    const defaultWorkspacesDir = join(CONFIG_DIR, 'workspaces')
    const workspacePath = join(defaultWorkspacesDir, slug)
    const exists = existsSync(workspacePath)
    return { exists, path: workspacePath }
  })

  // Update remote server config for an existing workspace (reconnect flow)
  server.handle(RPC_CHANNELS.workspaces.UPDATE_REMOTE, async () => {
    throw new Error('workspaces:updateRemote is retired; use a revisioned Workspace topology command')
  })

  // Get workspace ID for the calling window
  server.handle(RPC_CHANNELS.window.GET_WORKSPACE, (ctx) => {
    const workspaceId = ctx.workspaceId ?? windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    // Set up ConfigWatcher for live workspace updates.
    if (workspaceId) {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (workspace) {
        const topology = resolveWorkspace(workspaceId)
        const primary = topology.locations.find(location => location.id === topology.primaryLocationId)
        if (primary?.endpoint.kind === 'local') {
          sessionManager.setupConfigWatcher(primary.endpoint.rootPath, workspaceId)
        }
      }
    }
    return workspaceId
  })

  // Get mode for the calling window (always 'main' now)
  server.handle(RPC_CHANNELS.window.GET_MODE, () => {
    return 'main'
  })

  // Switch workspace in current window (in-window switching)
  server.handle(RPC_CHANNELS.window.SWITCH_WORKSPACE, async (ctx, workspaceId: string) => {
    const end = perf.start('ipc.switchWorkspace', { workspaceId })
    const workspace = resolveWorkspace(workspaceId)

    if (windowManager) {
      const wcId = ctx.webContentsId!

      // Get the old workspace ID before updating
      const oldWorkspaceId = windowManager.getWorkspaceForWindow(wcId)

      // Update the window's workspace mapping
      const updated = await windowManager.updateWindowWorkspace(wcId, workspaceId)

      // If update failed, the window may have been re-created (e.g., after refresh)
      // Try to register it
      if (!updated) {
        const win = windowManager.getWindowByWebContentsId(wcId)
        if (win) {
          windowManager.registerWindow(win, workspaceId)
          deps.platform.logger.info(`Re-registered window ${wcId} for workspace ${workspaceId}`)
        }
      }

      // Clear activeViewingSession for old workspace if no other windows are viewing it
      // This ensures read/unread state is correct after workspace switch
      if (oldWorkspaceId && oldWorkspaceId !== workspaceId) {
        const otherWindows = windowManager.getAllWindowsForWorkspace(oldWorkspaceId)
        if (otherWindows.length === 0) {
          sessionManager.clearActiveViewingSession(oldWorkspaceId)
        }
      }
    }

    // Commit push routing only after the desktop window has flushed and
    // redocked every auxiliary. A failed close handshake leaves both the
    // renderer and transport on the original workspace.
    await server.updateClientWorkspace?.(ctx.clientId, workspaceId)

    // Keep the cold-start fallback aligned with the last successful in-window
    // switch. Normal quits restore window-state.json first, but that snapshot
    // can legitimately be empty after every window has already closed.
    setActiveWorkspace(workspaceId)

    // Set up ConfigWatcher for the new workspace
    const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)!
    if (primary.endpoint.kind === 'local') {
      sessionManager.setupConfigWatcher(primary.endpoint.rootPath, workspaceId)
    }
    end()

    // Return connection details so the preload RoutedClient can decide
    // whether to connect directly to a remote server for this workspace.
    return {
      workspaceId,
      primaryLocation: redactPrimaryLocation(workspace),
    }
  })

  // ============================================================
  // Workspace Image Read/Write
  // ============================================================

  // Generic workspace image loading (for source icons, status icons, etc.)
  server.handle(RPC_CHANNELS.workspace.READ_IMAGE, async (_ctx, workspaceId: string, relativePath: string) => {
    const rootPath = requireLocalPrimaryRoot(workspaceId)

    const { readFileSync, existsSync } = await import('fs')
    const { join, normalize } = await import('path')

    // Security: validate path
    // - Must not contain .. (path traversal)
    // - Must be a valid image extension
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif']

    if (relativePath.includes('..')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root
    const absolutePath = normalize(join(rootPath, relativePath))

    // Double-check the resolved path is still within workspace
    if (!isInsideRoot(rootPath, absolutePath)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    if (!existsSync(absolutePath)) {
      return null  // Missing optional files - silent fallback to default icons
    }

    // Read file as buffer
    const buffer = readFileSync(absolutePath)

    // If SVG, return as UTF-8 string (caller will use as innerHTML)
    if (ext === '.svg') {
      return buffer.toString('utf-8')
    }

    // For binary images, return as data URL
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.gif': 'image/gif',
    }
    const mimeType = mimeTypes[ext] || 'image/png'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  })

  // Generic workspace image writing (for workspace icon, etc.)
  // Resizes images to max 256x256 to keep file sizes small
  server.handle(RPC_CHANNELS.workspace.WRITE_IMAGE, async (_ctx, workspaceId: string, relativePath: string, base64: string, mimeType: string) => {
    const rootPath = requireLocalPrimaryRoot(workspaceId)

    const { writeFileSync, existsSync, unlinkSync, readdirSync } = await import('fs')
    const { join, normalize, basename } = await import('path')

    // Security: validate path
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']

    if (relativePath.includes('..')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root
    const absolutePath = normalize(join(rootPath, relativePath))

    // Double-check the resolved path is still within workspace
    if (!isInsideRoot(rootPath, absolutePath)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    // If this is an icon file (icon.*), delete any existing icon files with different extensions
    const fileName = basename(relativePath)
    if (fileName.startsWith('icon.')) {
      const files = readdirSync(rootPath)
      for (const file of files) {
        if (file.startsWith('icon.') && file !== fileName) {
          const oldPath = join(rootPath, file)
          try {
            unlinkSync(oldPath)
          } catch {
            // Ignore errors deleting old icon
          }
        }
      }
    }

    // Decode base64 to buffer
    const buffer = Buffer.from(base64, 'base64')

    // For SVGs, just write directly (no resizing needed)
    if (mimeType === 'image/svg+xml' || ext === '.svg') {
      writeFileSync(absolutePath, buffer)
      return
    }

    // For raster images, resize to max 256x256
    const metadata = await deps.platform.imageProcessor.getMetadata(buffer)
    const width = metadata?.width ?? 0
    const height = metadata?.height ?? 0

    // Only resize if larger than 256px
    if (width > 256 || height > 256) {
      const resized = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 256, height: 256 },
        format: 'png',
      })
      writeFileSync(absolutePath, resized)
    } else {
      // Small enough, write as-is
      writeFileSync(absolutePath, buffer)
    }
  })

  // ============================================================
  // Theme (app-level only)
  // ============================================================

  server.handle(RPC_CHANNELS.theme.GET_APP, async () => {
    const { loadAppTheme } = await import('@mortise/shared/config/storage')
    return loadAppTheme()
  })

  // Preset themes (app-level)
  server.handle(RPC_CHANNELS.theme.GET_PRESETS, async () => {
    const { loadPresetThemes } = await import('@mortise/shared/config/storage')
    return loadPresetThemes()
  })

  server.handle(RPC_CHANNELS.theme.LOAD_PRESET, async (_ctx, themeId: string) => {
    const { loadPresetTheme } = await import('@mortise/shared/config/storage')
    return loadPresetTheme(themeId)
  })

  server.handle(RPC_CHANNELS.theme.GET_COLOR_THEME, async () => {
    const { getColorTheme } = await import('@mortise/shared/config/storage')
    return getColorTheme()
  })

  server.handle(RPC_CHANNELS.theme.SET_COLOR_THEME, async (_ctx, themeId: string) => {
    const { setColorTheme } = await import('@mortise/shared/config/storage')
    setColorTheme(themeId)
  })

  // Broadcast theme preferences to all other windows (for cross-window sync)
  server.handle(RPC_CHANNELS.theme.BROADCAST_PREFERENCES, async (ctx, preferences: { mode: string; colorTheme: string; font: string }) => {
    pushTyped(server, RPC_CHANNELS.theme.PREFERENCES_CHANGED, { to: 'all' }, preferences)
  })

  // Workspace-level theme overrides
  server.handle(RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME, async (_ctx, workspaceId: string) => {
    const { getWorkspaceColorTheme } = await import('@mortise/shared/workspaces/storage')
    return getWorkspaceColorTheme(requireLocalPrimaryRoot(workspaceId)) ?? null
  })

  server.handle(RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME, async (_ctx, workspaceId: string, themeId: string | null) => {
    const { setWorkspaceColorTheme } = await import('@mortise/shared/workspaces/storage')
    setWorkspaceColorTheme(requireLocalPrimaryRoot(workspaceId), themeId ?? undefined)
  })

  server.handle(RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES, async () => {
    const { getWorkspaceColorTheme } = await import('@mortise/shared/workspaces/storage')
    const themes: Record<string, string | undefined> = {}
    for (const workspace of sessionManager.getWorkspaces()) {
      const topology = resolveWorkspace(workspace.id)
      const primary = topology.locations.find(location => location.id === topology.primaryLocationId)!
      themes[workspace.id] = primary.endpoint.kind === 'local'
        ? getWorkspaceColorTheme(primary.endpoint.rootPath)
        : undefined
    }
    return themes
  })

  // Broadcast workspace theme change to all other windows (for cross-window sync)
  server.handle(RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME, async (ctx, workspaceId: string, themeId: string | null) => {
    pushTyped(server, RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED, { to: 'all' }, { workspaceId, themeId })
  })

  // ============================================================
  // Tool Icons and Logo
  // ============================================================

  // Tool icon mappings — loads tool-icons.json and resolves each entry's icon to a data URL
  // for display in the Appearance settings page
  server.handle(RPC_CHANNELS.toolIcons.GET_MAPPINGS, async () => {
    const { getToolIconsDir } = await import('@mortise/shared/config/storage')
    const { loadToolIconConfig } = await import('@mortise/shared/utils/cli-icon-resolver')
    const { encodeIconToDataUrl } = await import('@mortise/shared/utils/icon-encoder')
    const { join } = await import('path')

    const toolIconsDir = getToolIconsDir()
    const config = loadToolIconConfig(toolIconsDir)
    if (!config) return []

    return config.tools
      .map(tool => {
        const iconPath = join(toolIconsDir, tool.icon)
        const iconDataUrl = encodeIconToDataUrl(iconPath)
        if (!iconDataUrl) return null
        return {
          id: tool.id,
          displayName: tool.displayName,
          iconDataUrl,
          commands: tool.commands,
        }
      })
      .filter(Boolean)
  })

  // Logo URL resolution (uses Node.js filesystem cache for provider domains)
}
