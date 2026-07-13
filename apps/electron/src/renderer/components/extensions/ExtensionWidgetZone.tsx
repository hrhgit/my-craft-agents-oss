import { cn } from '@/lib/utils'
import { ExtensionContributionZone } from './ExtensionContributionZone'

export interface ExtensionWidgetZoneProps {
  className?: string
  sessionId: string
}

/** Compatibility mount for legacy setWidget calls normalized by the server bridge. */
export function ExtensionWidgetZone({ className, sessionId }: ExtensionWidgetZoneProps) {
  return <ExtensionContributionZone className={cn('w-full px-3 @xs/panel:px-4', className)} sessionId={sessionId} surface="composer.below" />
}

export default ExtensionWidgetZone
