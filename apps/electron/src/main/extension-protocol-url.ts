export type ExtensionResourceType = 'frontend' | 'module' | 'override'

export interface ExtensionProtocolTarget {
  resourceType: ExtensionResourceType
  extensionId: string
  itemId: string
  kind: 'entry' | 'style'
  index?: number
}

/** Parse the public mortise-extension URL shape without touching the filesystem. */
export function parseExtensionProtocolUrl(requestUrl: string): ExtensionProtocolTarget | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  const resourceType = url.hostname as ExtensionResourceType
  if (resourceType !== 'frontend' && resourceType !== 'module' && resourceType !== 'override') return null
  const parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part) } catch { return null }
  })
  if (parts.some((part) => part === null) || parts.length < 3 || parts.length > 4) return null
  const [extensionId, itemId, kind, index] = parts as string[]
  if (!extensionId || !itemId || (kind !== 'entry' && kind !== 'style')) return null
  if (kind === 'entry') return parts.length === 3 ? { resourceType, extensionId, itemId, kind } : null
  if (index === undefined || !/^\d+$/.test(index)) return null
  return { resourceType, extensionId, itemId, kind, index: Number(index) }
}
