/**
 * ExtensionListPanel — 扩展列表视图
 *
 * 渲染 Pi host facade 返回的扩展 catalog：
 * - 左侧：扩展名（大标题）+ 简述（下方）
 * - 右侧：启用/禁用 toggle
 * - 可配置扩展（有 GUI 配置页的）：点击左侧区域进入次级页面
 * - 不可配置扩展：仅 toggle 可操作
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { SettingsCard } from '@/components/settings'
import type { PiExtensionCatalogEntry, PiExtensionCategory } from '@craft-agent/shared/config/pi-extension-settings'

/**
 * 拥有 craft GUI 配置页的扩展 id 集合。
 * 只有这些扩展的行可点击进入次级页面。
 * Pi 的 `configurable` 表示扩展有配置概念；这里表示 Craft 当前有详情页。
 */
const GUI_CONFIGURABLE_EXTENSIONS = new Set<string>([
  'plan-mode',
  'prompt-automation',
  'repo-memory',
  'subagent',
  'trace-audit',
  'yourself',
])

export function isExtensionConfigurable(id: string): boolean {
  return GUI_CONFIGURABLE_EXTENSIONS.has(id)
}

/**
 * 分组展示顺序——按用户感知重要性排列；未知分类放到末尾。
 */
const CATEGORY_ORDER: PiExtensionCategory[] = [
  'agent',
  'ui',
  'automation',
  'memory',
  'search',
  'shell',
  'diagnostics',
  'other',
]

interface ExtensionListPanelProps {
  extensions: PiExtensionCatalogEntry[]
  extensionStates: Record<string, boolean>
  onToggleExtension: (id: string, enabled: boolean) => void
  onSelectExtension: (id: string) => void
}

export function ExtensionListPanel({
  extensions,
  extensionStates,
  onToggleExtension,
  onSelectExtension,
}: ExtensionListPanelProps) {
  const { t } = useTranslation()

  const grouped = useMemo(() => {
    const map = new Map<PiExtensionCategory, PiExtensionCatalogEntry[]>()
    for (const ext of extensions) {
      const category = CATEGORY_ORDER.includes(ext.category) ? ext.category : 'other'
      const arr = map.get(category) ?? []
      arr.push(ext)
      map.set(category, arr)
    }
    return CATEGORY_ORDER
      .map((category) => ({ category, entries: map.get(category) ?? [] }))
      .filter((group) => group.entries.length > 0)
  }, [extensions])

  return (
    <div className="space-y-6">
      {grouped.map(({ category, entries }) => (
        <div key={category} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
            {t(`settings.extensions.category.${category}`)}
          </h3>
          <SettingsCard>
            {entries.map((ext) => {
              const enabled = extensionStates[ext.id] ?? true
              const configurable = isExtensionConfigurable(ext.id)
              const descriptionKey = `settings.extensions.ext.${ext.id}.description`
              const translatedDescription = t(descriptionKey)
              const description = translatedDescription === descriptionKey ? ext.description : translatedDescription

              return (
                <ExtensionRow
                  key={ext.id}
                  id={ext.id}
                  title={ext.title}
                  description={description}
                  enabled={enabled}
                  configurable={configurable}
                  onToggle={(value) => onToggleExtension(ext.id, value)}
                  onSelect={() => onSelectExtension(ext.id)}
                />
              )
            })}
          </SettingsCard>
        </div>
      ))}
    </div>
  )
}

interface ExtensionRowProps {
  id: string
  title: string
  description: string
  enabled: boolean
  configurable: boolean
  onToggle: (enabled: boolean) => void
  onSelect: () => void
}

function ExtensionRow({
  id,
  title,
  description,
  enabled,
  configurable,
  onToggle,
  onSelect,
}: ExtensionRowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      {configurable ? (
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 min-w-0 text-left cursor-pointer hover:text-foreground transition-colors group"
        >
          <div className="flex items-center gap-1">
            <span className="text-sm font-medium font-sans leading-tight">{title || id}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          {description && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{description}</div>
          )}
        </button>
      ) : (
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium font-sans leading-tight">{title || id}</div>
          {description && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{description}</div>
          )}
        </div>
      )}
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        className="ml-4 shrink-0"
      />
    </div>
  )
}

export default ExtensionListPanel
