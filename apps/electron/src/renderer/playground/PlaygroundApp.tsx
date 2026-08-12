import * as React from 'react'
import { PanelRight } from 'lucide-react'
import { MortiseSymbol } from '@/components/icons/MortiseSymbol'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/ThemeContext'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PresetTheme } from '@config/theme'
import { ThemeToggle } from './ThemeToggle'
import { Sidebar } from './Sidebar'
import { ComponentPreview } from './ComponentPreview'
import { VariantsSidebar } from './VariantsSidebar'
import type { ComponentVariant } from './registry/types'

const SELECTED_STORAGE_KEY = 'playground-selected-component'
const VARIANTS_SIDEBAR_KEY = 'playground-variants-sidebar-open'
const LOCALE_STORAGE_KEY = 'mortise.playground.global.locale.v1'
type PlaygroundLocale = 'zh-CN' | 'en'

function requestedScenario(): { componentId: string | null; variant: string | null } {
  const query = new URLSearchParams(window.location.search)
  return {
    componentId: query.get('scenario') ?? query.get('component'),
    variant: query.get('variant'),
  }
}

const FALLBACK_THEME_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'ghostty', label: 'Ghostty' },
  { value: 'github', label: 'GitHub' },
  { value: 'gruvbox', label: 'Gruvbox' },
  { value: 'haze', label: 'Haze' },
  { value: 'night-owl', label: 'Night Owl' },
  { value: 'nord', label: 'Nord' },
  { value: 'one-dark-pro', label: 'One Dark Pro' },
  { value: 'pierre', label: 'Pierre' },
  { value: 'rose-pine', label: 'Rosé Pine' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'vitesse', label: 'Vitesse' },
] as const

