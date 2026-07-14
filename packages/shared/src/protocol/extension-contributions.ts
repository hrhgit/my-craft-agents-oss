export const EXTENSION_UI_SURFACES = [
  'conversation.timeline.before', 'conversation.timeline.after',
  'conversation.turn.before', 'conversation.turn.after', 'conversation.turn.replace',
  'conversation.message.before', 'conversation.message.after', 'conversation.message.replace',
  'conversation.tool.before', 'conversation.tool.after', 'conversation.tool.replace',
  'conversation.inline', 'conversation.overlay',
  'composer.above', 'composer.below', 'composer.toolbar', 'composer.status', 'composer.replace',
  'sidebar.header', 'sidebar.section', 'sidebar.footer',
  'navigation.item', 'session.badge',
  'window.topLeft', 'window.topRight',
] as const

export type ExtensionUISurface = typeof EXTENSION_UI_SURFACES[number]
export type ExtensionUITone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger'
export type ExtensionUIIconName = 'activity' | 'alert-circle' | 'check' | 'chevron-right' | 'circle' | 'clock' | 'info' | 'loader' | 'settings' | 'sparkles' | 'x'
export type ExtensionUIAction = { kind: 'command'; command: string; args?: string }
export type ExtensionUINode =
  | { type: 'text'; text: string; tone?: Exclude<ExtensionUITone, 'info'> }
  | { type: 'markdown'; markdown: string }
  | { type: 'icon'; name: ExtensionUIIconName; label: string }
  | { type: 'badge'; label: string; tone?: Exclude<ExtensionUITone, 'muted'> }
  | { type: 'divider' }
  | { type: 'button'; label: string; icon?: ExtensionUIIconName; action: ExtensionUIAction; disabled?: boolean }
  | {
      type: 'sandbox-app'
      appId: string
      title: string
      html: string
      css?: string
      script?: string
      initialState?: unknown
      minHeight?: number
      maxHeight?: number
      preferredHeight?: number
      permissions?: Array<'commands' | 'theme' | 'storage' | 'resize' | 'validation'>
    }
  | { type: 'row' | 'stack'; children: ExtensionUINode[]; gap?: 'none' | 'small' | 'medium' }

/** Serializable UI definition supplied by an extension. Host identity is deliberately absent. */
export interface ExtensionContributionV1 {
  schemaVersion: 1
  id: string
  surface: ExtensionUISurface
  content: ExtensionUINode
  priority?: number
  order?: number
  group?: string
  collapse?: 'never' | 'auto' | 'always'
  overflow?: 'menu' | 'collapse' | 'hide'
  exclusive?: boolean
  target?: { turnId?: string; messageId?: string; toolCallId?: string }
}

export type ExtensionContributionDeltaV1 = {
  schemaVersion: 1
  extensionId: string
  sessionId: string
  runtimeId: string
  revision: number
} & (
  | { operation: 'upsert'; contribution: ExtensionContributionV1 }
  | { operation: 'remove'; contributionId: string }
  | { operation: 'reset' }
  | { operation: 'snapshot'; contributions: ExtensionContributionV1[] }
)

const surfaceSet = new Set<string>(EXTENSION_UI_SURFACES)
const iconSet = new Set<string>(['activity', 'alert-circle', 'check', 'chevron-right', 'circle', 'clock', 'info', 'loader', 'settings', 'sparkles', 'x'])
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))

