import type { ExtensionBridgeEvent } from '@mortise/shared/agent/backend/types'

export type ExtensionFrontendStateEvent = Extract<ExtensionBridgeEvent, { type: 'extension_frontend_state' }>

type ExtensionFrontendResetEvent = Extract<ExtensionBridgeEvent, { type: 'extension_contributions_runtime_reset' }>

function stateKey(event: ExtensionFrontendStateEvent): string {
  return [event.extensionId, event.state.channelId, event.state.scope].join('\0')
}

/**
 * Keeps the latest complete extension frontend channel snapshots even when no
 * renderer is listening yet. The cache is process-local because the owning Pi
 * runtime remains authoritative and republishes state after a runtime reload.
 */
export class ExtensionFrontendStateCache {
  private readonly sessions = new Map<string, Map<string, ExtensionFrontendStateEvent>>()
  private readonly workspaces = new Map<string, Map<string, ExtensionFrontendStateEvent>>()

  apply(event: ExtensionFrontendStateEvent | ExtensionFrontendResetEvent): void {
    const states = this.sessions.get(event.sessionId)

    if (event.type === 'extension_contributions_runtime_reset') {
      if (!states) return
      for (const [key, state] of states) {
        if (state.extensionId === event.extensionId && state.runtimeId === event.runtimeId) {
          states.delete(key)
        }
      }
      if (states.size === 0) this.sessions.delete(event.sessionId)
      if (event.workspaceId) {
        const workspaceStates = this.workspaces.get(event.workspaceId)
        if (workspaceStates) {
          for (const [key, state] of workspaceStates) {
            if (state.extensionId === event.extensionId && state.runtimeId === event.runtimeId) workspaceStates.delete(key)
          }
          if (workspaceStates.size === 0) this.workspaces.delete(event.workspaceId)
        }
      }
      return
    }

    const key = stateKey(event)
    const current = states?.get(key)
    if (current?.runtimeId === event.runtimeId && current.state.revision >= event.state.revision) return

    const next = states ?? new Map<string, ExtensionFrontendStateEvent>()
    next.set(key, event)
    this.sessions.set(event.sessionId, next)

    if (event.state.sessionBootstrap && event.workspaceId) {
      const workspaceStates = this.workspaces.get(event.workspaceId) ?? new Map<string, ExtensionFrontendStateEvent>()
      const currentWorkspaceState = workspaceStates.get(key)
      if (currentWorkspaceState?.runtimeId !== event.runtimeId || currentWorkspaceState.state.revision < event.state.revision) {
        workspaceStates.set(key, event)
        this.workspaces.set(event.workspaceId, workspaceStates)
      }
    }
  }

  get(sessionId: string): ExtensionFrontendStateEvent[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])]
  }

  getWorkspace(workspaceId: string): ExtensionFrontendStateEvent[] {
    return [...(this.workspaces.get(workspaceId)?.values() ?? [])]
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  clearWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId)
  }

  clear(): void {
    this.sessions.clear()
    this.workspaces.clear()
  }
}
