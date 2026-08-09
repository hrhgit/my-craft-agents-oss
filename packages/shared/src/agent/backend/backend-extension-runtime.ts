import { existsSync } from 'node:fs'
import { DefaultResourceLoader } from '@mortise/pi-coding-agent'
import { getPiAgentDir } from '../../config/pi-global-config.ts'
import { CONFIG_DIR, MORTISE_PROJECT_DIR } from '../../config/paths.ts'
import { writeRuntimeLog } from '../../utils/runtime-log.ts'
import {
  BackendSnapshotStore,
  type SnapshotValidator,
} from '../../storage/backend-snapshot-store.ts'
import type { BackendType } from '../../protocol/capabilities.ts'

interface ExtensionLoader {
  reload(options?: { phase?: 'full' }): Promise<void>
  getExtensions(): {
    extensions: Array<{ id: string; path: string; resolvedPath: string }>
    errors: Array<{ path: string; error: string }>
  }
}

export interface BackendExtensionGlobalSnapshot {
  loadedAt: number
  extensions: Array<{ id: string; path: string; resolvedPath: string }>
  failures: Array<{ path: string; error: string }>
}

export interface BackendExtensionWorkspaceSnapshot {
  workspaceId: string
  workspaceRoot: string
  loadedAt: number
  extensions: Array<{ id: string; path: string; resolvedPath: string }>
  failures: Array<{ path: string; error: string }>
}

export interface BackendExtensionRuntimeRegistryOptions {
  backendType: BackendType
  agentDir?: string
  snapshotRoot?: string
  bundledExtensionPaths?: string[]
  createLoader?: (input: {
    workspaceRoot: string
    agentDir: string
    scope: 'global' | 'workspace'
    additionalExtensionPaths: string[]
  }) => ExtensionLoader
}

/** Backend-owned Extension discovery and optional state boundary. */
export class BackendExtensionRuntimeRegistry {
  readonly backendType: BackendType
  private readonly agentDir: string
  private readonly bundledExtensionPaths?: string[]
  private readonly snapshots: BackendSnapshotStore
  private readonly createLoader: NonNullable<BackendExtensionRuntimeRegistryOptions['createLoader']>
  private readonly workspaces = new Map<string, BackendExtensionWorkspaceSnapshot>()
  private readonly opening = new Map<string, Promise<BackendExtensionWorkspaceSnapshot>>()
  private globalSnapshot: BackendExtensionGlobalSnapshot | null = null
  private globalSnapshotSourceKey = ''
  private globalOpening: { sourceKey: string; promise: Promise<BackendExtensionGlobalSnapshot> } | null = null
  private globalLoadGeneration = 0
  /** Invalidates in-flight loads when an explicit reload replaces the registry. */
  private generation = 0