function validateNode(value: unknown, depth = 0, count = { value: 0 }): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'content must be a declarative node object'
  if (depth > 8 || ++count.value > 256) return 'content tree is too large'
  const node = value as Record<string, unknown>
  if (node.type === 'text') {
    if (!onlyKeys(node, ['type', 'text', 'tone'])) return 'Unsupported text node field'
    if (node.tone !== undefined && !['default', 'muted', 'success', 'warning', 'danger'].includes(String(node.tone))) return 'Unsupported text tone'
    return boundedString(node.text, 20_000) ? null : 'text must be a bounded non-empty string'
  }
  if (node.type === 'markdown') {
    if (!onlyKeys(node, ['type', 'markdown'])) return 'Unsupported markdown node field'
    return boundedString(node.markdown, 100_000) ? null : 'markdown must be a bounded non-empty string'
  }
  if (node.type === 'divider') return onlyKeys(node, ['type']) ? null : 'Unsupported divider node field'
  if (node.type === 'icon') {
    if (!onlyKeys(node, ['type', 'name', 'label'])) return 'Unsupported icon node field'
    if (!iconSet.has(String(node.name))) return 'Unsupported icon name'
    return boundedString(node.label, 256) ? null : 'icon label is required'
  }
  if (node.type === 'badge') {
    if (!onlyKeys(node, ['type', 'label', 'tone'])) return 'Unsupported badge node field'
    if (node.tone !== undefined && !['default', 'info', 'success', 'warning', 'danger'].includes(String(node.tone))) return 'Unsupported badge tone'
    return boundedString(node.label, 256) ? null : 'badge label is required'
  }
  if (node.type === 'button') {
    if (!onlyKeys(node, ['type', 'label', 'icon', 'action', 'disabled'])) return 'Unsupported button node field'
    if (!boundedString(node.label, 256)) return 'button label is required'
    if (node.icon !== undefined && !iconSet.has(String(node.icon))) return 'Unsupported button icon'
    if (!node.action || typeof node.action !== 'object' || Array.isArray(node.action)) return 'button action is required'
    const action = node.action as Record<string, unknown>
    if (!onlyKeys(action, ['kind', 'command', 'args'])) return 'Unsupported button action field'
    if (action.kind !== 'command' || !boundedString(action.command, 256)) return 'button action must reference a command'
    if (action.args !== undefined && (typeof action.args !== 'string' || action.args.length > 20_000)) return 'button action args are too large'
    if (node.disabled !== undefined && typeof node.disabled !== 'boolean') return 'button disabled must be boolean'
    return null
  }
  if (node.type === 'sandbox-app') {
    if (!onlyKeys(node, ['type', 'appId', 'title', 'html', 'css', 'script', 'initialState', 'minHeight', 'maxHeight', 'preferredHeight', 'permissions'])) return 'Unsupported sandbox app field'
    if (!boundedString(node.appId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(node.appId as string)) return 'sandbox appId must be a stable identifier'
    if (!boundedString(node.title, 256)) return 'sandbox title is required'
    if (typeof node.html !== 'string' || node.html.length > 524_288) return 'sandbox html is too large'
    if (node.css !== undefined && (typeof node.css !== 'string' || node.css.length > 262_144)) return 'sandbox css is too large'
    if (node.script !== undefined && (typeof node.script !== 'string' || node.script.length > 524_288)) return 'sandbox script is too large'
    if ((node.html as string).length + (typeof node.css === 'string' ? node.css.length : 0) + (typeof node.script === 'string' ? node.script.length : 0) > 1_048_576) return 'sandbox bundle is too large'
    for (const key of ['minHeight', 'maxHeight', 'preferredHeight'] as const) {
      if (node[key] !== undefined && (!Number.isInteger(node[key]) || Number(node[key]) < 80 || Number(node[key]) > 1600)) return `${key} must be an integer between 80 and 1600`
    }
    const min = typeof node.minHeight === 'number' ? node.minHeight : 120
    const max = typeof node.maxHeight === 'number' ? node.maxHeight : 720
    const preferred = typeof node.preferredHeight === 'number' ? node.preferredHeight : min
    if (min > max || preferred < min || preferred > max) return 'sandbox height bounds are inconsistent'
    if (node.permissions !== undefined) {
      if (!Array.isArray(node.permissions) || node.permissions.length > 5 || new Set(node.permissions).size !== node.permissions.length) return 'sandbox permissions must be a unique bounded array'
      if (node.permissions.some(permission => !['commands', 'theme', 'storage', 'resize', 'validation'].includes(String(permission)))) return 'Unsupported sandbox permission'
    }
    if (node.initialState !== undefined) {
      try {
        const serialized = JSON.stringify(node.initialState)
        if (serialized === undefined || serialized.length > 65_536) return 'sandbox initialState is too large'
      } catch {
        return 'sandbox initialState must be JSON serializable'
      }
    }
    return null
  }
  if (node.type === 'row' || node.type === 'stack') {
    if (!onlyKeys(node, ['type', 'children', 'gap'])) return 'Unsupported container node field'
    if (!Array.isArray(node.children) || node.children.length > 64) return 'container children must be a bounded array'
    if (node.gap !== undefined && !['none', 'small', 'medium'].includes(String(node.gap))) return 'Unsupported container gap'
    for (const child of node.children) {
      const error = validateNode(child, depth + 1, count)
      if (error) return error
    }
    return null
  }
  return 'Unsupported contribution node type'
}

function containsSandboxNode(value: ExtensionUINode): boolean {
  if (value.type === 'sandbox-app') return true
  if (value.type === 'row' || value.type === 'stack') return value.children.some(containsSandboxNode)
  return false
}

function validateCompactSurfaceNode(value: ExtensionUINode, depth = 0): string | null {
  if (depth > 2) return 'Compact surface content is too deeply nested'
  if (value.type === 'markdown' || value.type === 'stack' || value.type === 'divider' || value.type === 'sandbox-app') return `Compact surfaces do not support ${value.type}`
  if (value.type === 'text' && value.text.length > 512) return 'Compact surface text is too long'
  if (value.type === 'row') {
    if (value.children.length > 8) return 'Compact surface rows support at most 8 children'
    for (const child of value.children) {
      const error = validateCompactSurfaceNode(child, depth + 1)
      if (error) return error
    }
  }
  return null
}

