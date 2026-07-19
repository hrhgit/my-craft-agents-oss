import * as React from 'react'
import { isLocalOnly } from '@mortise/shared/protocol'
import type { ElectronAPI } from '../../shared/types'
import type { WorkspaceRoute } from '../../shared/app-layout'
import { CHANNEL_MAP } from '../../transport/channel-map'

const WorkspaceElectronApiContext = React.createContext<ElectronAPI | null>(null)
const WorkspaceRouteContext = React.createContext<WorkspaceRoute | null>(null)

export function WorkspaceElectronApiProvider({
  route,
  children,
}: {
  route: WorkspaceRoute
  children: React.ReactNode
}) {
  const { serverId, workspaceId } = route
  const api = React.useMemo(
    () => createWorkspaceElectronApi(window.electronAPI, { serverId, workspaceId }),
    [serverId, workspaceId],
  )
  const scopedRoute = React.useMemo(() => ({ serverId, workspaceId }), [serverId, workspaceId])
  return (
    <WorkspaceRouteContext.Provider value={scopedRoute}>
      <WorkspaceElectronApiContext.Provider value={api}>{children}</WorkspaceElectronApiContext.Provider>
    </WorkspaceRouteContext.Provider>
  )
}

export function useWorkspaceElectronApi(): ElectronAPI {
  return React.useContext(WorkspaceElectronApiContext) ?? window.electronAPI
}

export function useWorkspaceRoute(): WorkspaceRoute | null {
  return React.useContext(WorkspaceRouteContext)
}

export function createWorkspaceElectronApi(base: ElectronAPI, route: WorkspaceRoute): ElectronAPI {
  if (typeof base.invokeWorkspaceApi !== 'function' || typeof base.onWorkspaceApiEvent !== 'function') {
    return base
  }
  const scoped: Record<string, any> = { ...base }
  const nested = new Map<string, Record<string, any>>()

  for (const [method, entry] of Object.entries(CHANNEL_MAP)) {
    const original = getMethod(base, method)
    const fn = isLocalOnly(entry.channel)
      ? original
      : entry.type === 'listener'
        ? (callback: (...args: any[]) => void) => base.onWorkspaceApiEvent(route, method, callback)
        : (...args: any[]) => base.invokeWorkspaceApi(route, method, ...args)
    if (!fn) continue

    const dot = method.indexOf('.')
    if (dot < 0) {
      scoped[method] = fn
      continue
    }
    const namespace = method.slice(0, dot)
    const name = method.slice(dot + 1)
    const target = nested.get(namespace) ?? { ...(base as any)[namespace] }
    target[name] = fn
    nested.set(namespace, target)
  }

  for (const [namespace, value] of nested) scoped[namespace] = value
  return scoped as ElectronAPI
}

function getMethod(api: ElectronAPI, method: string): ((...args: any[]) => any) | undefined {
  const dot = method.indexOf('.')
  const value = dot < 0
    ? (api as any)[method]
    : (api as any)[method.slice(0, dot)]?.[method.slice(dot + 1)]
  return typeof value === 'function' ? value : undefined
}
