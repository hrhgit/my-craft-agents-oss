import type { ExtensionContributionV1 } from '@craft-agent/shared/protocol'

export interface ExtensionBlockContribution {
  key: string
  content: string[] | undefined
  placement: 'aboveEditor' | 'belowEditor'
  source?: string
}

export function toExtensionBlock(contribution: ExtensionContributionV1): ExtensionBlockContribution | null {
  if (contribution.kind !== 'block' || !contribution.contributionId.startsWith('widget:')) return null
  if (!contribution.payload || typeof contribution.payload !== 'object' || Array.isArray(contribution.payload)) return null
  const payload = contribution.payload as Record<string, unknown>
  if (payload.format !== 'text' || typeof payload.content !== 'string') return null
  return {
    key: contribution.contributionId.slice('widget:'.length),
    content: payload.removed === true ? undefined : payload.content.split('\n'),
    placement: contribution.placement === 'above_editor' ? 'aboveEditor' : 'belowEditor',
    source: typeof payload.source === 'string' ? payload.source : undefined,
  }
}
