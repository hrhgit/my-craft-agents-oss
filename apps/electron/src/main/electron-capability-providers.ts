import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Dialog } from 'electron'
import {
  createBrowserCommandProvider,
  createBrowserControlProvider,
  createBrowserOperationsProvider,
  createBrowserProvider,
  createFilesProvider,
  createSystemNotificationProvider,
  type CapabilityProvider,
  type CapabilityProviderContext,
} from '@mortise/server-core/capabilities'
import type {
  CapabilityRequestV1,
  WorkspaceCapabilitySessionContextV1,
} from '@mortise/shared/protocol'

import { createBrowserCapabilityAdapter } from './browser-capability-adapter'
import type { BrowserPaneManager } from './browser-pane-manager'

export interface ElectronCapabilityProviderOptions {
  browserPaneManager: BrowserPaneManager
  dialog: Pick<Dialog, 'showOpenDialog'>
  resolveSession(sessionId: string): Promise<WorkspaceCapabilitySessionContextV1 | undefined>
  showNotification(title: string, body: string, workspaceId: string, sessionId: string): void
}

export interface ElectronCapabilityExecutionContext {
  signal: AbortSignal
  reportProgress(progress: unknown): void
}

export type ElectronCapabilityExecutor = (
  request: CapabilityRequestV1,
  session: WorkspaceCapabilitySessionContextV1,
  context: ElectronCapabilityExecutionContext,
) => Promise<unknown>

function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

