import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import {
  compactDockViewIntentAtom,
  exitCompactDockDetailAtom,
} from '@/atoms/panel-stack'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { CompactPanelTransition } from './CompactPanelTransition'
import { PanelHeader } from './PanelHeader'
import {
  compactDockIntentAfterRouteChange,
  resolveCompactDockDetailActive,
} from './compact-dock-navigation'
import { PANEL_EDGE_INSET, RADIUS_EDGE, RADIUS_INNER } from './panel-constants'

interface PageNavigationSurfaceProps {
  title?: string
  navigationLabel: string
  navigation: React.ReactNode
  content: React.ReactNode
  navigationActions?: React.ReactNode
  navigationBadge?: React.ReactNode
  isCompact: boolean
  routeHasDetail: boolean
  routeKey: string
  navigationWidth?: number
  showNavigationOnDesktop?: boolean
}

/**
 * One root page with page-owned navigation. The navigation rail is internal to
 * this surface and never participates in workspace docking or persistence.
 */
export function PageNavigationSurface({
  title,
  navigationLabel,
  navigation,
  content,
  navigationActions,
  navigationBadge,
  isCompact,
  routeHasDetail,
  routeKey,
  navigationWidth = 300,
  showNavigationOnDesktop = true,
}: PageNavigationSurfaceProps) {
  const { t } = useTranslation()
  const parentContext = useAppShellContext()
  const compactIntent = useAtomValue(compactDockViewIntentAtom)
  const setCompactIntent = useSetAtom(compactDockViewIntentAtom)
  const exitCompactDetail = useSetAtom(exitCompactDockDetailAtom)
  const previousRouteKey = React.useRef(routeKey)

  React.useEffect(() => {
    if (previousRouteKey.current === routeKey) return
    previousRouteKey.current = routeKey
    setCompactIntent(compactDockIntentAfterRouteChange(routeHasDetail))
  }, [routeHasDetail, routeKey, setCompactIntent])

  const detailActive = resolveCompactDockDetailActive({
    isCompact,
    routeHasDetail,
    intent: compactIntent,
  })
  const backAction = React.useMemo(() => (
    <PanelHeaderCenterButton
      icon={<ChevronLeft className="h-4 w-4" />}
      onClick={exitCompactDetail}
      tooltip={t('common.backToList')}
    />
  ), [exitCompactDetail, t])
  const detailContext = React.useMemo(() => ({
    ...parentContext,
    leadingAction: isCompact ? backAction : undefined,
  }), [backAction, isCompact, parentContext])
  const navigationPanel = (
    <div
      role="navigation"
      aria-label={navigationLabel}
      className="flex h-full min-w-0 flex-col bg-background"
    >
      {title && <PanelHeader title={title} badge={navigationBadge} actions={navigationActions} />}
      <div className="min-h-0 flex-1">{navigation}</div>
    </div>
  )
  const detailPanel = (
    <AppShellProvider value={detailContext}>
      <div className="h-full min-w-0 bg-background">{content}</div>
    </AppShellProvider>
  )

  if (isCompact) {
    return (
      <div
        data-mortise-semantic-id="page.navigation-surface"
        className="relative h-full min-w-0 flex-1 overflow-hidden bg-background shadow-middle"
        style={{ borderTopLeftRadius: RADIUS_INNER, borderTopRightRadius: RADIUS_INNER }}
      >
        <CompactPanelTransition role="navigator" isDetailActive={detailActive}>
          {navigationPanel}
        </CompactPanelTransition>
        <CompactPanelTransition role="detail" isDetailActive={detailActive}>
          {detailPanel}
        </CompactPanelTransition>
      </div>
    )
  }

  if (!showNavigationOnDesktop) return detailPanel

  return (
    <div
      data-mortise-semantic-id="page.navigation-surface"
      className="flex h-full min-w-0 flex-1 overflow-hidden bg-background shadow-middle"
      style={{
        borderTopLeftRadius: RADIUS_INNER,
        borderBottomLeftRadius: RADIUS_EDGE,
        borderTopRightRadius: RADIUS_INNER,
        borderBottomRightRadius: RADIUS_EDGE,
        marginRight: PANEL_EDGE_INSET,
      }}
    >
      <aside
        data-page-region="navigation"
        aria-label={navigationLabel}
        className="h-full shrink-0 border-r border-foreground/[0.065] bg-foreground/[0.012]"
        style={{ width: navigationWidth }}
      >
        {navigationPanel}
      </aside>
      <main data-page-region="content" className="h-full min-w-0 flex-1 overflow-hidden">
        {detailPanel}
      </main>
    </div>
  )
}
