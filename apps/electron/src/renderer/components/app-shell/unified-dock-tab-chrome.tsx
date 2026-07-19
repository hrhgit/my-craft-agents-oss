import * as React from 'react'
import {
  ChevronLeft,
  FileText,
  Globe2,
  MessageSquare,
  PictureInPicture2,
  Puzzle,
  Wrench,
} from 'lucide-react'
import {
  TabNode,
  type ITabRenderValues,
  type ITabSetRenderValues,
  type TabSetNode,
} from 'flexlayout-react'
import type { ContentKind } from '../../../shared/app-layout'

interface DockTabConfig {
  contentKind?: ContentKind
}

interface SelectedTabDetachOptions {
  enabled: boolean
  label: string
  canDetach: (node: TabNode) => boolean
  onDetach: (tabId: string) => void
}

interface CompactDockBackOptions {
  enabled: boolean
  label: string
  onBack: () => void
}

export function appendCompactDockBackControl(
  tabset: TabSetNode,
  renderValues: ITabSetRenderValues,
  options: CompactDockBackOptions,
): void {
  if (!options.enabled) return
  const model = tabset.getModel()
  const activeTabset = model.getActiveTabset() ?? model.getFirstTabSet()
  if (activeTabset !== tabset) return
  renderValues.leading = (
    <button
      type="button"
      className="flexlayout__tab_toolbar_button"
      data-mortise-semantic-id="workspace.compact.back-to-navigator"
      title={options.label}
      aria-label={options.label}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation()
        options.onBack()
      }}
    >
      <ChevronLeft className="size-4" />
    </button>
  )
}

export function customizeDockTab(node: TabNode, renderValues: ITabRenderValues): void {
  const config = (node.getConfig() ?? {}) as DockTabConfig
  renderValues.leading = iconForContentKind(config.contentKind)
  renderValues.content = (
    <span className="mortise-dock-tab-label">
      {renderValues.content}
    </span>
  )
}

export function appendSelectedTabDetachControl(
  tabset: TabSetNode,
  renderValues: ITabSetRenderValues,
  options: SelectedTabDetachOptions,
): void {
  if (!options.enabled) return

  const selected = tabset.getSelectedNode()
  if (!(selected instanceof TabNode) || !options.canDetach(selected)) return

  renderValues.buttons.push(
    <button
      key="detach-selected-tab"
      type="button"
      className="flexlayout__tab_toolbar_button"
      data-mortise-semantic-id={`workspace.detach-tab.${selected.getId()}`}
      title={options.label}
      aria-label={options.label}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation()
        options.onDetach(selected.getId())
      }}
    >
      <PictureInPicture2 className="size-3.5" />
    </button>,
  )
}

function iconForContentKind(kind: ContentKind | undefined): React.ReactNode {
  if (kind === 'file') return <FileText className="size-3.5" />
  if (kind === 'browser') return <Globe2 className="size-3.5" />
  if (kind === 'extension') return <Puzzle className="size-3.5" />
  if (kind === 'tool' || kind === 'navigation') return <Wrench className="size-3.5" />
  return <MessageSquare className="size-3.5" />
}
