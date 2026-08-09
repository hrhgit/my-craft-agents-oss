import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { definition as toolbarDefinition } from './src/toolbar'
import { definition as approvalDefinition } from './src/approval'

let dom: JSDOM

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mortise.local' })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    SVGSVGElement: dom.window.SVGSVGElement,
    navigator: dom.window.navigator,
  })
})

afterEach(() => dom.window.close())

function contextFor(state: unknown, locale = 'en') {
  const listeners = new Set<(snapshot: { revision: number; state: unknown }) => void>()
  const messages: unknown[] = []
  const controller = new dom.window.AbortController()
  const host = document.createElement('div')
  const shadowRoot = host.attachShadow({ mode: 'open' })
  const root = document.createElement('div')
  shadowRoot.append(root)
  document.body.append(host)
  const channel = {
    getSnapshot: () => ({ revision: 1, state }),
    subscribe(listener: (snapshot: { revision: number; state: unknown }) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    async send(message: unknown) { messages.push(message); return state },
  }
  const context = {
    root,
    surface: 'composer.toolbar',
    mode: 'append',
    scope: 'session',
    route: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    signal: controller.signal,
    theme: { mode: 'light', tokens: {} },
    locale,
    notify() {},
    semantics: { rootId: 'test', register() { return () => undefined } },
    backend: { channel: () => channel },
    dependencies: { extension: () => ({ module: () => ({ load: async () => ({}) }) }) },
    host: { get: () => null, query: () => null, queryAll: () => [], watch: () => () => undefined },
  }
  return { context: context as never, root, messages }
}

describe('Mortise permissions extension UI parity', () => {
  it('keeps the legacy compact selector dimensions', () => {
    const styles = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('.mortise-permissions-mode-trigger { height: 32px; padding: 0 12px 0 10px;')
    expect(styles).toContain('.mortise-permissions-mode-icon { width: 14px; height: 14px;')
    expect(styles).toContain('.mortise-permissions-option-icon { width: 16px; height: 16px;')
    expect(styles).toContain('bottom: calc(100% + 4px); left: 0; min-width: 220px;')
  })

  it('matches the legacy compact selector labels, icons, and mode interaction', async () => {
    const fixture = contextFor({ mode: 'ask' }, 'zh-Hans')
    const dispose = toolbarDefinition.mount(fixture.context) as () => void

    const trigger = fixture.root.querySelector<HTMLButtonElement>('.mortise-permissions-mode-trigger')!
    expect(trigger.textContent).toContain('询问')
    expect(trigger.querySelector('.mortise-permissions-mode-icon')).not.toBeNull()
    trigger.click()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const menu = fixture.root.querySelector<HTMLElement>('.mortise-permissions-mode-menu')!
    expect(menu.hidden).toBe(false)
    expect(menu.parentElement).not.toBe(document.body)

    const options = [...menu.querySelectorAll<HTMLButtonElement>('.mortise-permissions-mode-item')]
    expect(options.map(option => option.textContent)).toEqual([
      expect.stringContaining('询问编辑前先确认。'),
      expect.stringContaining('始终批准始终批准工具调用。'),
    ])
    expect(options.every(option => option.querySelector('.mortise-permissions-option-icon'))).toBe(true)

    options[1].click()
    expect(fixture.messages).toEqual([{ mode: 'allow-all' }])
    expect(trigger.textContent).toContain('始终批准')
    dispose()
    expect(fixture.root.querySelector('.mortise-permissions-mode-menu')).toBeNull()
  })

  it('renders and responds through the extension-owned approval frontend', async () => {
    const request = {
      requestId: 'approval-1',
      type: 'permission',
      toolName: 'write',
      description: 'write: out.txt',
      command: 'out.txt',
    }
    const fixture = contextFor({ request, queueLength: 2 }, 'zh-Hans')
    const dispose = approvalDefinition.mount(fixture.context) as () => void

    expect(fixture.root.textContent).toContain('需要权限确认')
    expect(fixture.root.textContent).toContain('另有 1 个权限请求等待处理')
    const allow = fixture.root.querySelector<HTMLButtonElement>('[data-mortise-semantic-id="permissions.allow"]')!
    allow.click()
    await Promise.resolve()
    expect(fixture.messages).toEqual([{ type: 'respond', requestId: 'approval-1', allowed: true }])

    dispose()
    expect(fixture.root.childElementCount).toBe(0)
  })
})
