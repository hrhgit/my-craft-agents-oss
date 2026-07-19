const BROWSER_INSTANCE_TOOL_PREFIX = 'browser-instance:'

export function browserRegistryWorkspaceSyncKey(
  workspaceId: string | null | undefined,
  remoteWorkspaceId: string | null | undefined,
): string {
  return `${workspaceId ?? ''}\0${remoteWorkspaceId ?? ''}`
}

export function browserInstanceContentId(instanceId: string): string {
  return `${BROWSER_INSTANCE_TOOL_PREFIX}${encodeURIComponent(instanceId)}`
}

export function parseBrowserInstanceContentId(toolId: string | undefined): string | null {
  if (!toolId?.startsWith(BROWSER_INSTANCE_TOOL_PREFIX)) return null
  const encoded = toolId.slice(BROWSER_INSTANCE_TOOL_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export function extensionWorkspaceContentId(item: RegisteredExtensionContribution): string {
  const extensionId = encodeURIComponent(item.extensionId)
  const contributionId = encodeURIComponent(item.contribution.id)
  const base = `extension:${extensionId}:${contributionId}`
  const scope = item.contribution.workspaceContent?.scope ?? 'session'
  if ((item.contribution.workspaceContent?.instancePolicy ?? 'singleton') === 'multiple') {
    return `${base}:multiple:${encodeURIComponent(item.workspaceId ?? '')}:${encodeURIComponent(item.sessionId)}:${encodeURIComponent(item.runtimeId)}`
  }
  if (scope === 'session') return `${base}:session:${encodeURIComponent(item.sessionId)}`
  if (scope === 'workspace') return `${base}:workspace:${encodeURIComponent(item.workspaceId ?? '')}`
  return `${base}:global`
}
import type { RegisteredExtensionContribution } from '@/components/extensions/extension-contribution-store'
