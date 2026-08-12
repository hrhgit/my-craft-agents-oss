import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CategoryGroup } from './registry'

interface SidebarProps {
  categories: CategoryGroup[]
  selectedId: string | null
  onSelect: (id: string) => void
  locale: 'zh-CN' | 'en'
}

const STORAGE_KEY = 'playground-expanded-categories'

export function Sidebar({ categories, selectedId, onSelect, locale }: SidebarProps) {
  const [query, setQuery] = React.useState('')
  const [expandedCategories, setExpandedCategories] = React.useState<Set<string>>(() => {
    // Try to restore from localStorage, otherwise collapse all by default
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as string[]
        return new Set(parsed)
      }
    } catch {
      // Ignore parse errors
    }
    return new Set<string>()
  })

  // Persist expanded categories to localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expandedCategories]))
    } catch {
      // Ignore storage errors
    }
  }, [expandedCategories])

  const toggleCategory = (name: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleCategories = normalizedQuery
    ? categories
      .map(category => ({
        ...category,
        components: category.components.filter(component => [
          component.name,
          component.id,
          component.description,
          component.source?.file,
          component.source?.symbol,
        ].join(' ').toLocaleLowerCase().includes(normalizedQuery)),
      }))
      .filter(category => category.components.length > 0)
    : categories

  return (
    <nav className="w-56 shrink-0 border-r border-border bg-background overflow-y-auto">
      <div className="p-3 space-y-1">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={locale === 'zh-CN' ? '搜索组件、来源或导出名' : 'Search UI'}
          aria-label={locale === 'zh-CN' ? '搜索界面组件' : 'Search UI components'}
          className="mb-2 w-full rounded border border-border bg-foreground/5 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        {visibleCategories.map(category => {
          const isExpanded = normalizedQuery.length > 0 || expandedCategories.has(category.name)

          return (
            <div key={category.name}>
              {/* Category header */}
              <button
                onClick={() => toggleCategory(category.name)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 transition-transform',
                    isExpanded && 'rotate-90'
                  )}
                />
                {category.name}
                <span className="ml-auto text-[10px] font-normal opacity-60">
                  {category.components.length}
                </span>
              </button>

              {/* Component list */}
              {isExpanded && (
                <div className="ml-2 space-y-0.5">
                  {category.components.map(component => (
                    <button
                      key={component.id}
                      onClick={() => onSelect(component.id)}
                      className={cn(
                        'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors',
                        selectedId === component.id
                          ? 'bg-foreground/10 text-foreground font-medium'
                          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                      )}
                    >
                      {component.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {visibleCategories.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">{locale === 'zh-CN' ? '没有匹配的组件。' : 'No matching UI.'}</p>
        )}
      </div>
    </nav>
  )
}
