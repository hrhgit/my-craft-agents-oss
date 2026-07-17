import { describe, expect, it } from 'bun:test'
import { getToasterLayoutProps, TOPBAR_CLEARING_TOASTER_OFFSET } from '../sonner-layout'

describe('toast viewport placement', () => {
  it('keeps desktop and compact toasts below the fixed top bar', () => {
    expect(TOPBAR_CLEARING_TOASTER_OFFSET).toEqual({
      top: 'calc(var(--topbar-height) + 8px)',
    })
    expect(getToasterLayoutProps()).toEqual({
      position: 'top-right',
      offset: TOPBAR_CLEARING_TOASTER_OFFSET,
      mobileOffset: TOPBAR_CLEARING_TOASTER_OFFSET,
    })
  })
})
