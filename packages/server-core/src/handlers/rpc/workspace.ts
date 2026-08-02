import { existsSync, statSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  RPC_CHANNELS,
  WORKSPACE_CREATION_SCHEMA_VERSION,
  parseWorkspaceCreationRequestV1,
  type WorkspaceCreationResultV1,
} from '@mortise/shared/protocol'
import { CONFIG_DIR, addWorkspace, setActiveWorkspace } from '@mortise/shared/config'
import type { Workspace, WorkspaceNameSource } from '@mortise/core/types'
import {
  getDefaultWorkspaceTopologyStore,
  generateUniqueWorkspacePath,
  getDefaultWorkspacesDir,
  readWorkspaceMarker,
  readWorkspaceMarkerIfPresent,
  type WorkspaceTopologyStore,
} from '@mortise/shared/workspaces'
import { perf } from '@mortise/shared/utils'
import { pushTyped, type RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { isValidWorkspaceRootPath } from '../../utils/path-validation'
import {
  ensureWorkspaceTopology,
  registerWorkspaceTopologyHandlers,
  WORKSPACE_TOPOLOGY_HANDLED_CHANNELS,
} from './workspace-topology'
import {
  registerWorkspaceTransferHandlers,
  WORKSPACE_TRANSFER_HANDLED_CHANNELS,
} from './workspace-transfer'

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const nested = relative(rootPath, candidatePath)
  return nested === ''
    || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
}

export const CORE_HANDLED_CHANNELS = [
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.workspaces.CREATE,
  RPC_CHANNELS.workspaces.CHECK_SLUG,
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
  ...WORKSPACE_TRANSFER_HANDLED_CHANNELS,
] as const

