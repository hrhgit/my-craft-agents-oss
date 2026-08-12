import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { uiCatalogEntries } from './ui-catalog.generated'

function SourceSurfacePreview({ sourcePath, exportName, kind }: { sourcePath: string; exportName: string; kind: 'component' | 'page' }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-64 w-full items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-3 border border-border bg-background p-5">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold">{exportName}</h3>
          <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {t(`playground.catalog.kind.${kind}`)}
          </span>
        </div>
        <code className="block break-all text-xs text-muted-foreground">{sourcePath}</code>
        <p className="text-sm text-muted-foreground">
          {t('playground.catalog.exemptNote')}
        </p>
      </div>
    </div>
  )
}

export const uiCatalogComponents: ComponentEntry[] = uiCatalogEntries.map(entry => ({
  id: entry.id,
  name: entry.exportName === 'default' ? entry.sourcePath.split('/').at(-1)?.replace(/\.tsx$/, '') ?? entry.sourcePath : entry.exportName,
  category: 'Catalog',
  description: `Source catalog entry for ${entry.kind === 'page' ? 'a page' : 'a component'} awaiting or sharing a dedicated preview adapter.`,
  descriptionZh: `等待或共享专用预览适配器的${entry.kind === 'page' ? '页面' : '组件'}源码目录条目。`,
  component: SourceSurfacePreview,
  props: [],
  mockData: () => ({ sourcePath: entry.sourcePath, exportName: entry.exportName, kind: entry.kind }),
  source: { file: entry.sourcePath, symbol: entry.exportName, coverage: 'exempt' },
  scene: { kind: 'static', label: 'Source catalog context', labelZh: '源码目录上下文' },
}))
