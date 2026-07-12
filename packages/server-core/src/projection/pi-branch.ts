export interface PiBranchProjectionEntry {
  id: string
  parentId?: string | null
  type: string
  timestamp: string
  message?: unknown
}

export interface PiBranchProjection {
  leafId: string | null
  entries: PiBranchProjectionEntry[]
}

export function getPiEntryMessageId(entry: PiBranchProjectionEntry): string | undefined {
  if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') return undefined
  const message = entry.message as Record<string, unknown>
  if (message.role === 'user' && typeof message.clientMutationId === 'string' && message.clientMutationId) {
    return message.clientMutationId
  }
  if (typeof message.id === 'string' && message.id) return message.id
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return `ts-${message.timestamp}`
  }
  if (typeof message.timestamp === 'string') {
    const timestamp = Date.parse(message.timestamp)
    if (Number.isFinite(timestamp)) return `ts-${timestamp}`
  }
  const entryTimestamp = Date.parse(entry.timestamp)
  return Number.isFinite(entryTimestamp) ? `ts-${entryTimestamp}` : undefined
}

export function getActivePiBranchEntries(projection: PiBranchProjection): PiBranchProjectionEntry[] {
  if (projection.leafId === null) return []
  const byId = new Map(projection.entries.map(entry => [entry.id, entry]))
  const result: PiBranchProjectionEntry[] = []
  const seen = new Set<string>()
  let current = byId.get(projection.leafId)
  while (current) {
    if (seen.has(current.id)) throw new Error('Cannot branch from a cyclic Pi session projection')
    seen.add(current.id)
    result.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return result
}

export function resolvePiBranchTarget(
  projection: PiBranchProjection,
  messageId: string,
): {
  targetEntry: PiBranchProjectionEntry
  branchEntries: PiBranchProjectionEntry[]
  canonicalEntryIds: Set<string>
  overlayMessageIds: Set<string>
} | null {
  const activeEntries = getActivePiBranchEntries(projection)
  const targetEntryIndex = activeEntries.findIndex(entry => (
    entry.id === messageId || getPiEntryMessageId(entry) === messageId
  ))
  if (targetEntryIndex < 0) return null

  const branchEntries = activeEntries.slice(0, targetEntryIndex + 1)
  const canonicalEntryIds = new Set(branchEntries.map(entry => entry.id))
  const overlayMessageIds = new Set(canonicalEntryIds)
  for (const entry of branchEntries) {
    const projectedMessageId = getPiEntryMessageId(entry)
    if (projectedMessageId) overlayMessageIds.add(projectedMessageId)
  }
  return {
    targetEntry: activeEntries[targetEntryIndex]!,
    branchEntries,
    canonicalEntryIds,
    overlayMessageIds,
  }
}
