import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry, PlaygroundLocale } from './types'
import { cn } from '@/lib/utils'

type ShadowKind = 'class' | 'inline' | 'arbitrary' | 'runtime'

interface ShadowSpec {
  id: string
  component: string
  file: string
  kind: ShadowKind
  shadow: string
  border: string
  hasExplicitBorder: boolean
  note?: string
  previewClassName?: string
  previewStyle?: React.CSSProperties
}

// Only unresolved items stay here intentionally. Border/note copy is localized.
function activeShadowSpecs(locale: PlaygroundLocale): ShadowSpec[] {
  const zh = locale === 'zh-CN'
  return [
    {
      id: 'sortable-list-overlay',
      component: 'SortableList drag overlay',
      file: 'components/ui/sortable-list.tsx',
      kind: 'inline',
      shadow: "boxShadow: '0 0 0 1px rgba(...), 0 15px 15px ...'",
      border: zh ? '无（1px 边缘已包含在 boxShadow 第一层内）' : 'none (1px edge is included inside boxShadow first layer)',
      hasExplicitBorder: false,
      previewClassName: 'rounded-[8px] bg-background px-3 py-2 text-sm',
      previewStyle: { boxShadow: '0 0 0 1px rgba(63, 63, 68, 0.05), 0px 15px 15px 0 rgba(34, 33, 81, 0.25)' },
    },
    {
      id: 'ui-browser-controls',
      component: 'BrowserControls focus ring',
      file: 'packages/ui/components/ui/BrowserControls.tsx',
      kind: 'inline',
      shadow: "boxShadow: '0 0 0 1.5px var(--tb-focus-ring)'",
      border: zh ? "基础状态：'border border-transparent'" : "base state: 'border border-transparent'",
      hasExplicitBorder: true,
      previewClassName: 'rounded-md bg-background border border-transparent px-3 py-2 text-sm',
      previewStyle: { boxShadow: '0 0 0 1.5px var(--ring)' },
    },
    {
      id: 'ui-image-card-stack',
      component: 'ImageCardStack stacked card',
      file: 'packages/ui/components/markdown/ImageCardStack.tsx',
      kind: 'arbitrary',
      shadow: 'shadow-[1px_3px_8px_rgba(0,0,0,0.28)]',
      border: zh ? '无（卡片深度完全来自 arbitrary shadow）' : 'none (card depth comes entirely from arbitrary shadow)',
      hasExplicitBorder: false,
      previewClassName: 'rounded-[8px] bg-background px-3 py-2 text-sm shadow-[1px_3px_8px_rgba(0,0,0,0.28)]',
    },
  ]
}

function runtimeShadowSpecs(locale: PlaygroundLocale): ShadowSpec[] {
  const zh = locale === 'zh-CN'
  return [
    {
      id: 'browser-pane-overlay',
      component: 'Browser pane live overlay',
      file: 'main/browser-pane-manager.ts + shared/browser-live-fx.ts',
      kind: 'runtime',
      shadow: "overlay.style.boxShadow = 'inset ... color-mix(...)'",
      border: zh ? "运行时类：overlay 元素上的 'border border-foreground/20'" : "runtime class: 'border border-foreground/20' on overlay element",
      hasExplicitBorder: true,
      note: zh
        ? '浏览器实时模式的主进程运行时 overlay（非 React 组件）。'
        : 'Main-process runtime overlay for browser live mode (not a React component).',
      previewClassName: 'rounded-[10px] bg-background px-3 py-2 text-sm border border-foreground/20',
      previewStyle: { boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent), inset 0 0 20px color-mix(in oklab, var(--accent) 28%, transparent)' },
    },
  ]
}

const kindBadgeClass: Record<ShadowKind, string> = {
  class: 'bg-success/10 text-success',
  inline: 'bg-info/10 text-info',
  arbitrary: 'bg-destructive/10 text-destructive',
  runtime: 'bg-accent/10 text-accent',
}

function ValueBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-foreground/50">{label}</div>
      <div className="rounded-[8px] bg-foreground/3 p-2 text-[11px] text-foreground/70 font-mono leading-snug break-words">
        {value}
      </div>
    </div>
  )
}