export function PlaygroundApp() {
  const [registry, setRegistry] = React.useState<typeof import('./registry') | null>(null)
  const categories = React.useMemo(() => registry?.getCategories() ?? [], [registry])
  const {
    workspaceColorTheme,
    effectiveColorTheme,
    setColorTheme,
    setWorkspaceColorTheme,
    setPreviewColorTheme,
    activeWorkspaceId,
  } = useTheme()
  const scenario = React.useMemo(requestedScenario, [])
  const [presetThemes, setPresetThemes] = React.useState<PresetTheme[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(() => {
    if (scenario.componentId) return scenario.componentId
    // Try to restore from localStorage
    try {
      const stored = localStorage.getItem(SELECTED_STORAGE_KEY)
      if (stored) {
        return stored
      }
    } catch {
      // Ignore parse errors
    }
    return null
  })
  const [props, setProps] = React.useState<Record<string, unknown>>({})
  const [selectedVariant, setSelectedVariant] = React.useState<string | null>(null)
  const [locale, setLocale] = React.useState<PlaygroundLocale>(() => {
    try {
      return localStorage.getItem(LOCALE_STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'
    } catch {
      return 'zh-CN'
    }
  })
  const [variantsSidebarOpen, setVariantsSidebarOpen] = React.useState(() => {
    try {
      const stored = localStorage.getItem(VARIANTS_SIDEBAR_KEY)
      return stored !== 'false' // Default to open
    } catch {
      return true
    }
  })

  React.useEffect(() => {
    let active = true
    void import('./registry').then(module => {
      if (active) setRegistry(module)
    })
    return () => { active = false }
  }, [])

  React.useEffect(() => {
    if (registry && selectedId && !registry.getComponentById(selectedId)) setSelectedId(null)
  }, [registry, selectedId])

  React.useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI?.loadPresetThemes) {
        console.warn('[Playground] electronAPI.loadPresetThemes is unavailable; using fallback theme options')
        setPresetThemes([])
        return
      }

      try {
        const themes = await window.electronAPI.loadPresetThemes()
        setPresetThemes(themes)
      } catch (error) {
        console.error('[Playground] Failed to load preset themes, using fallback options:', error)
        setPresetThemes([])
      }
    }

    void loadThemes()
  }, [])

  const themeOptions = React.useMemo(() => {
    const loadedOptions = presetThemes.map(theme => ({
      value: theme.id,
      label: theme.theme.name || theme.id,
    }))

    const merged = new Map<string, string>()

    for (const option of FALLBACK_THEME_OPTIONS) {
      merged.set(option.value, option.label)
    }

    for (const option of loadedOptions) {
      merged.set(option.value, option.label)
    }

    return Array.from(merged.entries()).map(([value, label]) => ({ value, label }))
  }, [presetThemes])

  React.useEffect(() => {
    return () => {
      setPreviewColorTheme(null)
    }
  }, [setPreviewColorTheme])

  // Persist selected component to localStorage
  React.useEffect(() => {
    try {
      if (selectedId) {
        localStorage.setItem(SELECTED_STORAGE_KEY, selectedId)
      } else {
        localStorage.removeItem(SELECTED_STORAGE_KEY)
      }
    } catch {
      // Ignore storage errors
    }
  }, [selectedId])

  // Persist variants sidebar state
  React.useEffect(() => {
    try {
      localStorage.setItem(VARIANTS_SIDEBAR_KEY, String(variantsSidebarOpen))
    } catch {
      // Ignore storage errors
    }
  }, [variantsSidebarOpen])

  React.useEffect(() => {
    document.documentElement.lang = locale
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* Ignore storage errors */ }
  }, [locale])

  const selectedComponent = selectedId && registry
    ? (registry.getComponentById(selectedId) ?? null)
    : null

  // Reset props when component changes
  React.useEffect(() => {
    if (selectedComponent) {
      const defaults: Record<string, unknown> = {}
      for (const prop of selectedComponent.props) {
        defaults[prop.name] = prop.defaultValue
      }
      const requestedVariant = scenario.componentId === selectedComponent.id
        ? selectedComponent.variants?.find(variant => variant.name === scenario.variant)
        : undefined
      setProps(requestedVariant ? { ...defaults, ...requestedVariant.props } : defaults)
      setSelectedVariant(requestedVariant?.name ?? null)
    }
  }, [scenario.componentId, scenario.variant, selectedComponent])

  const handleVariantSelect = (variant: ComponentVariant) => {
    if (selectedComponent) {
      // Start with defaults, then apply variant props
      const defaults: Record<string, unknown> = {}
      for (const prop of selectedComponent.props) {
        defaults[prop.name] = prop.defaultValue
      }
      setProps({ ...defaults, ...variant.props })
      setSelectedVariant(variant.name)
    }
  }

  const handlePropsChange = (newProps: Record<string, unknown>) => {
    setProps(newProps)
    // Clear variant selection when props are manually changed
    setSelectedVariant(null)
  }

  const handleThemeChange = (nextTheme: string) => {
    const normalized = nextTheme === 'default' ? null : nextTheme

    // Apply immediately regardless of persistence layer
    setPreviewColorTheme(normalized)

    // Respect current precedence: if a workspace override is active, update that;
    // otherwise update app default theme.
    if (workspaceColorTheme !== null && activeWorkspaceId) {
      setWorkspaceColorTheme(normalized)
      return
    }

    setColorTheme(nextTheme)
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-border bg-background">
        <div className="flex items-center gap-3">
          <MortiseSymbol className="h-5 w-5" />
          <h1 className="font-semibold text-foreground font-sans">
            {locale === 'zh-CN' ? '界面组件预览' : 'Design System Playground'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Select value={locale} onValueChange={value => setLocale(value as PlaygroundLocale)}>
            <SelectTrigger className="h-8 w-[92px] bg-foreground/5 border-border/50 text-xs" aria-label="Playground language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <Select value={effectiveColorTheme ?? 'default'} onValueChange={handleThemeChange}>
            <SelectTrigger className="h-8 w-[170px] bg-foreground/5 border-border/50 text-xs">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              {themeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={() => setVariantsSidebarOpen(!variantsSidebarOpen)}
            className={cn(
              'p-2 rounded-md transition-colors',
              variantsSidebarOpen
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
            )}
            title={variantsSidebarOpen ? (locale === 'zh-CN' ? '隐藏变体' : 'Hide variants') : (locale === 'zh-CN' ? '显示变体' : 'Show variants')}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Component list */}
        <Sidebar
          categories={categories}
          selectedId={selectedId}
          onSelect={setSelectedId}
          locale={locale}
        />

        {/* Content area - full height preview */}
        {selectedComponent ? (
          <section
            className="contents"
            role="region"
            aria-label={`Scenario: ${selectedComponent.id}${selectedVariant ? ` / ${selectedVariant}` : ''}`}
            data-ui-scenario-ready="true"
            data-ui-scenario-id={selectedComponent.id}
          >
            <ComponentPreview
              component={selectedComponent}
              props={props}
              locale={locale}
            />
          </section>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground" role={scenario.componentId ? 'alert' : undefined}>
            {scenario.componentId ? `${locale === 'zh-CN' ? '未知场景' : 'Unknown scenario'}: ${scenario.componentId}` : (locale === 'zh-CN' ? '请从左侧选择一个组件' : 'Select a component from the sidebar')}
          </div>
        )}

        {/* Right Sidebar - Variants & Props */}
        <VariantsSidebar
          component={selectedComponent}
          selectedVariant={selectedVariant}
          onVariantSelect={handleVariantSelect}
          props={props}
          onPropsChange={handlePropsChange}
          isOpen={variantsSidebarOpen}
          locale={locale}
        />
      </div>
    </div>
  )
}
