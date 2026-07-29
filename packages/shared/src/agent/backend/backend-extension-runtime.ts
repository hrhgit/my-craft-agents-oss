import { DefaultResourceLoader } from '@mortise/pi-coding-agent'
import { getPiAgentDir } from '../../config/pi-global-config.ts'
import { CONFIG_DIR, MORTISE_PROJECT_DIR } from '../../config/paths.ts'
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
  createLoader?: (input: { workspaceRoot: string; agentDir: string }) => ExtensionLoader
}

/** Backend-owned Extension discovery and optional state boundary. */
export class BackendExtensionRuntimeRegistry {
  readonly backendType: BackendType
  private readonly agentDir: string
  private readonly snapshots: BackendSnapshotStore
  private readonly createLoader: NonNullable<BackendExtensionRuntimeRegistryOptions['createLoader']>
  private readonly workspaces = new Map<string, BackendExtensionWorkspaceSnapshot>()
  private readonly opening = new Map<string, Promise<BackendExtensionWorkspaceSnapshot>>()

  constructor(options: BackendExtensionRuntimeRegistryOptions) {
    this.backendType = options.backendType
    this.agentDir = options.agentDir ?? getPiAgentDir()
    this.snapshots = new BackendSnapshotStore(options.snapshotRoot ?? `${CONFIG_DIR}/backend-snapshots`)
    this.createLoader = options.createLoader ?? (({ workspaceRoot, agentDir }) => new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir,
      projectConfigDir: MORTISE_PROJECT_DIR,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    }))
  }

  openWorkspace(workspaceId: string, workspaceRoot: string): Promise<BackendExtensionWorkspaceSnapshot> {
    const existing = this.workspaces.get(workspaceId)
    if (existing) return Promise.resolve(structuredClone(existing))
    const pending = this.opening.get(workspaceId)
    if (pending) return pending.then(snapshot => structuredClone(snapshot))

    const opening = this.loadWorkspace(workspaceId, workspaceRoot).finally(() => {
      this.opening.delete(workspaceId)
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
    this.workspaces.clear()
    this.opening.clear()
  }

  private async loadWorkspace(
    workspaceId: string,
    workspaceRoot: string,
  ): Promise<BackendExtensionWorkspaceSnapshot> {
    const loader = this.createLoader({ workspaceRoot, agentDir: this.agentDir })
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
    this.workspaces.set(workspaceId, snapshot)
    return snapshot
  }
}

export function backendTypeFromProcess(kind = process.env.MORTISE_BACKEND_KIND): BackendType {
  return kind === 'electron' ? 'electron' : 'webui'
}
