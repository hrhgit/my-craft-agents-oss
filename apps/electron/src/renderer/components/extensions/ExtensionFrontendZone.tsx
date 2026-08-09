import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ExtensionFrontendDescriptorV2, ExtensionFrontendSurfaceV2 } from '@mortise/shared/protocol'
import type { ExtensionUIRoute, ExtensionUITheme } from '@mortise/extension-ui'
import type { PiExtensionCatalogEntry } from '@mortise/shared/config'
import { useTheme } from '@/hooks/useTheme'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { getPrimaryRemoteWorkspaceId } from '@/lib/workspace-info'
import { createExtensionUIBackend } from './extension-frontend-channel-store'
import { ExtensionFrontendSurface } from './ExtensionFrontendSurface'
import { createExtensionUIHost, createExtensionUIDependencies, type ExtensionFrontendRuntimeContext } from './extension-frontend-runtime'
import { refreshRuntimeExtensions } from './extension-runtime-catalog'

const RUNTIME_STATE_TIMEOUT_MS = 5_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

interface ExtensionFrontendZoneProps {
  surface: ExtensionFrontendSurfaceV2
  sessionId?: string
  workspaceId?: string
  className?: string
  route?: ExtensionUIRoute
  extensionId?: string
  frontendId?: string
  children?: React.ReactNode
}

/** Mounts V2 frontends declared by the catalog at a single public surface. */
export function ExtensionFrontendZone({ surface, sessionId, workspaceId, className, route, extensionId, frontendId, children }: ExtensionFrontendZoneProps) {
  const { isDark, theme } = useTheme()
  const { i18n } = useTranslation()
  const appShell = useOptionalAppShellContext()
  const activeWorkspace = appShell?.workspaces.find(workspace => workspace.id === appShell.activeWorkspaceId)
  const resolvedWorkspaceId = workspaceId
    ?? (activeWorkspace ? getPrimaryRemoteWorkspaceId(activeWorkspace) : undefined)
    ?? (appShell?.activeWorkspaceId || undefined)
  const [extensions, setExtensions] = React.useState<PiExtensionCatalogEntry[]>([])

  React.useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    let startupAttempts = 0
    let refreshInFlight = false
    let hasLoadedRuntimeSnapshot = false
    const maxStartupAttempts = 20
    const refresh = async () => {
      if (refreshInFlight) return
      refreshInFlight = true
      try {
        const runtimeState = await refreshRuntimeExtensions({
          loadCatalog: async () => (await window.electronAPI.getPiExtensionCatalog()).extensions,
          loadRuntimeState: () => withTimeout(
            window.electronAPI.getPiExtensionRuntimeState(resolvedWorkspaceId),
            RUNTIME_STATE_TIMEOUT_MS,
            'Timed out loading the applied extension runtime state',
          ),
          apply: (nextExtensions) => {
            if (!active) return
            setExtensions((current) => frontendCatalogKey(current) === frontendCatalogKey(nextExtensions) ? current : nextExtensions)
          },
          applyConfigured: !hasLoadedRuntimeSnapshot,
        })
        hasLoadedRuntimeSnapshot = runtimeState.loaded
        startupAttempts = maxStartupAttempts
      } catch (error) {
        console.warn('Failed to refine extension frontend runtime state; keeping the last available catalog:', error)
        startupAttempts += 1
      } finally {
        refreshInFlight = false
      }
    }
    void refresh()
    void window.electronAPI.isDebugMode().then((debug) => {
      if (!active) return
      if (debug) {
        timer = setInterval(() => void refresh(), 750)
        return
      }
      // The workspace RPC can become ready after the first renderer paint in a
      // cold Electron launch. Retry briefly so a transient startup failure does
      // not permanently suppress extension frontends in production builds.
      timer = setInterval(() => {
        if (startupAttempts >= maxStartupAttempts) {
          if (timer) clearInterval(timer)
          timer = undefined
          return
        }
        void refresh()
      }, 750)
    }).catch(() => undefined)
    const handleReload = () => void refresh()
    window.addEventListener('mortise:pi-extensions-reloaded', handleReload)
    return () => {
      active = false
      if (timer) clearInterval(timer)
      window.removeEventListener('mortise:pi-extensions-reloaded', handleReload)
    }
  }, [resolvedWorkspaceId])

  const descriptors = React.useMemo(() => resolveFrontendDescriptors(extensions, surface, extensionId, frontendId),
  [extensionId, extensions, frontendId, surface])
  const dependencies = React.useMemo(() => createExtensionUIDependencies(
    extensions.flatMap(extension => extension.moduleDescriptors ?? []),
    extensions.flatMap(extension => extension.overrideDescriptors ?? []),
  ), [extensions])
  React.useEffect(() => () => {
    (dependencies as ExtensionFrontendRuntimeContext['dependencies'] & { dispose?: () => void }).dispose?.()
  }, [dependencies])

  const runtimeRoute = React.useMemo<ExtensionUIRoute>(() => ({
    ...route,
    workspaceId: route?.workspaceId ?? resolvedWorkspaceId,
    sessionId: route?.sessionId ?? sessionId,
  }), [resolvedWorkspaceId, route, sessionId])
  const runtimeTheme = React.useMemo<ExtensionUITheme>(() => ({
    mode: isDark ? 'dark' : 'light',
    tokens: Object.fromEntries(Object.entries(theme).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
  }), [isDark, theme])

  if (descriptors.length === 0) return children ? <>{children}</> : null
  const replaceDescriptor = descriptors.find((descriptor) => descriptor.mode === 'replace')
  const additiveDescriptors = descriptors.filter((descriptor) => descriptor !== replaceDescriptor)
  return (
    <div className={className} data-mortise-extension-frontend-zone={surface}>
      {replaceDescriptor ? (
          <MountedFrontend
          descriptor={replaceDescriptor}
          route={runtimeRoute}
          theme={runtimeTheme}
          dependencies={dependencies}
          locale={i18n.resolvedLanguage ?? i18n.language}
        >
          {children}
        </MountedFrontend>
      ) : children}
      {additiveDescriptors.map((descriptor) => (
        <MountedFrontend
          key={`${descriptor.extensionId}:${descriptor.frontendId}`}
          descriptor={descriptor}
          route={runtimeRoute}
          theme={runtimeTheme}
          dependencies={dependencies}
          locale={i18n.resolvedLanguage ?? i18n.language}
        />
      ))}
    </div>
  )
}

