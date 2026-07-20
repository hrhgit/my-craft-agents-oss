export interface WindowRendererRuntimeQueryOptions {
  mortiseTestMode?: boolean
  layoutReadOnly?: boolean
}

export type WindowLayoutMode = 'coordinated' | 'standalone'

export function resolveWindowLayoutRuntime(args: {
  role: 'main' | 'child-session' | 'auxiliary'
  workspaceHasPrimary: boolean
  webContentsId: number
  requestedLayoutWindowId?: string
}): { mode: WindowLayoutMode; layoutReadOnly: boolean; layoutWindowId?: string } {
  const standalone = args.role === 'child-session'
    || (args.role === 'main' && args.workspaceHasPrimary)
  const mode: WindowLayoutMode = standalone ? 'standalone' : 'coordinated'
  const layoutWindowId = args.requestedLayoutWindowId
    ?? (standalone ? `standalone:${args.webContentsId}` : undefined)
  return {
    mode,
    layoutReadOnly: standalone,
    ...(layoutWindowId ? { layoutWindowId } : {}),
  }
}

export interface InitialWindowRendererQueryOptions extends WindowRendererRuntimeQueryOptions {
  workspaceId: string
  focused?: boolean
  initialSessionId?: string
  initialRoute?: string
  layoutWindowId?: string
}

export function applyInitialWindowNavigation(
  query: Readonly<Record<string, string>>,
  initialRoute?: string,
): Record<string, string> {
  if (!initialRoute) return { ...query }
  const next: Record<string, string> = { ...query, route: initialRoute }
  delete next.panels
  delete next.fi
  delete next.sessionId
  return next
}

export function applyWindowRendererRuntimeQuery(
  query: Readonly<Record<string, string>>,
  options: WindowRendererRuntimeQueryOptions,
): Record<string, string> {
  return {
    ...query,
    ...(options.mortiseTestMode ? { mortiseTestMode: '1' } : {}),
    ...(options.layoutReadOnly ? { layoutReadOnly: '1' } : {}),
  }
}

export function buildInitialWindowRendererQuery(
  options: InitialWindowRendererQueryOptions,
): Record<string, string> {
  return applyWindowRendererRuntimeQuery({
    workspaceId: options.workspaceId,
    ...(options.focused ? { focused: 'true' } : {}),
    ...(options.initialSessionId ? { sessionId: options.initialSessionId } : {}),
    ...(options.initialRoute ? { route: options.initialRoute } : {}),
    ...(options.layoutWindowId ? { layoutWindowId: options.layoutWindowId } : {}),
  }, options)
}
