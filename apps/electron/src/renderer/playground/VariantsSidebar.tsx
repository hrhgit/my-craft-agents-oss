import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { ComponentEntry, ComponentVariant, PlaygroundLocale, PropDefinition } from './registry'

interface VariantsSidebarProps {
  component: ComponentEntry | null
  selectedVariant: string | null
  onVariantSelect: (variant: ComponentVariant) => void
  props: Record<string, unknown>
  onPropsChange: (props: Record<string, unknown>) => void
  isOpen: boolean
  locale: PlaygroundLocale
}

export function VariantsSidebar({
  component,
  selectedVariant,
  onVariantSelect,
  props,
  onPropsChange,
  isOpen,
  locale,
}: VariantsSidebarProps) {
  const { t } = useTranslation()
  if (!isOpen || !component) return null

  const hasVariants = component.variants && component.variants.length > 0
  const hasProps = component.props.length > 0

  const handlePropChange = (name: string, value: unknown) => {
    onPropsChange({ ...props, [name]: value })
  }

  return (
    <div className="w-72 shrink-0 border-l border-border bg-background overflow-y-auto">
      {/* Variants Section */}
      {hasVariants && (
        <div className="p-4 border-b border-border">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {t('playground.variants.sectionTitle')}
          </h2>
          <div className="space-y-1">
            {component.variants!.map(variant => (
              <button
                key={variant.name}
                onClick={() => onVariantSelect(variant)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                  selectedVariant === variant.name
                    ? 'bg-foreground/10 text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                )}
              >
                <div>{locale === 'zh-CN' ? (variant.nameZh ?? variant.name) : variant.name}</div>
                {variant.description && (
                  <div className="text-xs mt-0.5 line-clamp-2 text-muted-foreground">
                    {locale === 'zh-CN' ? (variant.descriptionZh ?? variant.description) : variant.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Props Section */}
      {hasProps && (
        <div className="p-4">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {t('playground.props.sectionTitle')}
          </h2>
          <div className="space-y-3">
            {component.props.map(propDef => (
              <PropControl
                key={propDef.name}
                definition={propDef}
                locale={locale}
                value={props[propDef.name]}
                onChange={value => handlePropChange(propDef.name, value)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasVariants && !hasProps && (
        <div className="p-4">
          <p className="text-sm text-muted-foreground italic">
            {t('playground.props.empty')}
          </p>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// PropControl Component
// ============================================================================

interface PropControlProps {
  definition: PropDefinition
  locale: PlaygroundLocale
  value: unknown
  onChange: (value: unknown) => void
}

function PropControl({ definition, locale, value, onChange }: PropControlProps) {
  const { name, nameZh, description, descriptionZh, control } = definition
  const displayName = locale === 'zh-CN' ? (nameZh ?? name) : name
  const displayDescription = locale === 'zh-CN' ? (descriptionZh ?? description) : description

  return (
    <div className="space-y-1">
      <div className="flex flex-col gap-0.5">
        <label className="text-sm font-medium text-foreground">
          {displayName}
        </label>
        {displayDescription && (
          <span className="text-xs text-muted-foreground">{displayDescription}</span>
        )}
      </div>

      {control.type === 'boolean' && (
        <button
          onClick={() => onChange(!value)}
          className={cn(
            'px-3 py-1.5 rounded-md text-xs font-mono transition-colors',
            value
              ? 'bg-green-500/20 text-green-600 dark:text-green-400'
              : 'bg-foreground/5 text-muted-foreground'
          )}
        >
          {String(value)}
        </button>
      )}

      {control.type === 'string' && (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={control.placeholder}
          className="w-full px-3 py-1.5 rounded-md bg-foreground/5 border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      )}

      {control.type === 'textarea' && (
        <textarea
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={control.placeholder}
          rows={control.rows ?? 3}
          className="w-full px-3 py-1.5 rounded-md bg-foreground/5 border border-border text-sm font-mono resize-y focus:outline-none focus:ring-1 focus:ring-ring"
        />
      )}

      {control.type === 'number' && (
        <input
          type="number"
          value={Number(value ?? 0)}
          onChange={e => onChange(Number(e.target.value))}
          min={control.min}
          max={control.max}
          step={control.step}
          className="w-24 px-3 py-1.5 rounded-md bg-foreground/5 border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      )}

      {control.type === 'select' && (
        <select
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          className="w-full px-3 py-1.5 rounded-md bg-foreground/5 border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {control.options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