function resolveFrontendDescriptors(
  extensions: PiExtensionCatalogEntry[],
  surface: ExtensionFrontendSurfaceV2,
  extensionId?: string,
  frontendId?: string,
): ExtensionFrontendDescriptorV2[] {
  const base = extensions
    .filter((extension) => !extensionId || extension.id === extensionId)
    .flatMap((extension) => (extension.frontendDescriptors ?? []).filter((descriptor) => descriptor.surface === surface && (!frontendId || descriptor.frontendId === frontendId)))
  const allOverrides = extensions.flatMap(extension => extension.overrideDescriptors ?? [])
  return base.map((descriptor) => {
    let current = descriptor
    const applied = new Set<string>()
    while (true) {
      const override = allOverrides.find(item => item.target.kind === 'frontend'
        && item.target.extensionId === current.extensionId
        && item.target.id === current.frontendId
        && !applied.has(item.overrideId))
      if (!override) break
      applied.add(override.overrideId)
      current = {
        ...current,
        extensionId: override.extensionId,
        frontendId: override.overrideId,
        entryUrl: override.entryUrl,
        styleUrls: override.styleUrls,
        mode: override.mode === 'replace' ? 'replace' : 'append',
        revision: override.revision,
      }
    }
    return current
  })
}

function frontendCatalogKey(extensions: PiExtensionCatalogEntry[]): string {
  return extensions.flatMap((extension) => [
    ...(extension.frontendDescriptors ?? []).map((descriptor) =>
      `frontend:${descriptor.extensionId}:${descriptor.frontendId}:${descriptor.revision}:${descriptor.entryUrl}:${descriptor.styleUrls.join(',')}`),
    ...(extension.moduleDescriptors ?? []).map((descriptor) =>
      `module:${descriptor.extensionId}:${descriptor.moduleId}:${descriptor.revision}:${descriptor.entryUrl}:${descriptor.styleUrls.join(',')}`),
    ...(extension.overrideDescriptors ?? []).map((descriptor) =>
      `override:${descriptor.extensionId}:${descriptor.overrideId}:${descriptor.revision}:${descriptor.entryUrl}:${descriptor.styleUrls.join(',')}`),
  ]).join('|')
}

function MountedFrontend({ descriptor, route, theme, locale, dependencies, children }: {
  descriptor: ExtensionFrontendDescriptorV2
  route: ExtensionUIRoute
  theme: ExtensionUITheme
  locale: string
  dependencies: ExtensionFrontendRuntimeContext['dependencies']
  children?: React.ReactNode
}) {
  const runtime = React.useMemo<ExtensionFrontendRuntimeContext>(() => ({
    route,
    theme,
    locale,
    notify: (message, type = 'info') => {
      if (type === 'error') toast.error(message)
      else if (type === 'warning') toast.warning(message)
      else if (type === 'success') toast.success(message)
      else toast.info(message)
    },
    backend: createExtensionUIBackend({
      extensionId: descriptor.extensionId,
      scope: descriptor.scope,
      workspaceId: route.workspaceId,
      sessionId: route.sessionId,
    }),
    dependencies,
    host: createExtensionUIHost(),
  }), [dependencies, descriptor.extensionId, descriptor.scope, locale, route, theme])
  return <ExtensionFrontendSurface descriptor={descriptor} runtime={runtime}>{children}</ExtensionFrontendSurface>
}
