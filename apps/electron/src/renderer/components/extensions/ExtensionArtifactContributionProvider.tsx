import * as React from 'react'
import { ArtifactContributionProvider } from '@mortise/ui'
import { selectMountableOverflow } from './extension-contribution-store'
import { ExtensionContributionZone } from './ExtensionContributionZone'
import { ExtensionFrontendZone } from './ExtensionFrontendZone'
import { useExtensionContributions } from './useExtensionContributions'

export function ExtensionArtifactContributionProvider({
  sessionId,
  artifactId,
  children,
}: {
  sessionId: string
  artifactId: string
  children: React.ReactNode
}) {
  const target = React.useMemo(() => ({ artifactId }), [artifactId])
  const asideLayout = useExtensionContributions(sessionId, 'conversation.artifact.aside', target)
  const footerLayout = useExtensionContributions(sessionId, 'conversation.artifact.footer', target)
  const hasAside = asideLayout.visible.length > 0 || selectMountableOverflow(asideLayout).length > 0
  const hasFooter = footerLayout.visible.length > 0 || selectMountableOverflow(footerLayout).length > 0
  const asideTitle = asideLayout.visible[0]?.contribution.title
    ?? asideLayout.overflow[0]?.contribution.title
    ?? 'Review'

  return (
    <ArtifactContributionProvider presentation={{
      aside: hasAside ? <ExtensionContributionZone sessionId={sessionId} surface="conversation.artifact.aside" target={target} /> : undefined,
      asideTitle,
      footer: (
        <>
          {hasFooter ? <ExtensionContributionZone sessionId={sessionId} surface="conversation.artifact.footer" target={target} /> : null}
          <ExtensionFrontendZone
            className="contents"
            sessionId={sessionId}
            surface="conversation.artifact.footer"
            route={{ path: artifactId }}
          />
        </>
      ),
    }}>
      {children}
    </ArtifactContributionProvider>
  )
}
