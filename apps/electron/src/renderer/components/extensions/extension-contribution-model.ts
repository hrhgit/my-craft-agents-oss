import type { ExtensionContributionV1 } from '@craft-agent/shared/protocol'

export interface ExtensionBlockContribution {
  key: string
  content: string[]
  placement: 'aboveEditor' | 'belowEditor'
  source?: string
}

/** Compatibility reader for legacy widget contributions after protocol normalization. */
export function toExtensionBlock(contribution: ExtensionContributionV1): ExtensionBlockContribution | null {
  if (!contribution.id.startsWith('legacy-widget:') || contribution.content.type !== 'text') return null
  return {
    key: contribution.id.slice('legacy-widget:'.length),
    content: contribution.content.text.split('\n'),
    placement: contribution.surface === 'composer.above' ? 'aboveEditor' : 'belowEditor',
    source: contribution.group,
  }
}
