import * as React from 'react'
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useRegisterDismissibleLayer } from '@/context/DismissibleLayerContext'
import { MortiseSymbol } from '../icons/MortiseSymbol'
import { SquarePenRounded } from '../icons/SquarePenRounded'
import { SETTINGS_ICONS } from '../icons/SettingsIcons'
import { TopBarButton } from '../ui/TopBarButton'
import { MobileMenuPage } from './MobileMenuPage'
import { MobileMenuItem, type MobileMenuItemAffordance } from './MobileMenuItem'
import {
  buildMobileMenuPages,
  type MobileMenuPage as PageDefinition,
  type MobileMenuPageId,
  type MobileMenuRow,
} from './mobile-menu-pages'
import type { AppMenuProps } from './types'
import { CrossfadeAvatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

const SNAPPY_SPRING = { type: 'spring' as const, stiffness: 400, damping: 36, mass: 0.8 }
const BACKDROP_FADE = { duration: 0.18 }

type StackAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'push'; page: MobileMenuPageId }
  | { type: 'pop' }
  | { type: 'reset' }

interface SheetState {
  isOpen: boolean
  /** Page IDs currently on the stack. The first is always 'root'. */
  stack: MobileMenuPageId[]
}

const INITIAL_STATE: SheetState = { isOpen: false, stack: ['root'] }

function stackReducer(state: SheetState, action: StackAction): SheetState {
  switch (action.type) {
    case 'open':
      return { isOpen: true, stack: ['root'] }
    case 'close':
      return { isOpen: false, stack: ['root'] }
    case 'push':
      // Guard against pushing duplicates if motion fires twice.
      if (state.stack[state.stack.length - 1] === action.page) return state
      return { ...state, stack: [...state.stack, action.page] }
    case 'pop':
      if (state.stack.length <= 1) return state
      return { ...state, stack: state.stack.slice(0, -1) }
    case 'reset':
      return INITIAL_STATE
  }
}

function getIcon(name: string): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }> | undefined
  return IconComponent ?? null
}

function renderRowIcon(iconName: string, rowId: string): React.ReactNode {
  // The schema's "newChat" item declares icon: 'SquarePen' but we render the
  // local rounded variant to match the desktop dropdown.
  if (rowId === 'newChat') {
    return <SquarePenRounded className="h-5 w-5" />
  }
  // Settings rows pull from the dedicated SETTINGS_ICONS map (custom-shaped icons).
  const settingsKey = rowId.startsWith('settings-') ? rowId.replace(/^settings-/, '') : null
  if (settingsKey && settingsKey !== 'overview') {
    const Icon = SETTINGS_ICONS[settingsKey as keyof typeof SETTINGS_ICONS]
    if (Icon) return <Icon className="h-5 w-5" />
  }
  const Icon = getIcon(iconName)
  return Icon ? <Icon className="h-5 w-5" /> : null
}

function affordanceFor(action: MobileMenuRow['action']): MobileMenuItemAffordance {
  switch (action.kind) {
    case 'navigate':
      return 'chevron'
    case 'url':
      return 'external'
    default:
      return 'none'
  }
}

/**
 * Mobile AppMenu — Mortise logo trigger that opens a full-screen, navigation-stack sheet.
 *
 * Mounted only when `AppShellContext.isCompactMode === true` via the `AppMenu` router.
 *
 * Sheet rendering is portalled into the closest element marked with
 * `data-mobile-menu-root` (RootSurfaceContainer in production, MobileWebUIFrame
 * in the playground). Falls back to `document.body` if no marker is found.
 */
