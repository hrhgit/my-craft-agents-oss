interface RuntimeIdentity {
  kind: 'local' | 'remote'
  url?: string
  token?: string
  targetWorkspaceId?: string
  allowInsecureTls?: boolean
}

export interface ResolvedRemoteWorkspaceRuntime {
  url: string
  token: string
  remoteWorkspaceId: string
  allowInsecureTls?: boolean
}

interface RuntimeGenerationEntry {
  identity: RuntimeIdentity
  generation: string
}

/**
 * Maps sensitive runtime configuration to an opaque in-memory generation.
 * Credentials never become part of route keys, logs, or persisted state.
 */
export class WorkspaceRuntimeGenerationTracker {
  private readonly entries = new Map<string, RuntimeGenerationEntry>()
  private nextGeneration = 1

  forRemote(workspaceId: string, locationId: string, config: ResolvedRemoteWorkspaceRuntime): string {
    return this.resolve(workspaceId, locationId, {
      kind: 'remote',
      url: config.url,
      token: config.token,
      targetWorkspaceId: config.remoteWorkspaceId,
      allowInsecureTls: config.allowInsecureTls === true,
    })
  }

  forLocal(workspaceId: string, locationId: string): string {
    return this.resolve(workspaceId, locationId, { kind: 'local' })
  }

  private resolve(workspaceId: string, locationId: string, identity: RuntimeIdentity): string {
    const key = runtimeLocationKey(workspaceId, locationId)
    const current = this.entries.get(key)
    if (current && runtimeIdentitiesEqual(current.identity, identity)) return current.generation

    const generation = `runtime-${this.nextGeneration++}`
    this.entries.set(key, { identity, generation })
    return generation
  }
}

function runtimeLocationKey(workspaceId: string, locationId: string): string {
  return `${encodeURIComponent(workspaceId)}::${encodeURIComponent(locationId)}`
}

export class WorkspaceRuntimeUpdateQueue {
  private readonly updates = new Map<string, Promise<void>>()

  run(workspaceId: string, update: () => Promise<void>): Promise<void> {
    const previous = this.updates.get(workspaceId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(update).finally(() => {
      if (this.updates.get(workspaceId) === pending) this.updates.delete(workspaceId)
    })
    this.updates.set(workspaceId, pending)
    return pending
  }
}

function runtimeIdentitiesEqual(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.kind === right.kind
    && left.url === right.url
    && left.token === right.token
    && left.targetWorkspaceId === right.targetWorkspaceId
    && left.allowInsecureTls === right.allowInsecureTls
}
