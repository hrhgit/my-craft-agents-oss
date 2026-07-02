/**
 * ExtensionListPanel — 扩展列表视图
 *
 * 渲染 PI_EXTENSION_MANIFEST 中所有扩展为列表行：
 * - 左侧：扩展名（大标题）+ 简述（下方）
 * - 右侧：启用/禁用 toggle
 * - 可配置扩展（有 GUI 配置页的）：点击左侧区域进入次级页面
 * - 不可配置扩展：仅 toggle 可操作
 *
 * 列表按 manifest 的 category 分组渲染，每组带分组标题。
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { SettingsCard } from '@/components/settings'
import {
  PI_EXTENSION_MANIFEST,
  type PiExtensionManifestEntry,
} from '@craft-agent/shared/config/pi-extension-settings'

/**
 * 拥有 craft GUI 配置页的扩展 id 集合。
 * 只有这些扩展的行可点击进入次级页面。
 * manifest 中的 `configurable` 标志含义更广（包括需编辑 settings.json 的），
 * 此处仅包含实际有 GUI 配置项的扩展。
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
 * 分组展示顺序——按用户感知重要性排列。
 * manifest 中出现的 category 必须在此列出，否则该组不会渲染。
 */
const CATEGORY_ORDER: PiExtensionManifestEntry['category'][] = [
  'agent',
  'ui',
  'automation',
  'memory',
  'search',
  'shell',
  'diagnostics',
]

interface ExtensionListPanelProps {
  extensionStates: Record<string, boolean>
  onToggleExtension: (id: string, enabled: boolean) => void
  onSelectExtension: (id: string) => void
}

export function ExtensionListPanel({
  extensionStates,
  onToggleExtension,
  onSelectExtension,
}: ExtensionListPanelProps) {
  const { t } = useTranslation()

  const grouped = useMemo(() => {
    const map = new Map<PiExtensionManifestEntry['category'], PiExtensionManifestEntry[]>()
    for (const ext of PI_EXTENSION_MANIFEST) {
      const arr = map.get(ext.category) ?? []
      arr.push(ext)
      map.set(ext.category, arr)
    }
    return CATEGORY_ORDER
      .map((category) => ({ category, entries: map.get(category) ?? [] }))
      .filter((group) => group.entries.length > 0)
  }, [])

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
              const description = t(descriptionKey)

              return (
                <ExtensionRow
                  key={ext.id}
                  id={ext.id}
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
  description: string
  enabled: boolean
  configurable: boolean
  onToggle: (enabled: boolean) => void
  onSelect: () => void
}

function ExtensionRow({
  id,
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
            <span className="text-sm font-medium font-sans leading-tight">{id}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          {description && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{description}</div>
          )}
        </button>
      ) : (
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium font-sans leading-tight">{id}</div>
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