export function MobileAppMenu(props: AppMenuProps) {
  const { t } = useTranslation()
  const [state, dispatch] = useReducer(stackReducer, INITIAL_STATE)
  const [isDebugMode, setIsDebugMode] = useState(false)

  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode)
  }, [])

  const pages = useMemo(
    () => buildMobileMenuPages({ hasNewWindow: !!props.onNewWindow, isDebugMode }),
    [props.onNewWindow, isDebugMode],
  )

  const close = React.useCallback(() => dispatch({ type: 'close' }), [])
  const pop = React.useCallback(() => dispatch({ type: 'pop' }), [])

  // NOTE: We deliberately do NOT bridge to `window.history` here. NavigationContext
  // owns `history.pushState` for the app's routing, and any `history.back()` call
  // on close races with route changes fired from menu actions (e.g. Settings → AI),
  // rolling them back. iOS Safari edge-swipe-back will navigate the whole tab away
  // instead of popping a sub-page — accept that as a known UX gap; the close X
  // and back chevron are the supported dismissal paths.

  // Register with the dismissible layer registry so Escape/back behavior nests cleanly.
  // Priority 0 keeps us under permission/credential prompts (which register higher).
  const layerRegistration = useMemo(
    () => state.isOpen ? {
      id: 'mobile-app-menu',
      type: 'modal' as const,
      priority: 0,
      isOpen: true,
      close,
      canBack: () => state.stack.length > 1,
      back: () => {
        if (state.stack.length > 1) {
          pop()
          return true
        }
        return false
      },
    } : null,
    [state.isOpen, state.stack.length, close, pop],
  )
  useRegisterDismissibleLayer(layerRegistration)

  const dispatchAction = (row: MobileMenuRow) => {
    switch (row.action.kind) {
      case 'navigate':
        if (row.action.to === 'workspaces') props.workspaceNavigation.refreshRemoteHealth()
        dispatch({ type: 'push', page: row.action.to })
        return
      case 'callback':
        switch (row.action.key) {
          case 'newChat': props.onNewChat(); break
          case 'newWindow': props.onNewWindow?.(); break
          case 'openSettings': props.onOpenSettings(); break
        }
        close()
        return
      case 'settingsSubpage':
        props.onOpenSettingsSubpage(row.action.subpage)
        close()
        return
      case 'url':
        window.electronAPI.openUrl(row.action.url)
        close()
        return
      case 'electronApi':
        switch (row.action.method) {
          case 'checkForUpdates': window.electronAPI.checkForUpdates(); break
          case 'installUpdate': window.electronAPI.installUpdate(); break
          case 'menuToggleDevTools': window.electronAPI.menuToggleDevTools(); break
        }
        return
    }
  }

  return (
    <>
      <TopBarButton
        onClick={() => state.isOpen ? close() : dispatch({ type: 'open' })}
        aria-label={t('menu.mortiseMenu')}
        data-state={state.isOpen ? 'open' : 'closed'}
        className="rounded-[8px]"
      >
        <MortiseSymbol className="!h-5 !w-auto text-accent" />
      </TopBarButton>
      <MobileMenuSheet
        state={state}
        pages={pages}
        onPop={pop}
        onClose={close}
        onActivateRow={dispatchAction}
        workspaceNavigation={props.workspaceNavigation}
        t={t}
      />
    </>
  )
}

interface SheetProps {
  state: SheetState
  pages: PageDefinition[]
  onPop: () => void
  onClose: () => void
  onActivateRow: (row: MobileMenuRow) => void
  workspaceNavigation: AppMenuProps['workspaceNavigation']
  t: (key: string) => string
}

