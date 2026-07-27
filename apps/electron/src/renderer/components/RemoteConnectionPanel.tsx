import { Cloud, CloudOff } from 'lucide-react'
import type { WorkspaceEndpointInfo, WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'

import { cn } from '@/lib/utils'

type RemoteWorkspaceEndpointInfo = Extract<WorkspaceEndpointInfo, { kind: 'remote' }>

export function getPrimaryWorkspaceLocationInfo(
  workspace: WorkspaceInfo,
): WorkspaceLocationInfo | null {
  return workspace.locations.find(location => location.id === workspace.primaryLocationId) ?? null
}

export function getPrimaryRemoteWorkspaceEndpoint(
  workspace: WorkspaceInfo,
): RemoteWorkspaceEndpointInfo | null {
  const endpoint = getPrimaryWorkspaceLocationInfo(workspace)?.endpoint
  return endpoint?.kind === 'remote' ? endpoint : null
}

export function getPrimaryRemoteWorkspaceId(workspace: WorkspaceInfo): string | null {
  return getPrimaryRemoteWorkspaceEndpoint(workspace)?.remoteWorkspaceId ?? null
}

export function RemoteConnectionPanel({
  workspace,
  isDisconnected,
  disconnectLabel,
}: {
  workspace: WorkspaceInfo
  isDisconnected: boolean
  disconnectLabel: string
}) {
  const endpoint = getPrimaryRemoteWorkspaceEndpoint(workspace)
  if (!endpoint) return null

  return (
    <span
      className={cn(
        'mt-0.5 flex items-center gap-1 truncate text-[12px]',
        isDisconnected ? 'text-destructive' : 'text-foreground/45',
      )}
      title={isDisconnected ? disconnectLabel : endpoint.url}
    >
      {isDisconnected
        ? <CloudOff className="h-3 w-3 shrink-0" />
        : <Cloud className="h-3 w-3 shrink-0" />}
      <span className="truncate">{isDisconnected ? disconnectLabel : endpoint.url}</span>
    </span>
  )
}
