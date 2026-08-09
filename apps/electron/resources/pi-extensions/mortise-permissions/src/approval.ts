import { defineExtensionUI, type ExtensionUIMountContext } from '@mortise/extension-ui'

type ApprovalRequest = {
  requestId: string
  type: 'permission' | 'admin_approval'
  toolName: string
  description: string
  command?: string
  appName?: string
  reason?: string
  impact?: string
  requiresSystemPrompt?: boolean
  rememberForMinutes?: number
}

type ApprovalState = { request?: ApprovalRequest | null; queueLength?: number }
type ApprovalMessage = {
  type: 'respond'
  requestId: string
  allowed: boolean
  alwaysAllow?: boolean
  rememberForMinutes?: number
}

const COPY = {
  en: {
    permissionTitle: 'Permission required',
    adminTitle: 'Administrator approval required',
    tool: 'Tool',
    why: 'Why',
    impact: 'Impact',
    adminLead: (name: string) => `Installing ${name} needs administrator approval.`,
    systemPrompt: 'Your operating system may show its normal password or biometric prompt.',
    allow: 'Allow',
    alwaysAllow: 'Always allow',
    deny: 'Deny',
    approve: 'Approve',
    cancel: 'Cancel',
    remember: (minutes: number) => `Remember for ${minutes} min`,
    queue: (count: number) => `${count - 1} more approval request${count === 2 ? '' : 's'} waiting`,
    tip: 'Always allow remembers this tool call for the current session.',
  },
  zh: {
    permissionTitle: '需要权限确认',
    adminTitle: '需要管理员批准',
    tool: '工具',
    why: '原因',
    impact: '影响',
    adminLead: (name: string) => `安装 ${name} 需要管理员批准。`,
    systemPrompt: '操作系统可能会显示常规密码或生物识别提示。',
    allow: '允许',
    alwaysAllow: '始终允许',
    deny: '拒绝',
    approve: '批准',
    cancel: '取消',
    remember: (minutes: number) => `记住 ${minutes} 分钟`,
    queue: (count: number) => `另有 ${count - 1} 个权限请求等待处理`,
    tip: '“始终允许”仅在当前会话中记住这次工具调用。',
  },
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (value !== undefined) node.textContent = value
  return node
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.classList.add('mortise-permission-icon')
  const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  pathNode.setAttribute('d', path)
  svg.append(pathNode)
  return svg
}

export const definition = defineExtensionUI({
  mount(context: ExtensionUIMountContext) {
    const copy = COPY[context.locale.toLowerCase().startsWith('zh') ? 'zh' : 'en']
    const channel = context.backend.channel<ApprovalState, ApprovalMessage>('permission-approval', { scope: 'session' })
    let request: ApprovalRequest | null = null
    let queueLength = 0
    let sending = false

    const root = element('div', 'mortise-permission-surface')

    const send = async (allowed: boolean, options: { alwaysAllow?: boolean; rememberForMinutes?: number } = {}) => {
      if (!request || sending) return
      sending = true
      render()
      try {
        await channel.send({
          type: 'respond',
          requestId: request.requestId,
          allowed,
          ...(options.alwaysAllow ? { alwaysAllow: true } : {}),
          ...(options.rememberForMinutes ? { rememberForMinutes: options.rememberForMinutes } : {}),
        })
      } finally {
        sending = false
        render()
      }
    }

    const button = (label: string, semanticId: string, className: string, path: string, action: () => void) => {
      const node = element('button', `mortise-permission-button ${className}`)
      node.type = 'button'
      node.disabled = sending
      node.dataset.mortiseUiSemantic = semanticId
      node.dataset.mortiseSemanticId = semanticId
      node.append(icon(path), element('span', undefined, label))
      node.addEventListener('click', action, { signal: context.signal })
      return node
    }

    const render = () => {
      root.replaceChildren()
      if (!request) return

      const card = element('section', 'mortise-permission-card')
      card.setAttribute('aria-live', 'polite')
      const body = element('div', 'mortise-permission-body')
      const title = element('div', 'mortise-permission-title')
      title.append(icon('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z'), element('span', undefined, request.type === 'admin_approval' ? copy.adminTitle : copy.permissionTitle))
      body.append(title)

      const description = element('div', 'mortise-permission-description')
      if (request.type === 'admin_approval') {
        description.append(copy.adminLead(request.appName ?? request.toolName))
        if (request.requiresSystemPrompt) description.append(` ${copy.systemPrompt}`)
        description.append(document.createElement('br'), element('strong', undefined, `${copy.why}:`), ` ${request.reason ?? request.description}`)
        if (request.impact) description.append(document.createElement('br'), element('strong', undefined, `${copy.impact}:`), ` ${request.impact}`)
      } else {
        description.append(element('strong', undefined, `${copy.tool}:`), ` ${request.toolName}`, document.createElement('br'), request.description)
      }
      body.append(description)
      if (request.command) body.append(element('pre', 'mortise-permission-command', request.command))
      if (queueLength > 1) body.append(element('div', 'mortise-permission-queue', copy.queue(queueLength)))

      const actions = element('div', 'mortise-permission-actions')
      if (request.type === 'admin_approval') {
        const remember = element('label', 'mortise-permission-remember')
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.className = 'mortise-permission-switch'
        input.dataset.mortiseUiSemantic = 'permissions.remember'
        input.dataset.mortiseSemanticId = 'permissions.remember'
        const minutes = Math.min(Math.max(Math.floor(request.rememberForMinutes ?? 10), 1), 60)
        remember.append(input, element('span', undefined, copy.remember(minutes)))
        actions.append(
          button(copy.approve, 'permissions.approve', 'primary', 'M20 6 9 17l-5-5', () => void send(true, input.checked ? { rememberForMinutes: minutes } : {})),
          button(copy.cancel, 'permissions.cancel', 'danger', 'M18 6 6 18M6 6l12 12', () => void send(false)),
          element('span', 'mortise-permission-spacer'),
          remember,
        )
      } else {
        actions.append(
          button(copy.allow, 'permissions.allow', 'primary', 'M20 6 9 17l-5-5', () => void send(true)),
          button(copy.alwaysAllow, 'permissions.always-allow', 'secondary', 'M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5', () => void send(true, { alwaysAllow: true })),
          button(copy.deny, 'permissions.deny', 'danger', 'M18 6 6 18M6 6l12 12', () => void send(false)),
          element('span', 'mortise-permission-tip', copy.tip),
        )
      }
      card.append(body, actions)
      root.append(card)
    }

    const apply = (snapshot: { state: unknown } | undefined) => {
      const state = snapshot?.state as ApprovalState | undefined
      request = state?.request ?? null
      queueLength = typeof state?.queueLength === 'number' ? state.queueLength : request ? 1 : 0
      sending = false
      render()
    }
    const unsubscribe = channel.subscribe(apply)
    apply(channel.getSnapshot())
    context.root.append(root)

    return () => {
      unsubscribe()
      context.root.replaceChildren()
    }
  },
})

export const mount = definition.mount
