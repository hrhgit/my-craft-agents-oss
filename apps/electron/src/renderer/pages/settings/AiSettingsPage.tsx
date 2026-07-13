import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { PiProvidersSection } from './PiProvidersSection'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'ai',
}

export function AiSettingsPage() {
  const { t } = useTranslation()

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t('settings.ai.title')} actions={<HeaderMenu route={routes.view.settings('ai')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <PiProvidersSection />
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default AiSettingsPage
