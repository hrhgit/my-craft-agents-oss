import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// ============================================================================
// Sonner Toast Playground
// Demonstrates different toast types, actions, and stacking behavior
// ============================================================================

type ToastType = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading' | 'action' | 'long-url'

const TOAST_TYPES: { id: ToastType; color: string }[] = [
  { id: 'default', color: 'bg-foreground' },
  { id: 'success', color: 'bg-green-500' },
  { id: 'error', color: 'bg-red-500' },
  { id: 'warning', color: 'bg-amber-500' },
  { id: 'info', color: 'bg-blue-500' },
  { id: 'loading', color: 'bg-purple-500' },
  { id: 'action', color: 'bg-foreground' },
  { id: 'long-url', color: 'bg-cyan-500' },
]

function SonnerPlayground() {
  const { t } = useTranslation()
  const [lastType, setLastType] = React.useState<ToastType>('default')

  const typeLabel = (type: ToastType) => t(`playground.toasts.types.${type}`)

  const showToast = (type: ToastType) => {
    setLastType(type)

    switch (type) {
      case 'success':
        toast.success(t('playground.toasts.success.title'), { description: t('playground.toasts.success.desc') })
        break
      case 'error':
        toast.error(t('playground.toasts.error.title'), { description: t('playground.toasts.error.desc') })
        break
      case 'warning':
        toast.warning(t('playground.toasts.warning.title'), { description: t('playground.toasts.warning.desc') })
        break
      case 'info':
        toast.info(t('playground.toasts.info.title'), { description: t('playground.toasts.info.desc') })
        break
      case 'loading':
        toast.loading(t('playground.toasts.loading.title'), { description: t('playground.toasts.loading.desc') })
        break
      case 'action':
        toast(t('playground.toasts.action.title'), {
          description: t('playground.toasts.action.desc'),
          action: {
            label: t('playground.toasts.action.undo'),
            onClick: () => toast.success(t('playground.toasts.action.restored')),
          },
        })
        break
      case 'long-url':
        toast(t('playground.toasts.longUrl.title'), {
          description: 'https://api.example.com/v2/organizations/acme-corp/projects/my-super-long-project-name/resources/12345/details?include=metadata&format=json',
          action: {
            label: t('playground.toasts.longUrl.open'),
            onClick: () => toast.success(t('playground.toasts.longUrl.opening')),
          },
        })
        break
      default:
        toast(t('playground.toasts.default.title'), { description: t('playground.toasts.default.desc') })
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-sm font-medium text-foreground/80 mb-2">{t('playground.toasts.sectionTypes')}</h2>
        <p className="text-xs text-muted-foreground mb-4">
          {t('playground.toasts.intro', { type: typeLabel(lastType) })}
        </p>
        <div className="flex flex-wrap gap-2">
          {TOAST_TYPES.map((toastType) => (
            <button
              key={toastType.id}
              onClick={() => showToast(toastType.id)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                'bg-muted/50 hover:bg-muted text-foreground',
                lastType === toastType.id && 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
              )}
            >
              <div className={cn('w-3 h-3 rounded-full', toastType.color)} />
              {typeLabel(toastType.id)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-foreground/80 mb-2">{t('playground.toasts.sectionQuick')}</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => toast.dismiss()}
            className="px-3 py-2 rounded-lg text-sm bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {t('playground.toasts.dismissAll')}
          </button>
          <button
            onClick={() => {
              const id = toast.loading(t('playground.toasts.processing'))
              setTimeout(() => toast.success(t('playground.toasts.done'), { id }), 2000)
            }}
            className="px-3 py-2 rounded-lg text-sm bg-muted/50 hover:bg-muted"
          >
            {t('playground.toasts.loadingToSuccess')}
          </button>
          <button
            onClick={() => {
              for (let i = 0; i < 3; i++) {
                setTimeout(() => toast(t('playground.toasts.stackToast', { n: i + 1 })), i * 200)
              }
            }}
            className="px-3 py-2 rounded-lg text-sm bg-muted/50 hover:bg-muted"
          >
            {t('playground.toasts.stack3')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const toastsComponents: ComponentEntry[] = [
  {
    id: 'sonner-toasts',
    name: 'Sonner Toasts',
    nameZh: 'Sonner 提示',
    category: 'Toast Messages',
    description: 'Toast notifications with different types, actions, and stacking behavior',
    descriptionZh: '不同类型、操作与堆叠行为的提示通知',
    component: SonnerPlayground,
    props: [],
    variants: [],
    mockData: () => ({}),
  },
]
