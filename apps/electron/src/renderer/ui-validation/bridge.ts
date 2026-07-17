import { uiSemanticRegistry } from './semantic-registry'
import type { UiSemanticBridge } from './types'

export function installUiSemanticBridge(): boolean {
  if (typeof window === 'undefined' || !isUiValidationHostEnabled()) return false
  const hadBootstrap = window.__craftUiValidation !== undefined
  const existing = window.__craftUiValidation ?? {}
  if (existing.semanticBridgeInstalled === true) return true
  const bridge: UiSemanticBridge = {
    schemaVersion: 1,
    snapshot: options => mergeAutomaticSemantics(uiSemanticRegistry.snapshot(options)),
    action: request => uiSemanticRegistry.invoke(request.id, request.action, { value: request.value }),
  }
  Object.assign(existing, bridge)
  existing.semanticBridgeInstalled = true
  if (!hadBootstrap) {
    Object.defineProperty(window, '__craftUiValidation', { value: existing, configurable: false, enumerable: false })
  }
  uiSemanticRegistry.subscribe(() => {
    existing.semanticRevision = uiSemanticRegistry.revision
    // The Web adapter owns a monotonic page revision counter on this bootstrap
    // object. Semantic-only command/state changes participate in that same clock.
    if (hadBootstrap && typeof existing.revision === 'number') existing.revision += 1
  })
  existing.semanticRevision = uiSemanticRegistry.revision
  return true
}

function mergeAutomaticSemantics(snapshot: ReturnType<typeof uiSemanticRegistry.snapshot>): ReturnType<typeof uiSemanticRegistry.snapshot> {
  const seen = new Set(snapshot.nodes.map(node => node.id))
  const automatic = collectAutomaticSemantics().filter(node => !seen.has(node.id))
  const nodes = [...snapshot.nodes, ...automatic].slice(0, snapshot.limits.maxNodes)
  return { ...snapshot, nodes, truncated: snapshot.truncated || snapshot.nodes.length + automatic.length > nodes.length }
}

function collectAutomaticSemantics(): ReturnType<typeof uiSemanticRegistry.snapshot>['nodes'] {
  const selector = [
    '[data-craft-semantic-id]',
    '[data-craft-ui-interactions]',
    '[data-testid]',
    '[data-slot="button"]',
    '[data-slot="input"]',
    '[data-slot="textarea"]',
    '[data-slot="select-trigger"]',
    '[data-slot="select-item"]',
    '[data-slot="tabs-trigger"]',
    '[data-slot="switch"]',
    '[data-slot="popover-trigger"]',
    '[data-slot="popover-content"]',
    '[data-slot="dropdown-menu-trigger"]',
    '[data-slot="dropdown-menu-item"]',
    '[data-slot="dropdown-menu-checkbox-item"]',
    '[data-slot="dropdown-menu-radio-item"]',
    '[data-slot="dropdown-menu-sub-trigger"]',
    '[data-slot="context-menu-trigger"]',
    '[data-slot="context-menu-content"]',
    '[data-slot="context-menu-item"]',
    '[data-slot="context-menu-checkbox-item"]',
    '[data-slot="context-menu-radio-item"]',
    '[data-slot="context-menu-sub-trigger"]',
    '[data-slot="entity-row"]',
    '[data-slot="sortable-list"]',
    '[data-slot="sortable-item"]',
    '[data-slot="rich-text-input"]',
    '[role="navigation"]',
    '[data-slot="dialog-content"]',
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]',
    '[data-sonner-toast]',
  ].join(',')
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible)
  const drafts = candidates.map(element => automaticNode(element)).filter((node): node is NonNullable<typeof node> => node !== null)
  return disambiguateAutomaticNodes(drafts)
}

type AutomaticSemanticNode = ReturnType<typeof uiSemanticRegistry.snapshot>['nodes'][number]

/** Preserve explicit duplicate IDs so target resolution reports AMBIGUOUS_TARGET. */
export function disambiguateAutomaticNodes(nodes: AutomaticSemanticNode[]): AutomaticSemanticNode[] {
  const groups = new Map<string, AutomaticSemanticNode[]>()
  for (const node of nodes) groups.set(node.id, [...(groups.get(node.id) ?? []), node])
  return nodes.map((node) => {
    const duplicates = groups.get(node.id) ?? []
    if (duplicates.length < 2 || node.domSelector.startsWith('[data-craft-semantic-id=')) return node
    return { ...node, id: `${node.id}.${stableHash(node.domSelector)}` }
  })
}