export function registerWorkspaceCoreHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  topologyStore: WorkspaceTopologyStore = getDefaultWorkspaceTopologyStore(),
): void {
  const { sessionManager } = deps
  const windowManager = deps.windowManager
  registerWorkspaceTopologyHandlers(server, deps, topologyStore)
  registerWorkspaceTransferHandlers(server, topologyStore)

  const resolveWorkspace = (workspaceId: string): Workspace => {
    const current = topologyStore.get(workspaceId)
    if (current) return current
    const candidate = sessionManager.getWorkspaces().find(workspace => workspace.id === workspaceId)
    if (!candidate) throw new Error(`Workspace not found: ${workspaceId}`)
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

  server.handle(RPC_CHANNELS.workspaces.CREATE, async (_ctx, requestValue: unknown): Promise<WorkspaceCreationResultV1> => {
    const request = parseWorkspaceCreationRequestV1(requestValue)
    const customName = request.name?.trim() || null
    const selectedRoots = request.locations.map(location => resolve(location.rootPath.trim()))
    const rootKeys = new Set<string>()
    for (const rootPath of selectedRoots) {
      const validation = isValidWorkspaceRootPath(rootPath)
      if (!validation.valid) throw new Error(validation.reason!)
      if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
        throw new Error(`Workspace location must be an existing folder: ${rootPath}`)
      }
      const key = process.platform === 'win32' ? rootPath.toLocaleLowerCase('en-US') : rootPath
      if (rootKeys.has(key)) throw new Error(`Workspace locations cannot contain the same folder twice: ${rootPath}`)
      rootKeys.add(key)
    }

    const markers = selectedRoots.map(rootPath => readWorkspaceMarkerIfPresent(rootPath))
    const registeredRoots = new Set(topologyStore.list().flatMap(workspace => workspace.locations.flatMap(location => (
      location.endpoint.kind === 'local'
        ? [process.platform === 'win32'
            ? resolve(location.endpoint.rootPath).toLocaleLowerCase('en-US')
            : resolve(location.endpoint.rootPath)]
        : []
    ))))
    selectedRoots.forEach((rootPath, index) => {
      const key = process.platform === 'win32' ? rootPath.toLocaleLowerCase('en-US') : rootPath
      if (markers[index] === null && registeredRoots.has(key)) {
        throw new Error(`Workspace location is already attached to another Workspace: ${rootPath}`)
      }
    })
    const markerIds = new Set(markers.flatMap(marker => marker ? [marker.workspaceId] : []))
    if (markerIds.size > 1) throw new Error('Selected folders belong to different Workspaces')
    if (markerIds.size === 1) {
      if (markers.some(marker => marker === null)) {
        throw new Error('Cannot combine an existing Workspace with unassociated folders during reconnection')
      }
      const workspaceId = [...markerIds][0]!
      const restored = topologyStore.restore(workspaceId)
      await deps.sessionManager.openWorkspaceExtensions?.(restored)
      setActiveWorkspace(restored.id)
      const workspace = topologyStore.getInfo(restored.id)
      if (!workspace) throw new Error(`Workspace topology not found after restoration: ${restored.id}`)
      deps.platform.logger.info(`Reconnected workspace "${restored.name}" from ${selectedRoots[0]}`)
      return { schemaVersion: WORKSPACE_CREATION_SCHEMA_VERSION, action: 'reconnected', workspace }
    }

    const generatedRoot = selectedRoots.length === 0
      ? generateUniqueWorkspacePath(customName ?? 'My Workspace', getDefaultWorkspacesDir())
      : null
    const roots = generatedRoot ? [generatedRoot] : selectedRoots
    const primaryLocationIndex = generatedRoot ? 0 : request.primaryLocationIndex ?? 0
    const primaryRootName = basename(roots[primaryLocationIndex]!)
    const workspaceName = customName ?? primaryRootName
    const nameSource: WorkspaceNameSource = customName ? 'custom' : 'derived'
    const usedNames = new Set<string>()
    const locations = roots.map((rootPath, index) => {
      const rootName = basename(rootPath)
      let locationName = rootName
      let suffix = 2
      while (usedNames.has(locationName.toLocaleLowerCase('en-US'))) {
        locationName = `${rootName} ${suffix++}`
      }
      usedNames.add(locationName.toLocaleLowerCase('en-US'))
      return {
        id: index === primaryLocationIndex ? 'primary' : `location-${index + 1}`,
        name: locationName,
        rootName,
        endpoint: { kind: 'local' as const, rootPath },
      }
    })
    const candidate = addWorkspace({
      schemaVersion: 2,
      revision: 0,
      name: workspaceName,
      nameSource,
      primaryLocationId: 'primary',
      locations: locations as [typeof locations[number], ...(typeof locations[number])[]],
    })
    const workspace = ensureWorkspaceTopology(topologyStore, candidate)
    // Client projections hide local paths; the extension runtime must receive the canonical record.
    await deps.sessionManager.openWorkspaceExtensions?.(candidate)
    // Make it active
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${workspaceName}" with ${locations.length} location(s)`)
    return { schemaVersion: WORKSPACE_CREATION_SCHEMA_VERSION, action: 'created', workspace }
  })

  // Check if a workspace slug already exists (for validation before creation)
  server.handle(RPC_CHANNELS.workspaces.CHECK_SLUG, async (_ctx, slug: string) => {
    const defaultWorkspacesDir = join(CONFIG_DIR, 'workspaces')
    const workspacePath = join(defaultWorkspacesDir, slug)
    const exists = existsSync(workspacePath)
    return { exists, path: workspacePath }
  })

  // Get workspace ID for the calling window
  server.handle(RPC_CHANNELS.window.GET_WORKSPACE, (ctx) => {
    const workspaceId = ctx.workspaceId ?? windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    // Set up ConfigWatcher for live workspace updates.
    if (workspaceId) {
      const topology = resolveWorkspace(workspaceId)
      const primary = topology.locations.find(location => location.id === topology.primaryLocationId)
      if (primary?.endpoint.kind === 'local') {
        sessionManager.setupConfigWatcher(primary.endpoint.rootPath, workspaceId)
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
      primaryLocation: topologyStore.getInfo(workspaceId)!.locations.find(
        location => location.id === workspace.primaryLocationId,
      )!,
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