export function createElectronCapabilityProviders(
  options: ElectronCapabilityProviderOptions,
): CapabilityProvider[] {
  const { browserPaneManager, dialog, resolveSession, showNotification } = options

  return [
    createSystemNotificationProvider(async ({ title, body }, route) => {
      const session = await resolveSession(route.sessionId)
      showNotification(title, body, session?.workspaceId ?? '', route.sessionId)
    }),
    createFilesProvider(async ({ title, mode = 'file', multiple = false, extensions }) => {
      const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [
        mode === 'directory' ? 'openDirectory' : 'openFile',
      ]
      if (multiple) properties.push('multiSelections')
      const result = await dialog.showOpenDialog({
        title,
        properties,
        ...(extensions?.length ? { filters: [{ name: 'Allowed files', extensions }] } : {}),
      })
      return { cancelled: result.canceled, paths: result.filePaths }
    }),
    createBrowserProvider(async ({ url, focus }, route) => {
      const session = await resolveSession(route.sessionId)
      if (!session) throw new Error('Session not found')
      const instanceId = await browserPaneManager.getOrCreateForSessionAsync(route.sessionId, {
        workspaceId: session.workspaceId,
      })
      const navigated = await browserPaneManager.navigate(instanceId, url)
      if (focus) browserPaneManager.focus(instanceId)
      return { instanceId, ...navigated }
    }),
    createBrowserControlProvider(async (operation, { instanceId }, route) => {
      const instance = await browserPaneManager.getInstanceAsync(instanceId)
      if (!instance || instance.ownerSessionId !== route.sessionId) {
        throw new Error('Browser instance is not owned by this session')
      }
      switch (operation) {
        case 'back': await browserPaneManager.goBack(instanceId); break
        case 'forward': await browserPaneManager.goForward(instanceId); break
        case 'focus': browserPaneManager.focus(instanceId); break
        case 'hide': browserPaneManager.hide(instanceId); break
        case 'close': browserPaneManager.destroyInstance(instanceId); break
      }
    }),
    createBrowserCommandProvider(
      async ({ sessionId }) => {
        const session = await resolveSession(sessionId)
        if (!session) return undefined
        return createBrowserCapabilityAdapter(browserPaneManager, sessionId, session.workspaceId)
      },
      async (image, { sessionId }) => {
        const session = await resolveSession(sessionId)
        if (!session?.sessionPath) throw new Error('Session artifact storage is unavailable')
        const artifactsDir = join(session.sessionPath, 'artifacts')
        await mkdir(artifactsDir, { recursive: true })
        const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png'
        const path = join(artifactsDir, `browser-${randomUUID()}.${extension}`)
        await writeFile(path, Buffer.from(image.data, 'base64'))
        return { path }
      },
    ),
    createBrowserOperationsProvider(async (operation, input, route) => {
      const instanceId = String(input.instanceId)
      const instance = await browserPaneManager.getInstanceAsync(instanceId)
      if (!instance || instance.ownerSessionId !== route.sessionId) {
        throw new Error('Browser instance is not owned by this session')
      }
      if (route.signal.aborted) throw route.signal.reason
      switch (operation) {
        case 'snapshot': return browserPaneManager.getAccessibilitySnapshot(instanceId)
        case 'click': await browserPaneManager.clickElement(instanceId, String(input.ref), { waitFor: input.waitFor as 'none' | 'navigation' | 'network-idle' | undefined, timeoutMs: input.timeoutMs as number | undefined }); return { completed: true }
        case 'click-at': await browserPaneManager.clickAtCoordinates(instanceId, Number(input.x), Number(input.y)); return { completed: true }
        case 'drag': await browserPaneManager.drag(instanceId, Number(input.x1), Number(input.y1), Number(input.x2), Number(input.y2)); return { completed: true }
        case 'fill': await browserPaneManager.fillElement(instanceId, String(input.ref), String(input.value)); return { completed: true }
        case 'type': await browserPaneManager.typeText(instanceId, String(input.text)); return { completed: true }
        case 'select': await browserPaneManager.selectOption(instanceId, String(input.ref), String(input.value)); return { completed: true }
        case 'screenshot': {
          const result = await browserPaneManager.screenshot(instanceId, { format: input.format as 'png' | 'jpeg' | undefined, jpegQuality: input.jpegQuality as number | undefined, annotate: input.annotate as boolean | undefined })
          return { format: result.imageFormat, dataUrl: `data:image/${result.imageFormat};base64,${result.imageBuffer.toString('base64')}`, metadata: result.metadata }
        }
        case 'screenshot-region': {
          const result = await browserPaneManager.screenshotRegion(instanceId, input as never)
          return { format: result.imageFormat, dataUrl: `data:image/${result.imageFormat};base64,${result.imageBuffer.toString('base64')}`, metadata: result.metadata }
        }
        case 'wait': return browserPaneManager.waitFor(instanceId, { kind: input.kind as 'selector' | 'text' | 'url' | 'network-idle', value: input.value as string | undefined, timeoutMs: input.timeoutMs as number | undefined })
        case 'key': await browserPaneManager.sendKey(instanceId, { key: String(input.key), modifiers: input.modifiers as Array<'shift' | 'control' | 'alt' | 'meta'> | undefined }); return { completed: true }
        case 'scroll': await browserPaneManager.scroll(instanceId, input.direction as 'up' | 'down' | 'left' | 'right', input.amount as number | undefined); return { completed: true }
        case 'console': return browserPaneManager.getConsoleLogs(instanceId, { level: input.level as never, limit: input.limit as number | undefined }).map(entry => ({ timestamp: entry.timestamp, level: entry.level, message: entry.message.slice(0, 10_000) }))
        case 'network': return browserPaneManager.getNetworkLogs(instanceId, { status: input.status as never, method: input.method as string | undefined, resourceType: input.resourceType as string | undefined, limit: input.limit as number | undefined }).map(entry => ({ ...entry, url: redactBrowserUrl(entry.url) }))
        case 'downloads': return (await browserPaneManager.getDownloads(instanceId, { action: input.action as never, limit: input.limit as number | undefined, timeoutMs: input.timeoutMs as number | undefined })).map(({ savePath: _savePath, url, ...entry }) => ({ ...entry, url: redactBrowserUrl(url) }))
        case 'resize': return browserPaneManager.windowResize(instanceId, Number(input.width), Number(input.height))
        case 'challenge': return browserPaneManager.detectSecurityChallenge(instanceId)
      }
    }),
  ]
}

export function registerElectronCapabilityProviders(
  register: (provider: CapabilityProvider) => void,
  options: ElectronCapabilityProviderOptions,
): void {
  for (const provider of createElectronCapabilityProviders(options)) register(provider)
}

export function createElectronCapabilityExecutor(
  options: Omit<ElectronCapabilityProviderOptions, 'resolveSession'>,
): ElectronCapabilityExecutor {
  return async (request, session, context) => {
    const providers = createElectronCapabilityProviders({
      ...options,
      resolveSession: async sessionId => sessionId === request.sessionId ? session : undefined,
    })
    const provider = providers.find(candidate => candidate.capability === request.capability)
    if (!provider) throw new Error(`Unsupported Electron capability: ${request.capability}`)
    const providerContext: CapabilityProviderContext = {
      request,
      signal: context.signal,
      reportProgress: context.reportProgress,
    }
    return provider.invoke(request.operation, request.input, providerContext)
  }
}
