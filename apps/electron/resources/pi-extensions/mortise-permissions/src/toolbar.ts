import { defineExtensionUI, type ExtensionUIMountContext } from '@mortise/extension-ui'

type Mode = 'ask' | 'allow-all'
type ModeState = { mode?: Mode }
type ModeCopy = Record<Mode, { label: string; description: string }>

const MODE_COPY: Record<'en' | 'zh', ModeCopy> = {
  en: {
    ask: { label: 'Ask', description: 'Prompts before making edits.' },
    'allow-all': { label: 'Always allow', description: 'Always approves tool calls.' },
  },
  zh: {
    ask: { label: '询问', description: '编辑前先确认。' },
    'allow-all': { label: '始终批准', description: '始终批准工具调用。' },
  },
}

const MODE_STYLE: Record<Mode, { tone: 'info' | 'accent'; icon: string }> = {
  ask: { tone: 'info', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01' },
  'allow-all': { tone: 'accent', icon: 'm17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3' },
}

function icon(path: string, className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('class', className)
  const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  pathNode.setAttribute('d', path)
  svg.append(pathNode)
  return svg
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function currentMode(channel: { getSnapshot(): { state: unknown } | undefined }): Mode {
  const value = channel.getSnapshot()?.state as ModeState | undefined
  return value?.mode === 'allow-all' ? 'allow-all' : 'ask'
}

export const definition = defineExtensionUI({
  mount(context: ExtensionUIMountContext) {
    const isChinese = context.locale.toLowerCase().startsWith('zh')
    const copy = MODE_COPY[isChinese ? 'zh' : 'en']
    const channel = context.backend.channel<ModeState, { mode: Mode }>('permission-mode', { scope: 'session' })
    let mode = currentMode(channel)
    let open = false

    const root = createElement('div', 'mortise-permissions-toolbar')
    const trigger = createElement('button', 'mortise-permissions-mode-trigger')
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    const menu = createElement('div', 'mortise-permissions-mode-menu')
    menu.setAttribute('role', 'menu')
    menu.hidden = true

    const render = () => {
      const info = { ...copy[mode], ...MODE_STYLE[mode] }
      trigger.replaceChildren(icon(info.icon, 'mortise-permissions-mode-icon'), createElement('span', 'mortise-permissions-mode-label', info.label), icon('M6 9l6 6 6-6', 'mortise-permissions-chevron'))
      trigger.className = `mortise-permissions-mode-trigger mortise-permissions-tone-${info.tone}`
      trigger.style.setProperty('--shadow-color', `var(--${info.tone}-rgb)`)
      trigger.setAttribute('aria-label', `${isChinese ? '权限模式' : 'Permission mode'}: ${info.label}`)
      trigger.setAttribute('aria-expanded', String(open))
      menu.hidden = !open
      menu.replaceChildren()
      for (const candidate of Object.keys(MODE_STYLE) as Mode[]) {
        const candidateInfo = { ...copy[candidate], ...MODE_STYLE[candidate] }
        const item = createElement('button', 'mortise-permissions-mode-item')
        item.type = 'button'
        item.setAttribute('role', 'menuitemradio')
        item.setAttribute('aria-checked', String(candidate === mode))
        const itemIcon = createElement('span', `mortise-permissions-item-icon mortise-permissions-tone-${candidateInfo.tone}`)
        itemIcon.append(icon(candidateInfo.icon, 'mortise-permissions-option-icon'))
        const itemCopy = createElement('span', 'mortise-permissions-item-copy')
        itemCopy.append(createElement('strong', undefined, candidateInfo.label), createElement('small', undefined, candidateInfo.description))
        item.append(itemIcon, itemCopy)
        if (candidate === mode) item.append(icon('M5 12l4 4L19 6', 'mortise-permissions-check'))
        item.addEventListener('click', () => {
          mode = candidate
          open = false
          render()
          void channel.send({ mode: candidate })
        }, { signal: context.signal })
        menu.append(item)
      }
    }

    trigger.addEventListener('click', () => { open = !open; render() }, { signal: context.signal })
    document.addEventListener('click', (event) => {
      const path = event.composedPath()
      if (open && !path.includes(root) && !path.includes(menu)) { open = false; render() }
    }, { signal: context.signal })
    document.addEventListener('keydown', (event) => {
      if (open && event.key === 'Escape') { open = false; render(); trigger.focus() }
    }, { signal: context.signal })
    const unsubscribe = channel.subscribe((snapshot) => {
      const next = (snapshot.state as ModeState | undefined)?.mode
      if (next === 'ask' || next === 'allow-all') { mode = next; render() }
    })
    context.semantics.register('permissions.mode.trigger', trigger)
    root.append(trigger, menu)
    context.root.append(root)
    render()

    return () => {
      unsubscribe()
      context.root.replaceChildren()
    }
  },
})

export const mount = definition.mount
export const toolbarInternals = { MODE_COPY, MODE_STYLE, currentMode }
