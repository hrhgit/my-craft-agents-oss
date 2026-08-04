import * as React from 'react'
import { Compass, LoaderCircle, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface QueuedMessageListItem {
  id: string
  content: string
}

interface QueuedMessageListProps {
  items: QueuedMessageListItem[]
  pendingId?: string | null
  onSteer: (messageId: string) => void
  onDelete: (messageId: string) => void
  onEdit: (messageId: string) => void
}

export function QueuedMessageList({ items, pendingId, onSteer, onDelete, onEdit }: QueuedMessageListProps) {
  const { t } = useTranslation()
  if (items.length === 0) return null

  return (
    <div
      className="-mb-px overflow-hidden rounded-t-[12px] border border-b-0 border-border/60 bg-background"
      data-mortise-semantic-id="conversation.queued-messages"
      role="list"
    >
      {items.map((item, index) => {
        const isPending = item.id === pendingId
        const isBusy = pendingId != null
        return (
          <div
            key={item.id}
            role="listitem"
            className={cn(
              'group/queued flex min-h-10 min-w-0 items-center gap-2 px-3 py-1.5',
              index > 0 && 'border-t border-border/50',
            )}
            data-mortise-semantic-id={`conversation.queued-message.${item.id}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
              {item.content}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              {isPending ? (
                <span className="inline-flex size-7 items-center justify-center text-muted-foreground" aria-live="polite">
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onSteer(item.id)}
                    className="inline-flex h-7 items-center justify-center gap-1 rounded-[6px] px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
                    aria-label={t('settings.ai.midStream.steer')}
                    title={t('settings.ai.midStream.steer')}
                    data-mortise-semantic-id={`conversation.queued-message.${item.id}.steer`}
                  >
                    <Compass className="size-3.5" aria-hidden="true" />
                    <span>{t('settings.ai.midStream.steer')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onDelete(item.id)}
                    className="inline-flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                    data-mortise-semantic-id={`conversation.queued-message.${item.id}.delete`}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onEdit(item.id)}
                    className="inline-flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
                    aria-label={t('common.edit')}
                    title={t('common.edit')}
                    data-mortise-semantic-id={`conversation.queued-message.${item.id}.edit`}
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
