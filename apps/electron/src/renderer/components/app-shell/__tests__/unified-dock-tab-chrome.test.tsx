import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { Actions, Model, TabNode, TabSetNode, type ITabRenderValues, type ITabSetRenderValues } from 'flexlayout-react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  appendCompactDockBackControl,
  appendSelectedTabDetachControl,
  customizeDockTab,
} from '../unified-dock-tab-chrome'

function createTabset(): TabSetNode {
  const model = Model.fromJson({
    global: {},
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: 'main',
        selected: 0,
        children: [
          { type: 'tab', id: 'selected', name: 'Selected', component: 'craft-content' },
          { type: 'tab', id: 'unselected', name: 'Unselected', component: 'craft-content' },
        ],
      }],
    },
  })
  return model.getNodeById('main') as TabSetNode
}

function tabRenderValues(node: TabNode): ITabRenderValues {
  return { leading: null, content: node.getName(), buttons: [] }
}

function tabsetRenderValues(): ITabSetRenderValues {
  return { leading: null, stickyButtons: [], buttons: [], overflowPosition: undefined }
}

function renderTab(node: TabNode, selected: boolean): string {
  const values = tabRenderValues(node)
  customizeDockTab(node, values)
  return renderToStaticMarkup(
    <div role="tab" tabIndex={selected ? 0 : -1}>
      {values.leading}
      {values.content}
      {values.buttons}
    </div>,
  )
}

describe('unified dock tab accessibility', () => {
  it('adds a compact back control without changing the selected tab', () => {
    const tabset = createTabset()
    const toolbar = tabsetRenderValues()
    let backed = false
    appendCompactDockBackControl(tabset, toolbar, {
      enabled: true,
      label: 'Back to list',
      onBack: () => { backed = true },
    })

    const control = toolbar.leading as React.ReactElement<{
      onClick: (event: { stopPropagation: () => void }) => void
    }>
    expect(renderToStaticMarkup(control)).toContain('workspace.compact.back-to-navigator')
    control.props.onClick({ stopPropagation: () => {} })
    expect(backed).toBe(true)
    expect(tabset.getSelectedNode()?.getId()).toBe('selected')
  })

  it('keeps detach outside every tab and exposes it only for the selected tab', () => {
    const tabset = createTabset()
    const selected = tabset.getChildren()[0] as TabNode
    const unselected = tabset.getChildren()[1] as TabNode
    const selectedTabHtml = renderTab(selected, true)
    const unselectedTabHtml = renderTab(unselected, false)
    const toolbar = tabsetRenderValues()

    appendSelectedTabDetachControl(tabset, toolbar, {
      enabled: true,
      label: 'Detach tab',
      canDetach: () => true,
      onDetach: () => {},
    })
    const toolbarHtml = renderToStaticMarkup(<div role="toolbar">{toolbar.buttons}</div>)

    expect(selectedTabHtml).not.toContain('<button')
    expect(unselectedTabHtml).toContain('tabindex="-1"')
    expect(unselectedTabHtml).not.toContain('<button')
    expect(toolbarHtml).toContain('workspace.detach-tab.selected')
    expect(toolbarHtml).not.toContain('workspace.detach-tab.unselected')
  })

  it('tracks selection changes without leaving a detach control for the old tab', () => {
    const tabset = createTabset()
    const model = tabset.getModel()
    model.doAction(Actions.selectTab('unselected'))
    const toolbar = tabsetRenderValues()

    appendSelectedTabDetachControl(tabset, toolbar, {
      enabled: true,
      label: 'Detach tab',
      canDetach: () => true,
      onDetach: () => {},
    })
    const toolbarHtml = renderToStaticMarkup(<div role="toolbar">{toolbar.buttons}</div>)

    expect(toolbarHtml).toContain('workspace.detach-tab.unselected')
    expect(toolbarHtml).not.toContain('workspace.detach-tab.selected')
    expect(toolbarHtml.match(/<button/g)).toHaveLength(1)
  })
})
