export type UiPhysicalInteraction = 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text'

export interface UiValidationPrimitiveProps {
  /** Stable identity exposed only through the bounded UI validation snapshot. */
  semanticId?: string
  /** Extra physical capabilities implemented by this concrete component. */
  uiInteractions?: readonly UiPhysicalInteraction[]
}

export function uiValidationAttributes(
  semanticId: string | undefined,
  interactions: readonly UiPhysicalInteraction[] | undefined,
): Record<string, string | undefined> {
  return {
    ...(semanticId ? { 'data-mortise-semantic-id': semanticId } : {}),
    ...(interactions?.length ? { 'data-mortise-ui-interactions': [...new Set(interactions)].join(' ') } : {}),
  }
}
