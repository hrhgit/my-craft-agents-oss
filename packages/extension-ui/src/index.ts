export type ExtensionUIScope = 'session' | 'workspace' | 'global'
export type ExtensionUISurface =
  | 'conversation.timeline.before'
  | 'conversation.timeline.after'
  | 'conversation.turn.before'
  | 'conversation.turn.after'
  | 'conversation.turn.replace'
  | 'conversation.message.before'
  | 'conversation.message.after'
  | 'conversation.message.footer'
  | 'conversation.message.replace'
  | 'conversation.artifact.aside'
  | 'conversation.artifact.footer'
  | 'conversation.tool.before'
  | 'conversation.tool.after'
  | 'conversation.tool.replace'
  | 'conversation.inline'
  | 'conversation.overlay'
  | 'conversation.status'
  | 'composer.above'
  | 'composer.below'
  | 'composer.toolbar'
  | 'composer.status'
  | 'composer.replace'
  | 'sidebar.header'
  | 'sidebar.section'
  | 'sidebar.footer'
  | 'navigation.item'
  | 'session.badge'
  | 'workspace.content'
  | 'window.topLeft'
  | 'window.topRight'
  | 'settings.page'

export interface ExtensionUITheme {
  mode: 'light' | 'dark'
  tokens: Readonly<Record<string, string>>
}

export interface ExtensionUIRoute {
  workspaceId?: string
  sessionId?: string
  path?: string
}

export interface ExtensionUIHostQuery {
  semanticId: string
  entityId?: string
}

export interface ExtensionUIHost {
  get(anchor: string): Element | null
  query(query: ExtensionUIHostQuery): Element | null
  queryAll(query: ExtensionUIHostQuery): Element[]
  watch(anchor: string | ExtensionUIHostQuery, listener: (elements: Element[]) => void): () => void
}

export interface ExtensionUISemantics {
  rootId: string
  register(id: string, element: Element): () => void
}

export interface ExtensionUIChannelSnapshot<TState = unknown> {
  revision: number
  state: TState
}

export interface ExtensionUIChannel<TState = unknown, TMessage = unknown> {
  getSnapshot(): ExtensionUIChannelSnapshot<TState> | undefined
  subscribe(listener: (snapshot: ExtensionUIChannelSnapshot<TState>) => void): () => void
  send(message: TMessage): Promise<unknown>
}

export interface ExtensionUIBackend {
  channel<TState = unknown, TMessage = unknown>(id: string, options?: { scope?: ExtensionUIScope }): ExtensionUIChannel<TState, TMessage>
}

export interface ExtensionUIDependencyModule {
  load<T = unknown>(): Promise<T>
}

export interface ExtensionUIDependency {
  module<T = unknown>(id: string): { load(): Promise<T> }
}

export interface ExtensionUIDependencies {
  extension(id: string): ExtensionUIDependency
}

export interface ExtensionUIMountContext {
  readonly root: HTMLElement
  readonly surface: ExtensionUISurface
  readonly mode: 'append' | 'replace' | 'overlay'
  readonly scope: ExtensionUIScope
  readonly route: ExtensionUIRoute
  readonly signal: AbortSignal
  readonly theme: ExtensionUITheme
  readonly locale: string
  readonly notify: (message: string, type?: 'info' | 'warning' | 'error' | 'success') => void
  readonly semantics: ExtensionUISemantics
  readonly backend: ExtensionUIBackend
  readonly dependencies: ExtensionUIDependencies
  readonly host: ExtensionUIHost
}

export type ExtensionUIDisposer = void | (() => void | Promise<void>) | { dispose: () => void | Promise<void> }
export type ExtensionUIMount = (context: ExtensionUIMountContext) => ExtensionUIDisposer | Promise<ExtensionUIDisposer>

export interface ExtensionUIDefinition {
  mount: ExtensionUIMount
}

export function defineExtensionUI(definition: ExtensionUIDefinition): ExtensionUIDefinition {
  if (!definition || typeof definition.mount !== 'function') {
    throw new TypeError('defineExtensionUI requires a mount function')
  }
  return definition
}

export function disposeExtensionUI(disposer: ExtensionUIDisposer): Promise<void> {
  if (!disposer) return Promise.resolve()
  const result = typeof disposer === 'function' ? disposer() : disposer.dispose()
  return Promise.resolve(result).then(() => undefined)
}

export { createExtensionLifecycle, type ExtensionUILifecycle } from './lifecycle'

export interface ExtensionUIHotContext {
  accept(callback?: () => void): void
  dispose(callback: () => void): void
}

/** Bridge a dev-server HMR update to the host's normal dispose/mount lifecycle. */
export function registerExtensionUIHotReload(
  hot: ExtensionUIHotContext | undefined,
  frontend: { extensionId: string; frontendId: string },
): void {
  if (!hot || typeof window === 'undefined') return
  const reload = () => window.dispatchEvent(new CustomEvent('mortise:extension-ui-reload', { detail: frontend }))
  hot.accept(reload)
}
