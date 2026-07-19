import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Switch } from '../switch'
import { RichTextInput } from '../rich-text-input'
import { Popover, PopoverTrigger } from '../popover'
import { ContextMenu, ContextMenuTrigger } from '../context-menu'
import { SortableList } from '../sortable-list'
import { uiValidationAttributes } from '../ui-validation'

describe('UI primitive validation contract', () => {
  it('serializes only registered complex physical interactions', () => {
    expect(uiValidationAttributes('composer.input', ['ime', 'rich-text', 'ime'])).toEqual({
      'data-mortise-semantic-id': 'composer.input',
      'data-mortise-ui-interactions': 'ime rich-text',
    })
    expect(uiValidationAttributes(undefined, undefined)).toEqual({})
  })

  it('exposes stable switch identity and native checked state', () => {
    const markup = renderToStaticMarkup(<Switch semanticId="settings.enabled" aria-label="Enabled" defaultChecked />)
    expect(markup).toContain('data-slot="switch"')
    expect(markup).toContain('data-mortise-semantic-id="settings.enabled"')
    expect(markup).toContain('aria-checked="true"')
  })

  it('declares rich text, clipboard, shortcut and IME capabilities', () => {
    const markup = renderToStaticMarkup(
      <RichTextInput semanticId="composer.input" value="" onChange={() => {}} placeholder="Message" />,
    )
    expect(markup).toContain('data-slot="rich-text-input"')
    expect(markup).toContain('data-mortise-semantic-id="composer.input"')
    expect(markup).toContain('data-mortise-ui-interactions="shortcut clipboard ime rich-text"')
    expect(markup).toContain('role="textbox"')
  })

  it('forwards stable identities through portal trigger primitives', () => {
    const popover = renderToStaticMarkup(
      <Popover><PopoverTrigger semanticId="toolbar.filters">Filters</PopoverTrigger></Popover>,
    )
    const contextMenu = renderToStaticMarkup(
      <ContextMenu><ContextMenuTrigger semanticId="session.row">Session</ContextMenuTrigger></ContextMenu>,
    )
    expect(popover).toContain('data-mortise-semantic-id="toolbar.filters"')
    expect(contextMenu).toContain('data-mortise-semantic-id="session.row"')
  })

  it('derives stable draggable item identities from domain item IDs', () => {
    const markup = renderToStaticMarkup(
      <SortableList
        semanticId="planner.tasks"
        items={[{ id: 'task/one' }]}
        onReorder={() => {}}
        renderItem={item => <span>{item.id}</span>}
      />,
    )
    expect(markup).toMatch(/data-mortise-semantic-id="planner\.tasks\.item\.task_one\.[a-z0-9]+"/)
    expect(markup).toContain('data-mortise-ui-interactions="drag"')
  })
})