function automaticNode(element: HTMLElement): ReturnType<typeof uiSemanticRegistry.snapshot>['nodes'][number] | null {
  const explicitId = element.dataset.craftSemanticId
  const testId = element.getAttribute('data-testid') ?? undefined
  const role = implicitRole(element)
  const name = accessibleName(element)
  let id = explicitId
  let domSelector: string
  if (id) {
    domSelector = `[data-craft-semantic-id="${CSS.escape(id)}"]`
  } else if (role === 'navigation') {
    id = `navigation.${slug(name || 'main')}`
    domSelector = `[role="navigation"][aria-label="${CSS.escape(element.getAttribute('aria-label') ?? '')}"]`
  } else if (role === 'dialog') {
    id = `dialog.${slug(name || 'active')}`
    domSelector = '[data-slot="dialog-content"]'
  } else if (role === 'alert' || role === 'status') {
    id = `notification.${slug(name || role)}`
    domSelector = element.hasAttribute('data-sonner-toast') ? '[data-sonner-toast]' : `[role="${role}"]`
  } else if (testId) {
    id = `test.${slug(testId)}`
    domSelector = `[data-testid="${CSS.escape(testId)}"]`
  } else if (element.dataset.slot && name) {
    id = `primitive.${slug(element.dataset.slot)}.${slug(name)}`
    domSelector = structuralSelector(element)
  } else {
    return null
  }
  const input = element as HTMLInputElement
  const disabled = input.disabled || element.getAttribute('aria-disabled') === 'true'
  const semanticActions: DriverAction[] = []
  const physicalActions = [...new Set([...basicActionsForRole(role), ...declaredPhysicalActions(element)])]
  const rawValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? element.value
    : element.isContentEditable ? element.innerText : undefined
  const sensitive = input.type === 'password' || /password|passcode|secret|token|api.?key|credential/i.test(
    `${name} ${element.getAttribute('name') ?? ''}`,
  )
  const resolvedName = name || explicitId || role
  return {
    id,
    ...(testId ? { testId } : {}),
    role,
    name: resolvedName.slice(0, 500),
    ...(rawValue === undefined ? {} : { value: sensitive ? '[REDACTED]' : rawValue.slice(0, 2_000) }),
    state: semanticState(element, role, disabled),
    actions: disabled ? [] : [...new Set([...semanticActions, ...physicalActions])],
    actionModes: {
      semantic: disabled ? [] : semanticActions,
      physical: disabled ? [] : physicalActions,
    },
    domSelector,
  }
}

function implicitRole(element: HTMLElement): string {
  const explicit = element.getAttribute('role')
  if (explicit) return explicit
  if (element.matches('[data-slot="dialog-content"]')) return 'dialog'
  if (element.matches('[data-sonner-toast],[aria-live]')) return 'status'
  if (element.tagName === 'BUTTON') return 'button'
  if (element.tagName === 'A') return 'link'
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable) return 'textbox'
  if (element.tagName === 'SELECT') return 'combobox'
  return 'region'
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  const labelled = labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim() : ''
  return (element.getAttribute('aria-label') || labelled || element.getAttribute('title')
    || (element as HTMLInputElement).placeholder || element.getAttribute('aria-placeholder') || element.innerText || '').trim().replace(/\s+/g, ' ')
}

function semanticState(element: HTMLElement, role: string, disabled: boolean): AutomaticSemanticNode['state'] {
  const input = element as HTMLInputElement
  return automaticSemanticState({
    role,
    disabled,
    inputChecked: element instanceof HTMLInputElement ? input.checked : undefined,
    indeterminate: element instanceof HTMLInputElement ? input.indeterminate : false,
    readOnly: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? input.readOnly : false,
    ariaChecked: element.getAttribute('aria-checked'),
    dataState: element.dataset.state,
    ariaSelected: element.getAttribute('aria-selected'),
    ariaExpanded: element.getAttribute('aria-expanded'),
    ariaBusy: element.getAttribute('aria-busy'),
    ariaHidden: element.getAttribute('aria-hidden'),
    ariaReadonly: element.getAttribute('aria-readonly'),
    focused: document.activeElement === element || element.contains(document.activeElement),
  })
}