function BorderBadge({ hasExplicitBorder }: { hasExplicitBorder: boolean }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-medium',
        hasExplicitBorder ? 'bg-success/10 text-success' : 'bg-foreground/10 text-foreground/70'
      )}
    >
      {t('playground.customShadows.borderBadge', {
        state: t(hasExplicitBorder ? 'playground.customShadows.borderYes' : 'playground.customShadows.borderNo'),
      })}
    </span>
  )
}

function ShadowSpecCard({ spec }: { spec: ShadowSpec }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[10px] border border-border bg-background p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{spec.component}</div>
          <div className="text-[11px] text-foreground/50 truncate">{spec.file}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <BorderBadge hasExplicitBorder={spec.hasExplicitBorder} />
          <span className={cn('shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', kindBadgeClass[spec.kind])}>
            {spec.kind}
          </span>
        </div>
      </div>

      <ValueBlock label={t('playground.customShadows.labelShadow')} value={spec.shadow} />
      <ValueBlock label={t('playground.customShadows.labelBorder')} value={spec.border} />

      <div className="rounded-[8px] bg-foreground/2 p-3">
        <div className={cn('w-full flex items-center', spec.previewClassName)} style={spec.previewStyle}>
          {t('playground.customShadows.previewShadow')}
        </div>
      </div>

      {spec.note && <div className="text-[11px] text-foreground/60">{spec.note}</div>}
    </div>
  )
}

function Section({
  title,
  specs,
  shadowOnly,
}: {
  title: string
  specs: ShadowSpec[]
  shadowOnly: boolean
}) {
  const { t } = useTranslation()
  const filteredSpecs = shadowOnly ? specs.filter((s) => !s.hasExplicitBorder) : specs
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-foreground/50">
          {t('playground.customShadows.sectionItems', { count: filteredSpecs.length, total: specs.length })}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filteredSpecs.map((spec) => <ShadowSpecCard key={spec.id} spec={spec} />)}
      </div>
      {filteredSpecs.length === 0 && (
        <div className="rounded-[8px] border border-border bg-foreground/2 p-3 text-sm text-foreground/60">
          {t('playground.customShadows.empty')}
        </div>
      )}
    </section>
  )
}

function CustomShadowsAudit({ locale = 'en' }: { locale?: PlaygroundLocale }) {
  const { t } = useTranslation()
  const [shadowOnly, setShadowOnly] = React.useState(false)
  const activeSpecs = React.useMemo(() => activeShadowSpecs(locale), [locale])
  const runtimeSpecs = React.useMemo(() => runtimeShadowSpecs(locale), [locale])

  return (
    <div className="w-full max-w-[1200px] p-6 space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{t('playground.customShadows.auditTitle')}</h2>
        <p className="text-sm text-foreground/70">
          {t('playground.customShadows.auditDesc')}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-foreground/60">{t('playground.customShadows.filter')}</span>
        <button
          type="button"
          onClick={() => setShadowOnly(false)}
          className={cn(
            'h-7 px-2.5 rounded-[6px] text-xs font-medium transition-colors',
            !shadowOnly ? 'bg-background shadow-minimal text-foreground' : 'bg-foreground/5 text-foreground/70 hover:bg-foreground/10'
          )}
        >
          {t('playground.customShadows.filterAll')}
        </button>
        <button
          type="button"
          onClick={() => setShadowOnly(true)}
          className={cn(
            'h-7 px-2.5 rounded-[6px] text-xs font-medium transition-colors',
            shadowOnly ? 'bg-background shadow-minimal text-foreground' : 'bg-foreground/5 text-foreground/70 hover:bg-foreground/10'
          )}
        >
          {t('playground.customShadows.filterShadowOnly')}
        </button>
      </div>

      <Section title={t('playground.customShadows.sectionActive')} specs={activeSpecs} shadowOnly={shadowOnly} />

      <Section title={t('playground.customShadows.sectionRuntime')} specs={runtimeSpecs} shadowOnly={shadowOnly} />
    </div>
  )
}

interface AllowedShadowVariant {
  className: string
  note: string
}

