import type { UiDriverSnapshotNode } from './electron-surface-driver'
import { ElectronUiDriverError } from './electron-ui-driver-error'

export interface RendererSnapshotTarget {
  ref?: string
  semanticId?: string
  testId?: string
  role?: string
  name?: string
  exact?: boolean
}

export function findRendererSnapshotTargets(
  nodes: readonly UiDriverSnapshotNode[],
  target: RendererSnapshotTarget,
): UiDriverSnapshotNode[] {
  if (target.ref) return nodes.filter(node => node.ref === target.ref)
  if (target.semanticId) return nodes.filter(node => node.semanticId === target.semanticId)
  if (target.testId) return nodes.filter(node => node.testId === target.testId)
  if (target.role) {
    return nodes.filter(node => {
      if (node.role !== target.role) return false
      if (target.name === undefined) return true
      return target.exact === false
        ? node.name.toLocaleLowerCase().includes(target.name.toLocaleLowerCase())
        : node.name === target.name
    })
  }
  throw new ElectronUiDriverError('INVALID_REQUEST', 'Renderer target must specify ref, semanticId, testId, or role.')
}

export function resolveRendererSnapshotTarget(
  nodes: readonly UiDriverSnapshotNode[],
  target: RendererSnapshotTarget,
): UiDriverSnapshotNode {
  const matches = findRendererSnapshotTargets(nodes, target)
  if (matches.length === 0) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'No renderer node matched the target.')
  if (matches.length > 1) {
    throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'The renderer target matched more than one node.', {
      count: matches.length,
      refs: matches.slice(0, 10).map(node => node.ref),
    })
  }
  return matches[0]!
}