export function validateExtensionContributionV1(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Contribution must be an object'
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1) return 'Unsupported contribution schema version'
  if (!onlyKeys(item, ['schemaVersion', 'id', 'surface', 'content', 'priority', 'order', 'group', 'collapse', 'overflow', 'exclusive', 'target'])) return 'Unsupported contribution field'
  if (!boundedString(item.id, 256)) return 'id must be a non-empty bounded string'
  if (!surfaceSet.has(String(item.surface))) return 'Unsupported contribution surface'
  if (item.priority !== undefined && (!Number.isInteger(item.priority) || Number(item.priority) < -1000 || Number(item.priority) > 1000)) return 'priority must be an integer between -1000 and 1000'
  if (item.order !== undefined && (!Number.isInteger(item.order) || Number(item.order) < -10000 || Number(item.order) > 10000)) return 'order must be a bounded integer'
  if (item.group !== undefined && !boundedString(item.group, 128)) return 'group must be a bounded string'
  if (item.collapse !== undefined && !['never', 'auto', 'always'].includes(String(item.collapse))) return 'Unsupported collapse policy'
  if (item.overflow !== undefined && !['menu', 'collapse', 'hide'].includes(String(item.overflow))) return 'Unsupported overflow policy'
  if (item.exclusive !== undefined && typeof item.exclusive !== 'boolean') return 'exclusive must be boolean'
  const surface = String(item.surface)
  if (item.target !== undefined) {
    if (!item.target || typeof item.target !== 'object' || Array.isArray(item.target)) return 'target must be an object'
    const target = item.target as Record<string, unknown>
    if (!onlyKeys(target, ['turnId', 'messageId', 'toolCallId'])) return 'Unsupported target field'
    if (!['turnId', 'messageId', 'toolCallId'].some(key => target[key] !== undefined)) return 'target must identify an entity'
    for (const key of ['turnId', 'messageId', 'toolCallId']) if (target[key] !== undefined && !boundedString(target[key], 256)) return `${key} must be a bounded string`
  }
  if (surface.startsWith('conversation.message.') && (!item.target || !boundedString((item.target as Record<string, unknown>).messageId, 256))) return 'message surfaces require target.messageId'
  if (surface.startsWith('conversation.tool.') && (!item.target || !boundedString((item.target as Record<string, unknown>).toolCallId, 256))) return 'tool surfaces require target.toolCallId'
  if (surface.startsWith('conversation.turn.') && (!item.target || !boundedString((item.target as Record<string, unknown>).turnId, 256))) return 'turn surfaces require target.turnId'
  const nodeError = validateNode(item.content)
  if (nodeError) return nodeError
  if (['composer.toolbar', 'composer.status', 'window.topLeft', 'window.topRight', 'navigation.item', 'session.badge'].includes(surface)) {
    return validateCompactSurfaceNode(item.content as ExtensionUINode)
  }
  const sandboxSurfaces = new Set(['conversation.timeline.before', 'conversation.timeline.after', 'conversation.turn.before', 'conversation.turn.after', 'conversation.turn.replace', 'conversation.message.before', 'conversation.message.after', 'conversation.message.replace', 'conversation.tool.before', 'conversation.tool.after', 'conversation.tool.replace', 'conversation.inline', 'conversation.overlay', 'composer.above', 'composer.below', 'composer.replace', 'sidebar.section'])
  const content = item.content as ExtensionUINode
  if ((content.type === 'row' || content.type === 'stack') && containsSandboxNode(content)) return 'Sandbox apps must be the top-level contribution node'
  if (content.type === 'sandbox-app' && !sandboxSurfaces.has(surface)) return 'Sandbox apps are not allowed on this surface'
  if (item.target !== undefined && !surface.startsWith('conversation.message.') && !surface.startsWith('conversation.tool.') && !surface.startsWith('conversation.turn.')) return 'This surface does not accept a target'
  return null
}

export function validateExtensionContributionDeltaV1(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Contribution delta must be an object'
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1) return 'Unsupported contribution delta schema version'
  for (const key of ['extensionId', 'sessionId', 'runtimeId'] as const) {
    if (!boundedString(item[key], 256)) return `${key} must be a non-empty bounded string`
  }
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1) return 'revision must be a positive safe integer'
  if (item.operation === 'upsert') return validateExtensionContributionV1(item.contribution)
  if (item.operation === 'remove') return boundedString(item.contributionId, 256) ? null : 'contributionId must be a bounded string'
  if (item.operation === 'reset') return null
  if (item.operation === 'snapshot') {
    if (!Array.isArray(item.contributions) || item.contributions.length > 256) return 'contributions must be a bounded array'
    for (const contribution of item.contributions) {
      const error = validateExtensionContributionV1(contribution)
      if (error) return error
    }
    return null
  }
  return 'Unsupported contribution operation'
}