interface AutomaticSemanticStateInput {
  role: string
  disabled: boolean
  inputChecked?: boolean
  indeterminate?: boolean
  readOnly?: boolean
  ariaChecked?: string | null
  dataState?: string
  ariaSelected?: string | null
  ariaExpanded?: string | null
  ariaBusy?: string | null
  ariaHidden?: string | null
  ariaReadonly?: string | null
  focused?: boolean
}

export function automaticSemanticState(input: AutomaticSemanticStateInput): AutomaticSemanticNode['state'] {
  const supportsChecked = ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(input.role)
  const checked = input.indeterminate || input.ariaChecked === 'mixed'
    ? 'mixed'
    : typeof input.inputChecked === 'boolean'
      ? input.inputChecked
      : input.ariaChecked === 'true' || input.ariaChecked === 'false'
        ? input.ariaChecked === 'true'
        : supportsChecked && (input.dataState === 'checked' || input.dataState === 'unchecked')
          ? input.dataState === 'checked'
          : undefined
  const selected = booleanValue(input.ariaSelected)
  const expanded = booleanValue(input.ariaExpanded)
  const busy = booleanValue(input.ariaBusy)
  const hidden = booleanValue(input.ariaHidden)
  const readonly = input.readOnly === true || input.ariaReadonly === 'true'
  return {
    ...(input.disabled ? { disabled: true } : {}),
    ...(checked === undefined ? {} : { checked }),
    ...(selected === undefined ? {} : { selected }),
    ...(expanded === undefined ? {} : { expanded }),
    ...(busy === undefined ? {} : { busy }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(readonly ? { readonly: true } : {}),
    ...(input.focused ? { focused: true } : {}),
  }
}

function booleanValue(value: string | null | undefined): boolean | undefined {
  return value === 'true' ? true : value === 'false' ? false : undefined
}

type DriverAction = 'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text'

function basicActionsForRole(role: string): DriverAction[] {
  if (role === 'textbox' || role === 'searchbox') return ['click', 'fill', 'press']
  if (role === 'combobox' || role === 'listbox') return ['click', 'select', 'press']
  if (role === 'row' || role === 'listitem' || role === 'treeitem') return ['click']
  if (['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'treeitem'].includes(role)) return ['click', 'press']
  return []
}

const DECLARABLE_PHYSICAL_ACTIONS = new Set<DriverAction>(['drag', 'shortcut', 'clipboard', 'ime', 'rich-text'])

function declaredPhysicalActions(element: HTMLElement): DriverAction[] {
  const raw = element.dataset.craftUiInteractions
  if (!raw) return []
  return [...new Set(raw.split(/\s+/).filter((action): action is DriverAction => DECLARABLE_PHYSICAL_ACTIONS.has(action as DriverAction)))]
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0
}

function slug(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 100)
  return normalized || 'unnamed'
}

function structuralSelector(element: HTMLElement): string {
  const parts: string[] = []
  let current: HTMLElement | null = element
  while (current && current !== document.documentElement && parts.length < 16) {
    const semanticId = current.dataset.craftSemanticId
    if (semanticId) {
      parts.unshift(`[data-craft-semantic-id="${CSS.escape(semanticId)}"]`)
      break
    }
    let part = current.tagName.toLocaleLowerCase()
    if (current.dataset.slot) part += `[data-slot="${CSS.escape(current.dataset.slot)}"]`
    const parent: HTMLElement | null = current.parentElement
    if (parent) part += `:nth-child(${Array.from(parent.children).indexOf(current) + 1})`
    parts.unshift(part)
    current = parent
  }
  return parts.join(' > ')
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function isUiValidationHostEnabled(): boolean {
  // Web validation installs a non-configurable bootstrap object before app code.
  if (window.__craftUiValidation) return true
  // Electron preload derives this bit from the explicit source Test Host env.
  // Packaged/production processes are rejected by main before a window exists.
  return window.electronAPI?.uiValidationTestHost?.enabled === true
}