  constructor(options: BackendExtensionRuntimeRegistryOptions) {
    this.backendType = options.backendType
    this.agentDir = options.agentDir ?? getPiAgentDir()
    this.bundledExtensionPaths = options.bundledExtensionPaths
    this.snapshots = new BackendSnapshotStore(options.snapshotRoot ?? `${CONFIG_DIR}/backend-snapshots`)
    this.createLoader = options.createLoader ?? (({ workspaceRoot, agentDir, additionalExtensionPaths }) => new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir,
      projectConfigDir: MORTISE_PROJECT_DIR,
      additionalExtensionPaths,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    }))
  }

  /** Load global extensions once per host process before any Workspace load. */
  openGlobal(): Promise<BackendExtensionGlobalSnapshot> {
    const bundledExtensionPaths = this.resolveBundledExtensionPaths()
    const sourceKey = bundledExtensionPaths
      .map(path => `${path}\0${existsSync(path) ? 'present' : 'missing'}`)
      .join('\0')
    if (this.globalSnapshot && this.globalSnapshotSourceKey === sourceKey) {
      return Promise.resolve(structuredClone(this.globalSnapshot))
    }
    if (this.globalOpening?.sourceKey === sourceKey) {
      return this.globalOpening.promise.then(snapshot => structuredClone(snapshot))
    }

    const loadGeneration = ++this.globalLoadGeneration
    const opening = this.loadGlobal(this.generation, loadGeneration, sourceKey, bundledExtensionPaths).finally(() => {
      if (this.globalOpening?.promise === opening) this.globalOpening = null
    })
    this.globalOpening = { sourceKey, promise: opening }
    return opening.then(snapshot => structuredClone(snapshot))
  }

  getGlobalSnapshot(): BackendExtensionGlobalSnapshot | null {
    return this.globalSnapshot ? structuredClone(this.globalSnapshot) : null
  }

  openWorkspace(workspaceId: string, workspaceRoot: string): Promise<BackendExtensionWorkspaceSnapshot> {
    const existing = this.workspaces.get(workspaceId)
    if (existing) return Promise.resolve(structuredClone(existing))
    const pending = this.opening.get(workspaceId)
    if (pending) return pending.then(snapshot => structuredClone(snapshot))

    const opening = this.loadWorkspace(workspaceId, workspaceRoot, this.generation).finally(() => {
      if (this.opening.get(workspaceId) === opening) this.opening.delete(workspaceId)
    })
    this.opening.set(workspaceId, opening)
    return opening.then(snapshot => structuredClone(snapshot))
  }

  closeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId)
  }

  getWorkspaceSnapshot(workspaceId: string): BackendExtensionWorkspaceSnapshot | null {
    const snapshot = this.workspaces.get(workspaceId)
    return snapshot ? structuredClone(snapshot) : null
  }

  getOpenWorkspaceIds(): string[] {
    return [...this.workspaces.keys()]
  }

  readExtensionState<T>(
    workspaceId: string,
    extensionId: string,
    validate: SnapshotValidator<T>,
  ): T | null {
    return this.snapshots.read({
      kind: 'extension-state',
      workspaceId,
      backendType: this.backendType,
      extensionId,
    }, validate)
  }

  writeExtensionState<T>(
    workspaceId: string,
    extensionId: string,
    state: T,
    validate: SnapshotValidator<T>,
  ): Promise<void> {
    return this.snapshots.write({
      kind: 'extension-state',
      workspaceId,
      backendType: this.backendType,
      extensionId,
    }, state, validate)
  }

  clear(): void {
    this.generation += 1
    this.workspaces.clear()
    this.opening.clear()
    this.globalSnapshot = null
    this.globalSnapshotSourceKey = ''
    this.globalOpening = null
    this.globalLoadGeneration += 1
  }

  private resolveBundledExtensionPaths(): string[] {
    if (this.bundledExtensionPaths) return [...this.bundledExtensionPaths]
    return [process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH].filter(
      (value): value is string => Boolean(value),
    )
  }

  private async loadWorkspace(
    workspaceId: string,
    workspaceRoot: string,
    generation: number,
  ): Promise<BackendExtensionWorkspaceSnapshot> {
    await this.openGlobal()
    const loader = this.createLoader({
      workspaceRoot,
      agentDir: this.agentDir,
      scope: 'workspace',
      additionalExtensionPaths: [],
    })
    let extensions: BackendExtensionWorkspaceSnapshot['extensions'] = []
    let failures: BackendExtensionWorkspaceSnapshot['failures'] = []
    try {
      await loader.reload({ phase: 'full' })
      const result = loader.getExtensions()
      extensions = result.extensions.map(extension => ({
        id: extension.id,
        path: extension.path,
        resolvedPath: extension.resolvedPath,
      }))
      failures = result.errors.map(error => ({ ...error }))
    } catch (error) {
      failures = [{
        path: workspaceRoot,
        error: error instanceof Error ? error.message : String(error),
      }]
    }
    const snapshot = { workspaceId, workspaceRoot, loadedAt: Date.now(), extensions, failures }
    if (generation === this.generation) this.workspaces.set(workspaceId, snapshot)
    return snapshot
  }

  private async loadGlobal(
    generation: number,
    loadGeneration: number,
    sourceKey: string,
    bundledExtensionPaths: string[],
  ): Promise<BackendExtensionGlobalSnapshot> {
    const loader = this.createLoader({
      workspaceRoot: this.agentDir,
      agentDir: this.agentDir,
      scope: 'global',
      additionalExtensionPaths: bundledExtensionPaths,
    })
    let extensions: BackendExtensionGlobalSnapshot['extensions'] = []
    let failures: BackendExtensionGlobalSnapshot['failures'] = []
    try {
      await loader.reload({ phase: 'full' })
      const result = loader.getExtensions()
      extensions = result.extensions.map(extension => ({
        id: extension.id,
        path: extension.path,
        resolvedPath: extension.resolvedPath,
      }))
      failures = result.errors.map(error => ({ ...error }))
    } catch (error) {
      failures = [{
        path: this.agentDir,
        error: error instanceof Error ? error.message : String(error),
      }]
    }
    const snapshot = { loadedAt: Date.now(), extensions, failures }
    writeRuntimeLog(failures.length > 0 ? 'warn' : 'info', {
      scope: 'extension-runtime',
      event: 'global.discovery.completed',
      meta: {
        backendType: this.backendType,
        sourcePaths: bundledExtensionPaths,
        extensionIds: extensions.map(extension => extension.id),
        failures,
      },
    })
    if (generation === this.generation && loadGeneration === this.globalLoadGeneration) {
      this.globalSnapshot = snapshot
      this.globalSnapshotSourceKey = sourceKey
    }
    return snapshot
  }
}

export function backendTypeFromProcess(kind = process.env.MORTISE_BACKEND_KIND): BackendType {
  return kind === 'electron' ? 'electron' : 'webui'
}
