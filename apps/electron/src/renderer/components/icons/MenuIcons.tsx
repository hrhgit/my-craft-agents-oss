/**
 * Static Lucide icon registry for app menus.
 *
 * Menu schemas reference icons by name string; resolving them through
 * `import * as Icons` + `Icons[name]` disables tree-shaking and pulls the
 * entire icon library (1.4MB+) into the renderer main bundle. Keep this
 * registry to exactly the icon names used by menu schemas.
 */
import {
  AppWindow,
  Bug,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  Focus,
  HelpCircle,
  Keyboard,
  LogOut,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pencil,
  Redo2,
  RotateCcw,
  Scissors,
  SquarePen,
  TextSelect,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const MENU_ICONS: Readonly<Record<string, LucideIcon>> = {
  AppWindow,
  Bug,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  Focus,
  HelpCircle,
  Keyboard,
  LogOut,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pencil,
  Redo2,
  RotateCcw,
  Scissors,
  SquarePen,
  TextSelect,
  Undo2,
  ZoomIn,
  ZoomOut,
}

export function getMenuIcon(name: string): LucideIcon | null {
  return MENU_ICONS[name] ?? null
}
