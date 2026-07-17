import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  FileText,
  Globe2,
  GitBranch,
  Info,
  Loader2,
  List,
  Plus,
  Puzzle,
  Settings,
  Square,
  Sparkles,
  RotateCw,
  X,
} from 'lucide-react'
import { Spinner, Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { useAppShellContext } from '@/context/AppShellContext'
import {
  activeBrowserInstanceIdAtom,
  browserInstancesAtom,
  filterInstancesForWorkspace,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { getHostname } from '@/components/browser/utils'
import { useExtensionContributions } from '@/components/extensions/useExtensionContributions'
import { ExtensionContributionContent } from '@/components/extensions/ExtensionContributionZone'
import { selectMountableOverflow, type RegisteredExtensionContribution } from '@/components/extensions/extension-contribution-store'
import type { BrowserInstanceInfo } from '../../../shared/types'
import type { ExtensionUIIconName } from '@craft-agent/shared/protocol'
import {
  browserInstanceContentId,
  browserRegistryWorkspaceSyncKey,
  extensionWorkspaceContentId,
  parseBrowserInstanceContentId,
  parseSideTasksContentId,
  sideTasksContentId,
} from './right-workbench-state'
import { SideTasksWorkbench } from './SideTasksWorkbench'
import { createBrowserEmbedLifecycle, getVisibleBrowserEmbedBounds } from './browser-embed-lifecycle'
import {
  BROWSER_CREATE_SEMANTIC_ID,
  browserWorkbenchSemanticId,
} from './browser-workbench-semantics'
import {
  isNativeViewOcclusionRequested,
  subscribeNativeViewOcclusion,
  useNativeViewOccluded,
} from '@/context/NativeViewOcclusionContext'

const FileWorkbench = React.lazy(async () => {
  const module = await import('./FileWorkbench')
  return { default: module.FileWorkbench }
})

export interface WorkbenchTool {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  browserInstanceId?: string
  extension?: RegisteredExtensionContribution
}

export function extensionToolId(item: RegisteredExtensionContribution): string {
  return extensionWorkspaceContentId(item)
}

export function extensionToolLabel(item: RegisteredExtensionContribution): string {
  if (item.contribution.workspaceContent?.title) return item.contribution.workspaceContent.title
  if (item.contribution.content.type === 'sandbox-app') return item.contribution.content.title
  return item.contribution.group || item.contribution.id
}

const extensionToolIcons: Record<ExtensionUIIconName, WorkbenchTool['icon']> = {
  activity: Activity,
  'alert-circle': AlertCircle,
  check: Check,
  'chevron-right': ChevronRight,
  circle: Circle,
  clock: Clock,
  info: Info,
  loader: Loader2,
  settings: Settings,
  sparkles: Sparkles,
  x: X,
}

export function WorkbenchToolPicker({
  tools,
  onSelect,
  label,
  semanticId,
  semanticScope,
  onCreateSession,
}: {
  tools: WorkbenchTool[]
  onSelect: (tool: WorkbenchTool) => void
  label?: string
  semanticId?: string
  semanticScope?: string
  onCreateSession?: () => void
}) {
  const { t } = useTranslation()
  const scopedSemanticId = React.useCallback((base: string) => (
    semanticScope ? `${base}.${encodeURIComponent(semanticScope)}` : base
  ), [semanticScope])
  return (
    <div
      role="group"
      aria-label={label ?? t('workbench.tools')}
      data-craft-semantic-id={scopedSemanticId(semanticId ?? 'workspace.content.picker')}
      className="flex h-full min-h-0 items-center justify-center bg-background px-6"
    >
      <div className="w-full max-w-md space-y-1">
        {onCreateSession && (
          <button
            type="button"
            data-craft-semantic-id={scopedSemanticId('workspace.empty-page.new-session')}
            onClick={onCreateSession}
            className="flex h-11 w-full items-center gap-3 rounded-[6px] px-3 text-left text-sm text-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t('session.newSession')}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />
          </button>
        )}
        {tools.map(tool => {
          const Icon = tool.icon
          return (
            <button
              key={tool.id}
              type="button"
              data-craft-semantic-id={scopedSemanticId(`workspace.content.choose.${tool.id}`)}
              onClick={() => onSelect(tool)}
              className="flex h-11 w-full items-center gap-3 rounded-[6px] px-3 text-left text-sm text-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{tool.label}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function useWorkbenchTools(
  sessionId?: string | null,
  workspaceId?: string | null,
  options?: { syncBrowserRegistry?: boolean },
): WorkbenchTool[] {
  const { t } = useTranslation()
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId
  const resolvedWorkspace = workspaces.find(workspace => workspace.id === resolvedWorkspaceId)
  const contributionWorkspaceId = resolvedWorkspace?.remoteServer?.remoteWorkspaceId ?? resolvedWorkspaceId
  const remoteWorkspaceId = resolvedWorkspace?.remoteServer?.remoteWorkspaceId ?? null
  const browserRegistrySyncKey = browserRegistryWorkspaceSyncKey(resolvedWorkspaceId, remoteWorkspaceId)
  const allBrowserInstances = useAtomValue(browserInstancesAtom)
  const browserInstances = React.useMemo(
    () => filterInstancesForWorkspace(allBrowserInstances, resolvedWorkspaceId, remoteWorkspaceId),
    [allBrowserInstances, remoteWorkspaceId, resolvedWorkspaceId],
  )
  const setBrowserInstances = useSetAtom(setBrowserInstancesAtom)
  const updateBrowserInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeBrowserInstance = useSetAtom(removeBrowserInstanceAtom)
  const setActiveBrowserInstance = useSetAtom(activeBrowserInstanceIdAtom)
  const browserApiAvailable = Boolean(
    window.electronAPI?.browserPane
      && window.electronAPI.isChannelAvailable('browser-pane:list'),
  )

  React.useEffect(() => {
    if (!browserApiAvailable || !options?.syncBrowserRegistry) return
    const api = window.electronAPI.browserPane
    let cancelled = false
    void api.list().then(instances => {
      if (!cancelled) setBrowserInstances(instances)
    }).catch(error => {
      console.warn('[RightWorkbench] Failed to list browser windows:', error)
    })
    const cleanupState = api.onStateChanged(updateBrowserInstance)
    const cleanupRemoved = api.onRemoved(removeBrowserInstance)
    const cleanupInteracted = api.onInteracted(setActiveBrowserInstance)
    return () => {
      cancelled = true
      cleanupState()
      cleanupRemoved()
      cleanupInteracted()
    }
  }, [browserApiAvailable, browserRegistrySyncKey, options?.syncBrowserRegistry, removeBrowserInstance, setActiveBrowserInstance, setBrowserInstances, updateBrowserInstance])
  const extensionLayout = useExtensionContributions(
    sessionId ?? '',
    'workspace.content',
    undefined,
    Boolean(sessionId),
    contributionWorkspaceId,
  )
  const extensionItems = React.useMemo(
    () => [...extensionLayout.visible, ...selectMountableOverflow(extensionLayout)],
    [extensionLayout],
  )
  return React.useMemo<WorkbenchTool[]>(() => {
    const builtIn: WorkbenchTool[] = []
    if (resolvedWorkspaceId) builtIn.push({ id: 'files', label: t('workbench.files'), icon: FileText })
    builtIn.push({ id: 'browser', label: t('workbench.browsers'), icon: Globe2 })
    builtIn.push(...browserInstances.map(instance => browserInstanceContentTool(instance, t('workbench.untitledBrowser'))))
    if (sessionId) {
      builtIn.push({
        id: sideTasksContentId(sessionId),
        label: t('workbench.sideTasks'),
        icon: GitBranch,
      })
    }
    return [
      ...builtIn,
      ...extensionItems.map(item => ({
        id: extensionToolId(item),
        label: extensionToolLabel(item),
        icon: item.contribution.workspaceContent?.icon
          ? extensionToolIcons[item.contribution.workspaceContent.icon]
          : Puzzle,
        extension: item,
      })),
    ]
  }, [browserInstances, extensionItems, resolvedWorkspaceId, sessionId, t])
}

export function usePersistedWorkbenchTool(ref: {
  resourceId?: string
  sessionId?: string | null
  workspaceId?: string | null
}): WorkbenchTool | undefined {
  const { t } = useTranslation()
  const tools = useWorkbenchTools(ref.sessionId, ref.workspaceId)
  return React.useMemo(
    () => {
      const resolved = tools.find(tool => tool.id === ref.resourceId)
      if (resolved) return resolved

      const browserInstanceId = parseBrowserInstanceContentId(ref.resourceId)
      if (browserInstanceId && ref.resourceId) {
        return {
          id: ref.resourceId,
          label: t('workbench.untitledBrowser'),
          icon: Globe2,
          browserInstanceId,
        }
      }

    const parentSessionId = parseSideTasksContentId(ref.resourceId)
      if (parentSessionId && ref.resourceId) {
        return {
          id: ref.resourceId,
          label: t('workbench.sideTasks'),
          icon: GitBranch,
        }
      }
      return undefined
    },
    [ref.resourceId, t, tools],
  )
}

export function WorkbenchToolContent({
  tool,
  sessionId,
  workspaceId,
  onProtectionChange,
  onOpenTool,
  onOpenSession,
}: {
  tool?: WorkbenchTool
  sessionId?: string | null
  workspaceId?: string | null
  onProtectionChange?: (protection: { dirty: boolean }) => void
  onOpenTool?: (tool: WorkbenchTool) => void
  onOpenSession?: (sessionId: string, title: string) => void
}) {
  if (tool?.id === 'files' && workspaceId) {
    return (
      <React.Suspense fallback={<FileWorkbenchLoading />}>
        <FileWorkbench
          key={workspaceId}
          workspaceId={workspaceId}
          onProtectionChange={onProtectionChange}
        />
      </React.Suspense>
    )
  }
  if (tool?.id === 'browser' || tool?.browserInstanceId) {
    return <BrowserWorkbench instanceId={tool.browserInstanceId} workspaceId={workspaceId} onOpenTool={onOpenTool} />
  }
  const sideTasksParentId = parseSideTasksContentId(tool?.id)
  if (sideTasksParentId) {
    return <SideTasksWorkbench parentSessionId={sideTasksParentId} onOpenSession={onOpenSession} />
  }
  if (tool?.extension) {
    return (
      <ExtensionContributionContent
        node={tool.extension.contribution.content}
        sessionId={tool.extension.sessionId}
        extensionId={tool.extension.extensionId}
        runtimeId={tool.extension.runtimeId}
        className="h-full overflow-auto p-2"
      />
    )
  }
  return null
}

function FileWorkbenchLoading() {
  const { t } = useTranslation()
  return (
    <div
      className="flex h-full items-center justify-center bg-background"
      aria-label={t('workbench.files')}
    >
      <Spinner className="size-5" />
    </div>
  )
}

export function BrowserWorkbench({
  instanceId,
  workspaceId,
  onOpenTool,
}: {
  instanceId?: string
  workspaceId?: string | null
  onOpenTool?: (tool: WorkbenchTool) => void
} = {}) {
  const { t } = useTranslation()
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId
  const activeWorkspace = workspaces.find(workspace => workspace.id === resolvedWorkspaceId)
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId ?? null
  const allInstances = useAtomValue(browserInstancesAtom)
  const instances = React.useMemo(
    () => filterInstancesForWorkspace(allInstances, resolvedWorkspaceId, remoteWorkspaceId),
    [allInstances, remoteWorkspaceId, resolvedWorkspaceId],
  )
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  const [activeInstanceId, setActiveInstanceId] = useAtom(activeBrowserInstanceIdAtom)
  const [creating, setCreating] = React.useState(false)
  const [showPicker, setShowPicker] = React.useState(false)
  const browserApiAvailable = Boolean(
    window.electronAPI?.browserPane
      && window.electronAPI.isChannelAvailable('browser-pane:list'),
  )
  const embedApiAvailable = browserApiAvailable
    && window.electronAPI.isChannelAvailable('browser-pane:embed')
  const activeInstance = instances.find(instance => instance.id === (instanceId ?? activeInstanceId)) ?? null
  const isDockLauncher = !instanceId && Boolean(onOpenTool)

  const createBrowser = React.useCallback(async () => {
    if (!browserApiAvailable || !resolvedWorkspaceId) return
    setCreating(true)
    try {
      const id = await window.electronAPI.browserPane.create({ show: false, workspaceId: resolvedWorkspaceId })
      setActiveInstanceId(id)
      const listed = await window.electronAPI.browserPane.list()
      setInstances(listed)
      const created = listed.find(instance => instance.id === id)
      if (onOpenTool) {
        onOpenTool(created
          ? browserInstanceContentTool(created, t('workbench.untitledBrowser'))
          : {
              id: browserInstanceContentId(id),
              label: t('workbench.untitledBrowser'),
              icon: Globe2,
              browserInstanceId: id,
            })
      } else {
        setShowPicker(false)
      }
    } catch (error) {
      console.warn('[RightWorkbench] Failed to create browser window:', error)
    } finally {
      setCreating(false)
    }
  }, [browserApiAvailable, onOpenTool, resolvedWorkspaceId, setActiveInstanceId, setInstances, t])

  React.useEffect(() => {
    if (instanceId && activeInstance) setActiveInstanceId(instanceId)
    else if (!instanceId && activeInstanceId && !activeInstance) setActiveInstanceId(null)
  }, [activeInstance, activeInstanceId, instanceId, setActiveInstanceId])

  const showBrowserWindow = React.useCallback(async (id: string) => {
    if (embedApiAvailable) await window.electronAPI.browserPane.detach(id)
    await window.electronAPI.browserPane.focus(id)
  }, [embedApiAvailable])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!browserApiAvailable ? (
        <WorkbenchEmpty icon={Globe2} label={t('workbench.browserUnavailable')} />
      ) : !embedApiAvailable ? (
        <BrowserInstancePicker
          instances={instances}
          activeInstanceId={activeInstanceId}
          creating={creating}
          onCreate={() => void createBrowser()}
          onSelect={id => {
            const selected = instances.find(instance => instance.id === id)
            if (selected && onOpenTool) onOpenTool(browserInstanceContentTool(selected, t('workbench.untitledBrowser')))
            else {
              setActiveInstanceId(id)
              void showBrowserWindow(id)
            }
          }}
          onShowWindow={id => void showBrowserWindow(id)}
          onDestroy={id => {
            removeInstance(id)
            void window.electronAPI.browserPane.destroy(id)
          }}
        />
      ) : isDockLauncher || (!instanceId && showPicker) || !activeInstance ? (
        <BrowserInstancePicker
          instances={instances}
          activeInstanceId={activeInstanceId}
          creating={creating}
          onCreate={() => void createBrowser()}
          onSelect={id => {
            const selected = instances.find(instance => instance.id === id)
            if (selected && onOpenTool) onOpenTool(browserInstanceContentTool(selected, t('workbench.untitledBrowser')))
            else {
              setActiveInstanceId(id)
              setShowPicker(false)
            }
          }}
          onShowWindow={id => void showBrowserWindow(id)}
          onDestroy={id => {
            removeInstance(id)
            void window.electronAPI.browserPane.destroy(id)
          }}
        />
      ) : (
        <EmbeddedBrowser
          instance={activeInstance}
          onShowPicker={() => {
            if (instanceId && onOpenTool) onOpenTool({ id: 'browser', label: t('workbench.browsers'), icon: Globe2 })
            else setShowPicker(true)
          }}
          onShowWindow={() => void showBrowserWindow(activeInstance.id)}
        />
      )}
    </div>
  )
}

function browserInstanceContentTool(
  instance: BrowserInstanceInfo,
  fallbackLabel: string,
): WorkbenchTool {
  const hostname = getHostname(instance.url)
  return {
    id: browserInstanceContentId(instance.id),
    label: instance.title.trim() || hostname || fallbackLabel,
    icon: Globe2,
    browserInstanceId: instance.id,
  }
}

function BrowserInstancePicker({
  instances,
  activeInstanceId,
  creating,
  onCreate,
  onSelect,
  onShowWindow,
  onDestroy,
}: {
  instances: BrowserInstanceInfo[]
  activeInstanceId: string | null
  creating: boolean
  onCreate: () => void
  onSelect: (id: string) => void
  onShowWindow: (id: string) => void
  onDestroy: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <span className="text-xs font-medium text-muted-foreground">
          {t('workbench.browserWindows', { count: instances.length })}
        </span>
        <HeaderIconButton
          icon={creating ? <Spinner className="text-[10px]" /> : <Plus className="size-4" />}
          tooltip={t('workbench.newBrowser')}
          aria-label={t('workbench.newBrowser')}
          data-craft-semantic-id={BROWSER_CREATE_SEMANTIC_ID}
          disabled={creating}
          onClick={onCreate}
        />
      </div>
      {instances.length === 0 ? (
        <WorkbenchEmpty icon={Globe2} label={t('workbench.noBrowsers')} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {instances.map(instance => (
            <BrowserInstanceRow
              key={instance.id}
              instance={instance}
              active={instance.id === activeInstanceId}
              onSelect={() => onSelect(instance.id)}
              onShowWindow={() => onShowWindow(instance.id)}
              onDestroy={() => onDestroy(instance.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EmbeddedBrowser({
  instance,
  onShowPicker,
  onShowWindow,
}: {
  instance: BrowserInstanceInfo
  onShowPicker: () => void
  onShowWindow: () => void
}) {
  const { t } = useTranslation()
  const nativeViewOccluded = useNativeViewOccluded()
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const lifecycleRef = React.useRef<ReturnType<typeof createBrowserEmbedLifecycle> | null>(null)
  const occludedRef = React.useRef(nativeViewOccluded)
  occludedRef.current = nativeViewOccluded
  const [address, setAddress] = React.useState(instance.url === 'about:blank' ? '' : instance.url)

  React.useEffect(() => {
    setAddress(instance.url === 'about:blank' ? '' : instance.url)
  }, [instance.id, instance.url])

  React.useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    let cancelled = false
    let frame = 0
    const lifecycle = createBrowserEmbedLifecycle(
      instance.id,
      window.electronAPI.browserPane,
      (operation, error) => console.warn(`[RightWorkbench] Failed to ${operation} embedded browser:`, error),
    )
    lifecycleRef.current = lifecycle
    const unsubscribeOcclusion = subscribeNativeViewOcclusion(() => {
      if (isNativeViewOcclusionRequested()) lifecycle.update(null)
    })
    if (isNativeViewOcclusionRequested()) lifecycle.update(null)

    const measure = () => {
      if (cancelled) return
      lifecycle.update(
        occludedRef.current || isNativeViewOcclusionRequested()
          ? null
          : getVisibleBrowserEmbedBounds(element),
      )
      frame = requestAnimationFrame(measure)
    }
    frame = requestAnimationFrame(measure)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      unsubscribeOcclusion()
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null
      lifecycle.dispose()
    }
  }, [instance.id])

  React.useLayoutEffect(() => {
    if (nativeViewOccluded) lifecycleRef.current?.update(null)
  }, [nativeViewOccluded])

  const navigate = React.useCallback(async () => {
    const value = address.trim()
    if (!value) return
    const url = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
    try {
      await window.electronAPI.browserPane.navigate(instance.id, url)
    } catch (error) {
      console.warn('[RightWorkbench] Browser navigation failed:', error)
    }
  }, [address, instance.id])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border/40 px-1.5">
        <HeaderIconButton
          icon={<List className="size-3.5" />}
          tooltip={t('workbench.browserList')}
          aria-label={t('workbench.browserList')}
          data-craft-semantic-id={browserWorkbenchSemanticId('list', instance.id)}
          onClick={onShowPicker}
        />
        <HeaderIconButton
          icon={<ArrowLeft className="size-3.5" />}
          tooltip={t('common.back')}
          aria-label={t('common.back')}
          data-craft-semantic-id={browserWorkbenchSemanticId('back', instance.id)}
          disabled={!instance.canGoBack}
          onClick={() => void window.electronAPI.browserPane.goBack(instance.id)}
        />
        <HeaderIconButton
          icon={<ArrowRight className="size-3.5" />}
          tooltip={t('common.forward')}
          aria-label={t('common.forward')}
          data-craft-semantic-id={browserWorkbenchSemanticId('forward', instance.id)}
          disabled={!instance.canGoForward}
          onClick={() => void window.electronAPI.browserPane.goForward(instance.id)}
        />
        <HeaderIconButton
          icon={instance.isLoading ? <Square className="size-3" /> : <RotateCw className="size-3.5" />}
          tooltip={instance.isLoading ? t('workbench.stopLoading') : t('common.reload')}
          aria-label={instance.isLoading ? t('workbench.stopLoading') : t('common.reload')}
          data-craft-semantic-id={browserWorkbenchSemanticId('reload', instance.id)}
          onClick={() => void (instance.isLoading ? window.electronAPI.browserPane.stop(instance.id) : window.electronAPI.browserPane.reload(instance.id))}
        />
        <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); void navigate() }}>
          <input
            value={address}
            onChange={event => setAddress(event.target.value)}
            aria-label={t('workbench.browserAddress')}
            data-craft-semantic-id={browserWorkbenchSemanticId('address', instance.id)}
            placeholder={t('workbench.browserAddress')}
            className="h-7 w-full rounded-[5px] border border-border/60 bg-background px-2 text-[11px] outline-none focus:border-ring"
          />
        </form>
        <HeaderIconButton
          icon={<ExternalLink className="size-3.5" />}
          tooltip={t('workbench.showBrowser')}
          aria-label={t('workbench.showBrowser')}
          data-craft-semantic-id={browserWorkbenchSemanticId('show-window', instance.id)}
          onClick={onShowWindow}
        />
      </div>
      <div
        ref={viewportRef}
        data-craft-semantic-id={browserWorkbenchSemanticId('viewport', instance.id)}
        className="min-h-0 flex-1 bg-background"
      />
    </div>
  )
}

function BrowserInstanceRow({
  instance,
  active,
  onSelect,
  onShowWindow,
  onDestroy,
}: {
  instance: BrowserInstanceInfo
  active: boolean
  onSelect: () => void
  onShowWindow: () => void
  onDestroy: () => void
}) {
  const { t } = useTranslation()
  const hostname = getHostname(instance.url)
  const label = instance.title.trim() || hostname || t('workbench.untitledBrowser')
  return (
    <div
      className={cn(
        'group flex min-h-14 items-center gap-2 border-b border-border/35 px-3 py-2',
        active && 'bg-background/55',
      )}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-[5px] bg-background shadow-minimal">
        {instance.isLoading ? (
          <Spinner className="text-[10px]" />
        ) : instance.favicon ? (
          <img src={instance.favicon} alt="" className="size-4 rounded-sm" />
        ) : (
          <Globe2 className="size-4 text-muted-foreground" />
        )}
      </div>
      <button
        type="button"
        data-craft-semantic-id={browserWorkbenchSemanticId('select', instance.id)}
        onClick={onSelect}
        className="min-w-0 flex-1 text-left"
      >
        <div className="truncate text-xs font-medium text-foreground">{label}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hostname}</div>
      </button>
      <HeaderIconButton
        icon={<ExternalLink className="size-3.5" />}
        tooltip={t('workbench.showBrowser')}
        aria-label={t('workbench.showBrowser')}
        data-craft-semantic-id={browserWorkbenchSemanticId('show-window', instance.id)}
        onClick={onShowWindow}
        className="opacity-70 group-hover:opacity-100"
      />
      <HeaderIconButton
        icon={<X className="size-3.5" />}
        tooltip={t('workbench.terminateBrowser')}
        aria-label={t('workbench.terminateBrowser')}
        data-craft-semantic-id={browserWorkbenchSemanticId('destroy', instance.id)}
        onClick={onDestroy}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      />
    </div>
  )
}

function WorkbenchEmpty({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
      <Icon className="size-5 opacity-55" />
      <p className="text-xs">{label}</p>
    </div>
  )
}
