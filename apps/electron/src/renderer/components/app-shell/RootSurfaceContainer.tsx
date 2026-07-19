/**
 * Root application layout:
 * Primary workspace sidebar -> active root content surface.
 *
 * Page-owned navigation lives inside the root content surface. The shell has
 * no second-sidebar or module-navigation slot.
 */

import { useRef } from 'react'
import { motion } from 'motion/react'
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_STACK_VERTICAL_OVERFLOW,
} from './panel-constants'

const SIDEBAR_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }

interface RootSurfaceContainerProps {
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  contentSlot: React.ReactNode
  isCompact?: boolean
  isResizing?: boolean
}

export function RootSurfaceContainer({
  sidebarSlot,
  sidebarWidth,
  contentSlot,
  isCompact = false,
  isResizing,
}: RootSurfaceContainerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hasSidebar = sidebarWidth > 0
  const transition = (isResizing || isCompact) ? { duration: 0 } : SIDEBAR_SPRING

  if (isCompact) {
    return (
      <div
        ref={rootRef}
        data-mobile-menu-root="true"
        className="relative min-w-0 flex-1 panel-scroll @container/shell"
        style={{
          paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
          marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
          marginBottom: -6,
          paddingBottom: 6,
        }}
      >
        <div className="h-full min-w-0 flex-1 overflow-hidden">{contentSlot}</div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      data-mobile-menu-root="true"
      className="relative z-panel flex min-w-0 flex-1 panel-scroll @container/shell"
      style={{
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
        marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
        marginBottom: -6,
        paddingBottom: 6,
        paddingRight: 8,
        marginRight: -8,
      }}
    >
      <motion.div
        className="flex h-full"
        initial={false}
        animate={{ paddingLeft: !hasSidebar ? PANEL_EDGE_INSET : 0 }}
        transition={transition}
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}
      >
        <motion.div
          data-panel-role="sidebar"
          initial={false}
          animate={{
            width: hasSidebar ? sidebarWidth : 0,
            marginRight: hasSidebar ? 0 : -PANEL_GAP,
            opacity: hasSidebar ? 1 : 0,
          }}
          transition={transition}
          className="relative h-full shrink-0"
          style={{ overflowX: 'clip', overflowY: 'visible' }}
        >
          <div className="h-full" style={{ width: sidebarWidth }}>
            {sidebarSlot}
          </div>
        </motion.div>

        <div className="min-w-0 flex-1 overflow-hidden">{contentSlot}</div>
      </motion.div>
    </div>
  )
}
