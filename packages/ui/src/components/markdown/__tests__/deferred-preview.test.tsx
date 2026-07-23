import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createDeferredPdfBlock } from '../DeferredPdfBlock'
import { getMermaidReservedMinHeight, selectCurrentMermaidRender } from '../MarkdownMermaidBlock'
import { PDF_INLINE_BLOCK_HEIGHT } from '../preview-layout'

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalNavigator = globalThis.navigator

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
})

afterAll(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    navigator: originalNavigator,
    IS_REACT_ACT_ENVIRONMENT: false,
  })
})

async function renderDeferred(Component: React.ComponentType<{ code: string }>) {
  const container = document.createElement('div')
  let root: Root
  await React.act(async () => {
    root = createRoot(container)
    root.render(<Component code='{"src":"report.pdf"}' />)
  })
  return { container, root: root! }
}

describe('deferred preview boundaries', () => {
  it('keeps the PDF pending and resolved blocks at the same fixed height', async () => {
    let resolveModule!: (module: any) => void
    const Deferred = createDeferredPdfBlock(() => new Promise(resolve => { resolveModule = resolve }))
    const { container, root } = await renderDeferred(Deferred)

    expect(container.querySelector('[aria-busy="true"]')?.getAttribute('style'))
      .toContain(`height: ${PDF_INLINE_BLOCK_HEIGHT}px`)

    await React.act(async () => {
      resolveModule({ MarkdownPdfBlock: () => <div data-testid="pdf" style={{ height: `${PDF_INLINE_BLOCK_HEIGHT}px` }} /> })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="pdf"]')?.getAttribute('style'))
      .toContain(`height: ${PDF_INLINE_BLOCK_HEIGHT}px`)
    await React.act(async () => root.unmount())
  })

  it('contains a rejected PDF chunk and falls back to the source block', async () => {
    const warn = mock(() => {})
    const error = mock(() => {})
    const previousWarn = console.warn
    const previousError = console.error
    console.warn = warn
    console.error = error
    const Deferred = createDeferredPdfBlock(() => Promise.reject(new Error('chunk unavailable')))
    const { container, root } = await renderDeferred(Deferred)
    await React.act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain('report.pdf')
    expect(warn).toHaveBeenCalled()
    await React.act(async () => root.unmount())
    console.warn = previousWarn
    console.error = previousError
  })

  it('treats a prior Mermaid result as pending immediately after the code changes', () => {
    const oldRender = { source: 'graph TD; A-->B', svg: '<svg />', error: null }
    expect(selectCurrentMermaidRender(oldRender, oldRender.source)).toBe(oldRender)
    expect(selectCurrentMermaidRender(oldRender, 'graph TD; A-->C')).toBeNull()
  })

  it('uses one Mermaid minimum-height contract for pending and resolved states', () => {
    expect(getMermaidReservedMinHeight()).toBe(280)
    expect(getMermaidReservedMinHeight(140)).toBe(140)
  })
})
