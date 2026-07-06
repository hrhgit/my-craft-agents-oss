/**
 * Session selection hooks.
 *
 * Re-exports from the generic useEntitySelection factory.
 */

import { sessionSelection } from './useEntitySelection'

// Re-export factory-generated hooks under existing names
export const useSessionSelection = sessionSelection.useSelection
export const useSessionSelectionStore = sessionSelection.useSelectionStore
export const useIsMultiSelectActive = sessionSelection.useIsMultiSelectActive
export const useSelectedIds = sessionSelection.useSelectedIds
export const useSelectionCount = sessionSelection.useSelectionCount
