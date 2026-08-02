import { Folder, FolderPlus, MoreHorizontal, Star, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface WorkspaceLocationCollectionProps {
  paths: string[]
  primaryIndex: number | null
  disabled: boolean
  onAdd: () => void
  onRemove: (index: number) => void
  onSetPrimary: (index: number) => void
}

function folderName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? path
}

export function WorkspaceLocationCollection({
  paths,
  primaryIndex,
  disabled,
  onAdd,
  onRemove,
  onSetPrimary,
}: WorkspaceLocationCollectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-foreground">{t('workspace.locationLabel')}</label>
        {paths.length > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={onAdd} disabled={disabled}>
            <FolderPlus className="size-4" />
            {t('workspace.addFolder')}
          </Button>
        )}
      </div>

      {paths.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className={cn(
            'flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border',
            'bg-foreground/[0.015] text-sm font-medium text-muted-foreground transition-colors',
            'hover:border-foreground/25 hover:bg-foreground/[0.035] hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <FolderPlus className="size-5" />
          {t('workspace.addFolder')}
        </button>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {paths.map((path, index) => {
            const isPrimary = index === primaryIndex
            return (
              <div
                key={path}
                className={cn(
                  'grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2',
                  index > 0 && 'border-t border-border/70',
                )}
              >
                <div className="flex size-8 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground">
                  <Folder className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{folderName(path)}</span>
                    {isPrimary && (
                      <span className="shrink-0 rounded border border-foreground/10 bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {t('workspace.primaryLocation')}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" title={path}>{path}</div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={disabled}
                      aria-label={t('common.more')}
                      title={t('common.more')}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!isPrimary && (
                      <DropdownMenuItem onSelect={() => onSetPrimary(index)}>
                        <Star />
                        {t('workspace.makePrimary')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem variant="destructive" onSelect={() => onRemove(index)}>
                      <Trash2 />
                      {t('workspace.removeFolder')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
