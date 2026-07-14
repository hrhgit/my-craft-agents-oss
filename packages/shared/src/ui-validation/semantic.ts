import { UiValidationError } from './errors.ts'

const SEMANTIC_REF_PATTERN = /^r(0|[1-9]\d*):([A-Za-z0-9._-]+)$/

export function createSemanticRef(revision: number, nodeId: string): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new UiValidationError('INVALID_REQUEST', 'Semantic ref revision must be a non-negative safe integer.')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(nodeId)) {
    throw new UiValidationError('INVALID_REQUEST', 'Semantic nodeId contains unsupported characters.')
  }
  return `r${revision}:${nodeId}`
}

export function parseSemanticRef(ref: string): { revision: number; nodeId: string } {
  const match = SEMANTIC_REF_PATTERN.exec(ref)
  if (!match) throw new UiValidationError('INVALID_REQUEST', `Invalid semantic ref: ${ref}`)
  return { revision: Number(match[1]), nodeId: match[2]! }
}

export function assertSemanticRefRevision(ref: string, currentRevision: number): string {
  const parsed = parseSemanticRef(ref)
  if (parsed.revision !== currentRevision) {
    throw new UiValidationError('STALE_REF', `Semantic ref ${ref} belongs to revision ${parsed.revision}, current revision is ${currentRevision}.`, {
      details: { ref, refRevision: parsed.revision, currentRevision },
      retryable: true,
    })
  }
  return parsed.nodeId
}
