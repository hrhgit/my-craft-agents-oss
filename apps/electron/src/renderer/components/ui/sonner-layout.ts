import type { ToasterProps } from 'sonner'

export const TOPBAR_CLEARING_TOASTER_OFFSET = {
  top: 'calc(var(--topbar-height) + 8px)',
} satisfies NonNullable<ToasterProps['offset']>

export function getToasterLayoutProps(): Pick<ToasterProps, 'position' | 'offset' | 'mobileOffset'> {
  return {
    position: 'top-right',
    offset: TOPBAR_CLEARING_TOASTER_OFFSET,
    mobileOffset: TOPBAR_CLEARING_TOASTER_OFFSET,
  }
}
