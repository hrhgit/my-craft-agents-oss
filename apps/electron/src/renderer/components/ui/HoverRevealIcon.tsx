import type { LucideIcon } from "lucide-react"
import type { MouseEvent } from "react"

import { cn } from "@/lib/utils"

export interface HoverRevealIconProps {
  /** Lucide icon component to reveal on hover */
  icon: LucideIcon
  /** Click handler — caller is responsible for stopPropagation if needed */
  onClick?: (e: MouseEvent<HTMLSpanElement>) => void
  /** Extra classes merged onto the wrapping span */
  className?: string
  /** Classes applied to the icon itself (size, color, rotation, etc.) */
  iconClassName?: string
  /** Tooltip / title attribute */
  title?: string
  /** When true, renders data-no-dnd="true" (prevents drag activation on click) */
  dataNoDnd?: boolean
  /** When true, renders data-touch-reveal="true" (revealed on touch) */
  dataTouchReveal?: boolean
}

/**
 * HoverRevealIcon
 *
 * An icon hidden by default (`opacity-0`) and faded in when the parent
 * `group` is hovered (`group-hover:opacity-100`). Used for toggle chevrons
 * and action icons that overlay a default icon and appear on hover.
 *
 * The wrapping span is absolutely positioned to cover its relative parent,
 * matching the standard "icon swap on hover" pattern used in LeftSidebar
 * and SessionFilesSection.
 */
export function HoverRevealIcon({
  icon: Icon,
  onClick,
  className,
  iconClassName,
  title,
  dataNoDnd,
  dataTouchReveal,
}: HoverRevealIconProps) {
  return (
    <span
      className={cn(
        "absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer",
        className,
      )}
      data-no-dnd={dataNoDnd ? "true" : undefined}
      data-touch-reveal={dataTouchReveal ? "true" : undefined}
      onClick={onClick}
      title={title}
    >
      <Icon className={iconClassName} />
    </span>
  )
}