function allowedShadowVariants(locale: PlaygroundLocale): AllowedShadowVariant[] {
  const zh = locale === 'zh-CN'
  return [
    { className: 'shadow-none', note: zh ? '无阴影——显式退出。' : 'No shadow — explicit opt-out.' },
    { className: 'shadow-xs', note: zh ? '基于 Tailwind 基础 token 的极轻微浮起。' : 'Very subtle elevation from base Tailwind token.' },
    { className: 'shadow-minimal', note: zh ? '设计系统默认面板浮起。' : 'Design-system default panel elevation.' },
    { className: 'shadow-tinted', note: zh ? '使用 --shadow-color 的着色浮起（语义/强调色场景）。' : 'Tinted elevation using --shadow-color (semantic/accent contexts).' },
    { className: 'shadow-thin', note: zh ? '细边框 + 轻模糊组合。' : 'Thin border + light blur stack.' },
    { className: 'shadow-middle', note: zh ? '较大表面使用的中等深度分层浮起。' : 'Mid-depth layered elevation for larger surfaces.' },
    { className: 'shadow-strong', note: zh ? '高浮起分层阴影。' : 'High-elevation layered shadow.' },
    { className: 'shadow-panel-focused', note: zh ? '类似聚焦的高亮处理，带强调色描边。' : 'Focus-like elevated treatment with emphasis ring.' },
    { className: 'shadow-modal-small', note: zh ? '模态框/下拉菜单深度。' : 'Modal/dropdown depth profile.' },
    { className: 'shadow-bottom-border', note: zh ? '内嵌底部分隔线（1.5px）。' : 'Inset bottom separator (1.5px).' },
    { className: 'shadow-bottom-border-thin', note: zh ? '内嵌底部分隔线（1px）。' : 'Inset bottom separator (1px).' },
  ]
}

function VariantPreview({ variant }: { variant: AllowedShadowVariant }) {
  const { t } = useTranslation()
  if (variant.className === 'shadow-bottom-border' || variant.className === 'shadow-bottom-border-thin') {
    return (
      <div className="rounded-[8px] border border-border bg-background overflow-hidden">
        <div className={cn('px-3 py-2 text-sm', variant.className)}>{t('playground.customShadows.previewRow1')}</div>
        <div className={cn('px-3 py-2 text-sm', variant.className)}>{t('playground.customShadows.previewRow2')}</div>
        <div className="px-3 py-2 text-sm">{t('playground.customShadows.previewLastRow')}</div>
      </div>
    )
  }

  const style: React.CSSProperties | undefined = variant.className === 'shadow-tinted'
    ? { ['--shadow-color' as any]: 'var(--accent-rgb)' }
    : undefined

  return (
    <div className="rounded-[8px] bg-foreground/2 p-4">
      <div className={cn('rounded-[8px] bg-background px-3 py-2 text-sm', variant.className)} style={style}>
        {t('playground.customShadows.previewSurface')}
      </div>
    </div>
  )
}

function ShadowShowcase({ locale = 'en' }: { locale?: PlaygroundLocale }) {
  const { t } = useTranslation()
  const variants = React.useMemo(() => allowedShadowVariants(locale), [locale])

  return (
    <div className="w-full max-w-[1200px] p-6 space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{t('playground.customShadows.showcaseTitle')}</h2>
        <p className="text-sm text-foreground/70">
          {t('playground.customShadows.showcaseDesc')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {variants.map((variant) => (
          <div key={variant.className} className="rounded-[10px] border border-border bg-background p-3 space-y-2">
            <div className="space-y-1">
              <div className="text-sm font-medium">{variant.className}</div>
              <div className="text-[11px] text-foreground/60">{variant.note}</div>
            </div>
            <VariantPreview variant={variant} />
          </div>
        ))}
      </div>
    </div>
  )
}

export const customShadowsComponents: ComponentEntry[] = [
  {
    id: 'shadow-showcase',
    name: 'Shadow Showcase',
    nameZh: '阴影展示',
    category: 'Custom Shadows',
    description: 'Canonical gallery of all approved shadow variants in the design system.',
    descriptionZh: '设计系统中所有已批准阴影变体的标准图库。',
    component: ShadowShowcase,
    props: [],
    variants: [],
    layout: 'top',
    mockData: (locale) => ({ locale }),
  },
  {
    id: 'custom-shadows-audit',
    name: 'Custom Shadows Audit',
    nameZh: '自定义阴影审计',
    category: 'Custom Shadows',
    description: 'Review remaining components/runtime overlays with unresolved custom shadow styles and border strategies.',
    descriptionZh: '审查仍使用未解决自定义阴影样式与边框策略的组件/运行时 overlay。',
    component: CustomShadowsAudit,
    props: [],
    variants: [],
    layout: 'top',
    mockData: (locale) => ({ locale }),
  },
]