function MobileMenuSheet({ state, pages, onPop, onClose, onActivateRow, workspaceNavigation, t }: SheetProps) {
  const portalTarget = useMobileMenuPortalTarget(state.isOpen)
  if (!portalTarget) return null

  // True while the sheet is open OR animating out — AnimatePresence handles the rest.
  const sheet = (
    <AnimatePresence>
      {state.isOpen && (
        <motion.div
          key="mobile-app-menu-sheet"
          className="absolute inset-0 z-modal"
          initial="closed"
          animate="open"
          exit="closed"
        >
          {/* Backdrop dim — only meaningful when the portal target has visible siblings,
              but cheap and harmless otherwise. */}
          <motion.div
            className="absolute inset-0 bg-foreground/30"
            variants={{ open: { opacity: 1 }, closed: { opacity: 0 } }}
            transition={BACKDROP_FADE}
            onClick={onClose}
          />
          <motion.div
            className="absolute inset-0 bg-background overflow-hidden"
            variants={{ open: { y: '0%' }, closed: { y: '100%' } }}
            transition={SNAPPY_SPRING}
          >
            <PageStack
              pages={pages}
              stack={state.stack}
              onPop={onPop}
              onClose={onClose}
              onActivateRow={onActivateRow}
              workspaceNavigation={workspaceNavigation}
              t={t}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  return createPortal(sheet, portalTarget)
}

interface PageStackProps {
  pages: PageDefinition[]
  stack: MobileMenuPageId[]
  onPop: () => void
  onClose: () => void
  onActivateRow: (row: MobileMenuRow) => void
  workspaceNavigation: AppMenuProps['workspaceNavigation']
  t: (key: string) => string
}

/**
 * Renders the page stack with a slide-in / slide-out animation per sub-page.
 * Lower pages stay rendered underneath but are visually covered.
 */
function PageStack({ pages, stack, onPop, onClose, onActivateRow, workspaceNavigation, t }: PageStackProps) {
  return (
    <div className="absolute inset-0">
      {stack.map((pageId, depth) => {
        const page = pages.find((p) => p.id === pageId)
        if (!page) return null
        return (
          <motion.div
            key={pageId}
            className="absolute inset-0"
            initial={depth === 0 ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={SNAPPY_SPRING}
          >
            {pageId === 'workspaces' ? (
              <MobileWorkspacePage
                navigation={workspaceNavigation}
                onBack={onPop}
                onClose={onClose}
                t={t}
              />
            ) : (
            <MobileMenuPage
              title={t(page.titleKey)}
              showBack={depth > 0}
              onBack={onPop}
              onClose={onClose}
            >
              <ul className="py-2">
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <MobileMenuItem
                      icon={renderRowIcon(row.iconName, row.id)}
                      label={t(row.labelKey)}
                      description={row.description ? t(row.description) : undefined}
                      affordance={affordanceFor(row.action)}
                      onClick={() => onActivateRow(row)}
                    />
                  </li>
                ))}
              </ul>
            </MobileMenuPage>
            )}
          </motion.div>
        )
      })}
    </div>
  )
}

function MobileWorkspacePage({
  navigation,
  onBack,
  onClose,
  t,
}: {
  navigation: AppMenuProps['workspaceNavigation']
  onBack: () => void
  onClose: () => void
  t: (key: string) => string
}) {
  return (
    <MobileMenuPage title={t('workspace.workspaces')} showBack onBack={onBack} onClose={onClose}>
      <ul className="py-2">
        {navigation.items.map(item => (
          <li key={item.workspace.id}>
            <div className={cn('flex min-h-[56px] items-center px-2', item.isActive && 'bg-foreground/5')}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-[6px] px-2 py-2 text-left active:bg-foreground/10"
                onClick={() => { void navigation.selectWorkspace(item.workspace.id).then(onClose) }}
              >
                <CrossfadeAvatar
                  src={item.iconUrl}
                  alt={item.workspace.name}
                  className="h-7 w-7 shrink-0 rounded-full ring-1 ring-border/50"
                  fallbackClassName="rounded-full bg-muted text-sm"
                  fallback={item.workspace.name.charAt(0) || 'W'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] leading-tight">{item.workspace.name}</span>
                  {item.workspace.remoteServer && (
                    <span className={cn('mt-0.5 flex items-center gap-1 truncate text-[12px]', item.isDisconnected ? 'text-destructive' : 'text-foreground/45')}>
                      {item.isDisconnected ? <Icons.CloudOff className="h-3 w-3 shrink-0" /> : <Icons.Cloud className="h-3 w-3 shrink-0" />}
                      <span className="truncate">{item.isDisconnected ? item.disconnectLabel : item.workspace.remoteServer.url}</span>
                    </span>
                  )}
                </span>
                {item.hasUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                {item.isActive && <Icons.Check className="h-4 w-4 shrink-0 text-foreground/55" />}
              </button>
              {!item.isActive && !item.isDisconnected && (
                <button
                  type="button"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] text-foreground/45 active:bg-foreground/10 active:text-foreground"
                  aria-label={t('sidebarMenu.openInNewWindow')}
                  onClick={() => { void navigation.openWorkspaceInNewWindow(item.workspace.id).then(onClose) }}
                >
                  <Icons.ExternalLink className="h-4 w-4" />
                </button>
              )}
              {!item.isActive && (
                <button
                  type="button"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] text-foreground/45 active:bg-destructive/10 active:text-destructive"
                  aria-label={t('workspace.removeWorkspace')}
                  onClick={() => { void navigation.removeWorkspace(item.workspace) }}
                >
                  <Icons.Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </li>
        ))}
        <li className="mt-1 border-t border-foreground/5 pt-1">
          <MobileMenuItem
            icon={<Icons.FolderPlus className="h-5 w-5" />}
            label={t('workspace.addWorkspace')}
            onClick={() => { onClose(); navigation.openCreation() }}
          />
        </li>
      </ul>
    </MobileMenuPage>
  )
}

/**
 * Resolves the portal target for the sheet. Returns `null` until the document is
 * available (SSR-safety / initial mount) and re-resolves whenever the sheet opens
 * so demos that mount after the first render still work.
 */
function useMobileMenuPortalTarget(isOpen: boolean): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!isOpen) return
    const found = document.querySelector('[data-mobile-menu-root]')
    setTarget((found as HTMLElement | null) ?? document.body)
  }, [isOpen])
  return target
}
