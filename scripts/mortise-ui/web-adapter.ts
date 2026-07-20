#!/usr/bin/env bun
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import {
  UI_VALIDATION_DEFAULT_TIMEOUT_MS,
  UI_VALIDATION_EXTENDED_TIMEOUT_MS,
  UI_VALIDATION_MAX_WAIT_MS,
  UI_VALIDATION_PROTOCOL_VERSION,
  UiValidationError,
  UI_VALIDATION_APP_SHELL_SCENARIO_IDS,
  queryUiValidationCapabilities,
  parseUiValidationActionRequest,
  parseUiValidationEvidenceCaptureRequest,
  parseUiValidationRequestEnvelope,
  parseUiValidationScenarioApplyRequest,
  parseUiValidationWaitRequest,
  toUiValidationError,
  type SemanticSnapshot,
  type UiValidationActionRequest,
  type UiValidationCapabilitiesQuery,
  type UiValidationEvidenceArtifact,
  type UiValidationEvidenceKind,
  type UiValidationRequestEnvelope,
  type UiValidationRoute,
  type UiValidationVerificationLevel,
  type UiValidationWaitPredicate,
} from '@mortise/shared/ui-validation'
import { redactValue } from './redaction.ts'
import { writeJsonAtomic } from './files.ts'
import {
  buildWebAccessibilityDescriptor,
  buildWebSemanticSnapshot,
  resolveWebTarget,
  routeFromParams,
  type WebSemanticDescriptor,
  type WebAccessibilityNode,
  type WebWaitBaseline,
  waitForWebCondition,
} from './web-adapter-core.ts'

const runId = requiredEnv('MORTISE_UI_RUN_ID')
const token = requiredEnv('MORTISE_UI_TOKEN')
const endpointManifestPath = resolve(requiredEnv('MORTISE_UI_ENDPOINT_MANIFEST'))
const artifactsDir = resolve(requiredEnv('MORTISE_UI_ARTIFACTS_DIR'))
const profileDir = resolve(requiredEnv('MORTISE_UI_PROFILE_DIR'))
const mortiseConfigDir = resolve(requiredEnv('MORTISE_CONFIG_DIR'))
const MAX_BODY_BYTES = 1_000_000
const MAX_WAIT_MS = UI_VALIDATION_MAX_WAIT_MS
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bunExecutable = process.env.MORTISE_UI_BUN_EXECUTABLE || 'bun'

if (process.env.MORTISE_UI_TEST_HOST !== '1' || process.env.NODE_ENV === 'production') {
  throw new Error('The WebUI validation adapter is source-development only.')
}
if (process.env.MORTISE_UI_SURFACE !== 'webui') throw new Error('WebUI adapter requires MORTISE_UI_SURFACE=webui.')
if (process.env.MORTISE_UI_PROTOCOL_VERSION !== String(UI_VALIDATION_PROTOCOL_VERSION)) throw new Error('Unsupported UI validation protocol version.')
if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('MORTISE_UI_TOKEN must be 64 hexadecimal characters.')

await mkdir(artifactsDir, { recursive: true })
const rpcPort = await reservePort()
const webPort = await reservePort()
const webUrl = `http://127.0.0.1:${webPort}/`
const serverSecret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
const children: ChildProcess[] = []
const childOutput: Array<{ at: string; process: string; stream: string; text: string }> = []
const consoleEvents: Array<Record<string, unknown>> = []
const pageErrors: Array<Record<string, unknown>> = []
const networkEvents: Array<Record<string, unknown>> = []
let context: BrowserContext | undefined
let browser: Browser | undefined
let page: Page | undefined
let lastSnapshot: SemanticSnapshot | undefined
let lastEvidenceSnapshot: SemanticSnapshot | undefined
const snapshotHistory = new Map<number, SemanticSnapshot>()
let descriptorsByNodeId = new Map<string, WebSemanticDescriptor>()
let currentRoute: UiValidationRoute = { surface: 'unknown' }
let seq = 0
let closing = false
let runVerificationLevel: UiValidationVerificationLevel = 'scenario-verified'
let activeWebScenario: { id: string; seed: number; clock: string; clockDomains?: string[]; state?: unknown } | undefined
let tracing = false

try {
  const commonEnv = {
    ...process.env,
    MORTISE_SERVER_TOKEN: serverSecret,
    MORTISE_RPC_HOST: '127.0.0.1',
    MORTISE_RPC_PORT: String(rpcPort),
    MORTISE_WEBUI_PORT: String(webPort),
    MORTISE_WEBUI_HOST: '127.0.0.1',
    MORTISE_WEBUI_AUTO_LOGIN: 'true',
    MORTISE_WEBUI_DIR: join(repoRoot, 'apps', 'webui', 'src'),
    MORTISE_WEBUI_WS_URL: `ws://127.0.0.1:${rpcPort}`,
    MORTISE_BUNDLED_ASSETS_ROOT: join(repoRoot, 'apps', 'electron'),
    MORTISE_DEBUG: 'true',
  }
  children.push(spawnLogged('rpc', bunExecutable, ['run', 'packages/server/src/index.ts'], commonEnv))
  children.push(spawnLogged('vite', bunExecutable, ['x', 'vite', '--config', 'apps/webui/vite.config.ts'], commonEnv))
  await waitForHttp(`${webUrl}api/config`, UI_VALIDATION_EXTENDED_TIMEOUT_MS)

  const browserPort = await reservePort()
  children.push(spawnLogged('browser', findBrowserExecutable(), [
    `--remote-debugging-port=${browserPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${join(profileDir, 'web-browser')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--lang=en-US', '--window-size=1440,900',
    ...(process.env.MORTISE_UI_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ...(process.env.MORTISE_UI_HEADED === '1' ? [] : ['--headless=new', '--hide-scrollbars', '--mute-audio']),
    'about:blank',
  ], commonEnv))
  await waitForHttp(`http://127.0.0.1:${browserPort}/json/version`, UI_VALIDATION_DEFAULT_TIMEOUT_MS)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { timeout: UI_VALIDATION_DEFAULT_TIMEOUT_MS })
  context = browser.contexts()[0]
  if (!context) throw new Error('Chrome did not expose a default browser context.')
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracing = true
  const authResponse = await context.request.post(`${webUrl}api/auth/auto`)
  if (!authResponse.ok()) throw new Error(`WebUI development auto-login failed with HTTP ${authResponse.status()}.`)
  await context.addInitScript(() => {
    const scoped = { revision: 0, seq: 0, states: new Map<string, Record<string, unknown>>(), events: [] as Array<Record<string, unknown>> }
    const state = {
      revision: 1,
      publishState(batch: { version: number; states: Array<Record<string, unknown>> }) {
        if (batch?.version !== 1 || !Array.isArray(batch.states)) return
        for (const update of batch.states) {
          const key = `${String(update.scope)}\0${String(update.entityId ?? '')}`
          const current = scoped.states.get(key)
          if (current && JSON.stringify({ ...current, revision: undefined, updatedAt: undefined }) === JSON.stringify(update)) continue
          const next = { ...update, revision: ++scoped.revision, updatedAt: Date.now(), windowId: 'webui-main' }
          scoped.states.set(key, next)
          const event = { seq: ++scoped.seq, type: `state.${String(update.scope)}.changed`, revision: scoped.revision, timestamp: Date.now(), payload: next }
          scoped.events.push(event)
          if (scoped.events.length > 512) scoped.events.shift()
        }
        state.revision += 1
        dispatchEvent(new CustomEvent('mortise:ui-validation:state-change', { detail: { revision: scoped.revision, seq: scoped.seq } }))
      },
      dispose() {
        for (const [key, current] of scoped.states) scoped.states.set(key, { ...current, phase: 'disposed', revision: ++scoped.revision, updatedAt: Date.now() })
        dispatchEvent(new CustomEvent('mortise:ui-validation:state-change', { detail: { revision: scoped.revision, seq: scoped.seq } }))
      },
      stateSnapshot() { return { revision: scoped.revision, latestSeq: scoped.seq, states: [...scoped.states.values()] } },
      readStateEvents(afterSeq = 0) {
        const firstAvailableSeq = Number(scoped.events[0]?.seq ?? scoped.seq + 1)
        return {
          latestSeq: scoped.seq,
          events: scoped.events.filter(event => Number(event.seq) > afterSeq),
          ...(afterSeq + 1 < firstAvailableSeq ? { droppedBeforeSeq: firstAvailableSeq } : {}),
        }
      },
    }
    Object.defineProperty(window, '__mortiseUiValidation', { value: state, configurable: false, enumerable: false })
    const install = () => new MutationObserver(() => { state.revision += 1 }).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    })
    if (document.documentElement) install()
    else document.addEventListener('DOMContentLoaded', install, { once: true })
  })
  page = context.pages()[0] ?? await context.newPage()
  attachPageEvidence(page)
  context.on('page', attachPageEvidence)
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: UI_VALIDATION_EXTENDED_TIMEOUT_MS })
  await waitForAppReady(UI_VALIDATION_EXTENDED_TIMEOUT_MS)
} catch (error) {
  await cleanup()
  throw error
}

const commandServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/command') return sendNodeJson(response, 404, { error: 'Not found' })
    if (!authorized(request.headers.authorization ?? null)) return sendNodeJson(response, 401, { error: 'Unauthorized' })
    let envelope: UiValidationRequestEnvelope | undefined
    const abortController = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) abortController.abort('client disconnected')
    })
    try {
      const bytes = Number(request.headers['content-length'] ?? '0')
      if (bytes > MAX_BODY_BYTES) throw new UiValidationError('INVALID_REQUEST', 'Request body exceeds the maximum size.')
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        received += buffer.length
        if (received > MAX_BODY_BYTES) throw new UiValidationError('INVALID_REQUEST', 'Request body exceeds the maximum size.')
        chunks.push(buffer)
      }
      envelope = parseUiValidationRequestEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (envelope.runId !== runId) throw new UiValidationError('INVALID_REQUEST', 'runId does not match this Test Host.')
      const commandSeq = ++seq
      const result = await dispatch(envelope.method, recordParams(envelope.params), abortController.signal)
      const level = resultVerificationLevel(envelope.method, result)
      if (level === 'native-verified' || (level === 'renderer-verified' && runVerificationLevel === 'scenario-verified')) runVerificationLevel = level
      const payload = {
        v: UI_VALIDATION_PROTOCOL_VERSION, kind: 'response' as const, id: envelope.id, requestId: envelope.requestId, runId,
        seq: commandSeq, revision: await liveRevision(), verificationLevel: level, ok: true as const, result,
      }
      if (envelope.method === 'app.shutdown') setTimeout(() => void shutdown(), 10)
      return sendNodeJson(response, 200, payload)
    } catch (error) {
      const typed = toUiValidationError(error)
      let automaticEvidence: unknown
      if (envelope && envelope.method !== 'evidence.capture' && envelope.method !== 'app.shutdown') {
        boundedPush(pageErrors, {
          at: new Date().toISOString(), type: 'command-failure', method: envelope.method,
          code: typed.code, message: typed.message,
        }, 1_000)
        automaticEvidence = await captureEvidence({ label: `failure-${envelope.method.replace(/[^A-Za-z0-9._-]/g, '_')}` })
          .catch(captureError => ({ captureFailed: true, message: captureError instanceof Error ? captureError.message : String(captureError) }))
      }
      const payloadError = typed.toPayload()
      if (automaticEvidence !== undefined) payloadError.details = { ...payloadError.details, automaticEvidence }
      return sendNodeJson(response, envelope ? 200 : 400, {
        v: UI_VALIDATION_PROTOCOL_VERSION, kind: 'response', id: envelope?.id ?? 'invalid', requestId: envelope?.requestId ?? 'invalid', runId,
        seq: ++seq, revision: await liveRevision().catch(() => lastSnapshot?.revision ?? 0),
        verificationLevel: verificationLevel(envelope?.method ?? ''), ok: false, error: payloadError,
      })
    }
})
await new Promise<void>((resolveListen, rejectListen) => {
  commandServer.once('error', rejectListen)
  commandServer.listen(0, '127.0.0.1', resolveListen)
})
const commandAddress = commandServer.address()
if (!commandAddress || typeof commandAddress === 'string') throw new Error('Command host failed to bind loopback TCP.')

writeJsonAtomic(endpointManifestPath, {
  protocolVersion: UI_VALIDATION_PROTOCOL_VERSION,
  runId,
  surface: 'webui',
  transport: 'http',
  url: `http://127.0.0.1:${commandAddress.port}`,
  pid: process.pid,
  readyAt: new Date().toISOString(),
}, 0o600)

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

async function dispatch(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (method === 'ui.capabilities') return queryUiValidationCapabilities('webui', {
    operation: params.operation,
    kind: params.kind,
    id: params.id,
  } as UiValidationCapabilitiesQuery)
  if (method === 'app.status') return appStatus()
  if (method === 'ui.windows') return webWindows()
  if (method === 'app.open') return openRoute(params)
  if (method === 'scenario.apply') return applyScenario(params)
  if (method === 'scenario.reset') return resetScenario()
  if (method === 'clock.advance') return appShellScenarioCommand('clock.advance', params.ms)
  if (method === 'fault.set') return appShellScenarioCommand('fault.set', params.fault ?? params)
  if (method === 'fault.clear') return appShellScenarioCommand('fault.clear', params.faultId)
  if (method === 'fault.status') return appShellScenarioCommand('snapshot')
  if (method === 'ui.snapshot') return snapshotResponse(params)
  if (method === 'ui.action') return action(params, signal)
  if (method === 'ui.wait') return waitFor(params, signal)
  if (method === 'ui.screenshot') return captureDriverScreenshot(params)
  if (method === 'ui.logs') return readDriverLogs(params)
  if (method === 'ui.resize') return resizeDriverViewport(params)
  if (method === 'ui.assert') return assertCondition(params)
  if (method === 'evidence.capture') return captureEvidence(params)
  if (method === 'app.shutdown') return { stopping: true }
  throw new UiValidationError('METHOD_NOT_FOUND', `Unsupported command: ${method}`)
}

async function webWindows(): Promise<Array<Record<string, unknown>>> {
  const active = activePage()
  const url = new URL(active.url())
  url.search = ''
  url.hash = ''
  return [{
    windowId: 'webui-main',
    title: await active.title(),
    url: url.toString(),
    focused: true,
    visible: !active.isClosed(),
    viewport: active.viewportSize(),
  }]
}

async function captureDriverScreenshot(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const label = boundedLabel(params.label, 'screenshot')
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
  const outputPath = join(artifactsDir, 'driver', `${id}-${label}.png`)
  await mkdir(dirname(outputPath), { recursive: true })
  await activePage().screenshot({ path: outputPath, fullPage: params.fullPage !== false })
  return {
    artifact: await artifact('screenshot', outputPath, 'image/png'),
    viewport: activePage().viewportSize(),
  }
}

async function readDriverLogs(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxBytes = boundedLogBytes(params.maxBytes)
  const runtime = await runtimeLog()
  const result = redactValue({
    runtime: tailText(runtime, maxBytes),
    console: consoleEvents.slice(-200),
    pageErrors: pageErrors.slice(-100),
  }, [token, serverSecret])
  return { maxBytes, logs: result }
}

async function resizeDriverViewport(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const width = boundedViewportDimension(params.width, 'width', 320, 7680)
  const height = boundedViewportDimension(params.height, 'height', 240, 4320)
  await activePage().setViewportSize({ width, height })
  await settleRenderer()
  return { resized: true, viewport: { width, height }, revision: await liveRevision() }
}

async function appStatus(): Promise<Record<string, unknown>> {
  const browserPage = activePage()
  const renderer = await rendererStateSnapshot()
  const app = renderer.states.find(state => state.scope === 'app')
  const transport = renderer.states.find(state => state.scope === 'transport')
  const workspace = renderer.states.find(state => state.scope === 'workspace')
  const route = renderer.states.find(state => state.scope === 'route')
  const ready = !browserPage.isClosed() && app?.phase === 'ready' && transport?.phase === 'ready'
  return {
    phase: app?.phase ?? 'loading', ready, surface: 'webui', url: redactUrl(browserPage.url()),
    route: route?.detail ?? currentRoute,
    pending: {
      rpc: transport?.phase === 'ready' ? 0 : 1,
      render: app?.phase === 'busy' ? 1 : 0,
      transitions: workspace?.phase === 'busy' || route?.phase === 'busy' ? 1 : 0,
    },
    stateRevision: renderer.revision,
  }
}

interface WebRendererStateSnapshot {
  revision: number
  latestSeq: number
  states: Array<{ scope: string; phase: string; entityId?: string; detail?: Record<string, unknown> }>
}

async function rendererStateSnapshot(): Promise<WebRendererStateSnapshot> {
  return await activePage().evaluate(() => {
    const host = window.__mortiseUiValidation as typeof window.__mortiseUiValidation & { stateSnapshot?: () => WebRendererStateSnapshot }
    return host?.stateSnapshot?.() ?? { revision: 0, latestSeq: 0, states: [] }
  })
}

async function openRoute(params: Record<string, unknown>): Promise<unknown> {
  const { route, query } = routeFromParams(params)
  const browserPage = activePage()
  if (route.surface === 'chat' && (route.sessionId || route.workspaceId)) {
    await browserPage.goto(`${webUrl}?${query}`, { waitUntil: 'domcontentloaded', timeout: boundedTimeout(params.timeoutMs) })
    await waitForAppReady(boundedTimeout(params.timeoutMs))
  } else if (route.surface !== 'chat') {
    const semanticIds: Record<string, string> = {
      settings: 'navigation.nav_settings',
      skills: 'navigation.nav_skills',
      automations: 'navigation.nav_automations',
    }
    if (route.surface === 'workspace-picker') throw new UiValidationError('UNSUPPORTED', 'WebUI does not expose the native workspace picker.')
    const nav = browserPage.locator(`[data-mortise-semantic-id=${JSON.stringify(semanticIds[route.surface])}]`)
    if (await nav.count() !== 1) throw new UiValidationError('TARGET_NOT_FOUND', `Registered ${route.surface} navigation control is unavailable.`)
    await nav.click({ timeout: boundedTimeout(params.timeoutMs) })
    if (route.section) {
      const sectionId = route.surface === 'settings' ? `settings.${route.section}`
        : route.surface === 'automations' ? `navigation.nav_automations_${route.section}`
          : undefined
      if (!sectionId) throw new UiValidationError('UNSUPPORTED', `Route section is not supported for ${route.surface}.`)
      const section = browserPage.locator(`[data-mortise-semantic-id=${JSON.stringify(sectionId)}]`)
      if (await section.count() !== 1) throw new UiValidationError('TARGET_NOT_FOUND', `Route section ${route.section} is unavailable.`)
      await section.click({ timeout: boundedTimeout(params.timeoutMs) })
    }
  }
  currentRoute = route
  await settleRenderer()
  const next = await snapshot()
  return { route, settled: true, revision: next.revision }
}

async function applyScenario(raw: Record<string, unknown>): Promise<unknown> {
  const request = parseUiValidationScenarioApplyRequest(raw)
  if ((UI_VALIDATION_APP_SHELL_SCENARIO_IDS as readonly string[]).includes(request.name)) {
    await ensureWebScenarioHost()
    const result = await appShellScenarioCommand('apply', request) as { seed?: unknown; revision?: unknown }
    const state = await appShellScenarioCommand('snapshot') as { clock?: { mode?: unknown; virtualizedDomains?: unknown }; revision?: unknown }
    const clockDomains = Array.isArray(state.clock?.virtualizedDomains) ? state.clock.virtualizedDomains.filter((value): value is string => typeof value === 'string') : []
    activeWebScenario = {
      id: request.name,
      seed: typeof result.seed === 'number' ? result.seed : request.seed ?? 0,
      clock: state.clock?.mode === 'frozen' ? 'frozen' : 'real',
      clockDomains,
      state,
    }
    return { ...result, state, verificationLevel: 'scenario-verified', clocks: { application: activeWebScenario.clock, applicationDomains: clockDomains, os: 'not-virtualized', network: 'not-virtualized' } }
  }
  if (!['app.default', 'default'].includes(request.name)) {
    throw new UiValidationError('SCENARIO_INVALID', `WebUI scenario is not registered: ${request.name}`)
  }
  const browserPage = activePage()
  if (request.viewport) await browserPage.setViewportSize({ width: request.viewport.width, height: request.viewport.height })
  if (request.theme) await browserPage.emulateMedia({ colorScheme: request.theme === 'system' ? null : request.theme })
  if (request.clock?.mode === 'frozen') throw new UiValidationError('UNSUPPORTED', 'Frozen application timers require the scenario service adapter.')
  if (request.reset) {
    await browserPage.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: UI_VALIDATION_EXTENDED_TIMEOUT_MS })
    await waitForAppReady(UI_VALIDATION_EXTENDED_TIMEOUT_MS)
    currentRoute = { surface: 'unknown' }
  }
  const next = await snapshot()
  return { scenarioId: 'webui:app.default', name: request.name, seed: request.seed ?? 0, revision: next.revision, aliases: {} }
}

async function resetScenario(): Promise<unknown> {
  if (activeWebScenario) {
    const result = await appShellScenarioCommand('reset')
    activeWebScenario = undefined
    return { reset: true, result, revision: await liveRevision(), verificationLevel: 'scenario-verified' }
  }
  return await applyScenario({ name: 'app.default', reset: true })
}

type WebScenarioMethod = 'apply' | 'reset' | 'snapshot' | 'clock.advance' | 'fault.set' | 'fault.clear'

async function ensureWebScenarioHost(): Promise<void> {
  const browserPage = activePage()
  const url = new URL(browserPage.url())
  if (url.searchParams.get('__mortiseUiScenarioHost') !== '1') {
    url.search = ''
    url.searchParams.set('__mortiseUiScenarioHost', '1')
    await browserPage.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: UI_VALIDATION_EXTENDED_TIMEOUT_MS })
    await waitForAppReady(UI_VALIDATION_EXTENDED_TIMEOUT_MS)
  }
  await browserPage.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__MORTISE_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__), undefined, { timeout: UI_VALIDATION_DEFAULT_TIMEOUT_MS })
}

async function appShellScenarioCommand(method: WebScenarioMethod, input?: unknown): Promise<unknown> {
  if (method !== 'apply') await ensureWebScenarioHost()
  return await activePage().evaluate(async ({ method, input }) => {
    const bridge = (globalThis as Record<string, any>).__MORTISE_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__
    if (!bridge || bridge.schemaVersion !== 1) throw new Error('AppShell scenario bridge is unavailable.')
    if (method === 'clock.advance') return await bridge.clock.advance(input)
    if (method === 'fault.set') return await bridge.fault.set(input)
    if (method === 'fault.clear') return await bridge.fault.clear(input)
    return await bridge[method](input)
  }, { method, input })
}

async function snapshot(): Promise<SemanticSnapshot> {
  const raw = await activePage().evaluate(() => {
    const state = (window as unknown as { __mortiseUiValidation?: { revision: number; snapshot?: (options?: { maxNodes?: number; maxStringLength?: number }) => unknown } }).__mortiseUiValidation
    const revision = state?.revision ?? 0
    const business = typeof state?.snapshot === 'function' ? state.snapshot({ maxNodes: 1_000, maxStringLength: 2_048 }) : null
    const selectors = '[role],button,a,input,textarea,select,[data-testid],[aria-label],[contenteditable="true"],h1,h2,h3,[aria-live]'
    const all = [...document.querySelectorAll<HTMLElement>(selectors)].slice(0, 2_000)
    const cssPath = (element: Element): string => {
      const testId = element.getAttribute('data-testid')
      if (testId) return `[data-testid=${JSON.stringify(testId)}]`
      const parts: string[] = []
      let current: Element | null = element
      while (current && current !== document.documentElement && parts.length < 12) {
        let part = current.tagName.toLowerCase()
        if (current.id) { part += `#${CSS.escape(current.id)}`; parts.unshift(part); break }
        const parent: Element | null = current.parentElement
        if (parent) part += `:nth-child(${[...parent.children].indexOf(current) + 1})`
        parts.unshift(part)
        current = parent
      }
      return parts.join(' > ')
    }
    const implicitRole = (element: HTMLElement): string => {
      if (element.getAttribute('role')) return element.getAttribute('role')!
      const tag = element.tagName.toLowerCase()
      if (tag === 'button') return 'button'
      if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'select') return 'combobox'
      if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading'
      if (tag === 'input') {
        const type = (element as HTMLInputElement).type
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (['button', 'submit', 'reset'].includes(type)) return 'button'
        return 'textbox'
      }
      if (element.isContentEditable) return 'textbox'
      return element.hasAttribute('aria-live') ? 'status' : 'generic'
    }
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const descriptors = all.filter(visible).map(element => {
      const input = element as HTMLInputElement
      const rect = element.getBoundingClientRect()
      const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt')
        || input.placeholder || element.innerText?.trim().replace(/\s+/g, ' ').slice(0, 500) || ''
      const sensitive = input.type === 'password' || /password|secret|token|api.?key/i.test(`${label} ${element.getAttribute('name') ?? ''}`)
      return {
        source: 'dom' as const, selector: cssPath(element), testId: element.getAttribute('data-testid') || undefined,
        role: implicitRole(element), name: label, description: element.getAttribute('aria-description') || undefined,
        value: sensitive ? '[REDACTED]' : ('value' in input ? String(input.value).slice(0, 1_000) : undefined),
        states: {
          disabled: input.disabled || element.getAttribute('aria-disabled') === 'true',
          checked: input.type === 'checkbox' || input.type === 'radio' ? input.checked : undefined,
          selected: element.getAttribute('aria-selected') === 'true', expanded: element.getAttribute('aria-expanded') === 'true',
          busy: element.getAttribute('aria-busy') === 'true', focused: document.activeElement === element,
        },
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })
    const focused = document.activeElement instanceof HTMLElement ? cssPath(document.activeElement) : undefined
    return { revision, descriptors, focused, business }
  })
  const accessibilityDescriptors = await captureWebAccessibilityDescriptors()
  const business = raw.business as null | { nodes?: Array<{
    id: string; role: string; name: string; value?: string; description?: string; state?: WebSemanticDescriptor['states']; actions?: string[]
    actionModes?: { semantic?: string[]; physical?: string[] }; domSelector: string
  }> }
  const domBySelector = new Map(raw.descriptors.map(descriptor => [descriptor.selector, descriptor]))
  const businessDescriptors: WebSemanticDescriptor[] = (business?.nodes ?? []).map(node => {
    const dom = domBySelector.get(node.domSelector)
    return {
      source: 'business',
      selector: node.domSelector,
      semanticId: node.id,
      role: node.role,
      name: node.name,
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.description === undefined ? {} : { description: node.description }),
      states: { ...dom?.states, ...node.state },
      ...(dom?.bounds ? { bounds: dom.bounds } : {}),
      actions: (node.actions ?? []).filter((action): action is NonNullable<WebSemanticDescriptor['actions']>[number] =>
        ['click', 'fill', 'select', 'press', 'drag', 'shortcut', 'clipboard', 'ime', 'rich-text'].includes(action)),
      ...(node.actionModes ? {
        actionModes: {
          semantic: (node.actionModes.semantic ?? []).filter((action): action is NonNullable<WebSemanticDescriptor['actions']>[number] =>
            ['click', 'fill', 'select', 'press', 'drag', 'shortcut', 'clipboard', 'ime', 'rich-text'].includes(action)),
          physical: (node.actionModes.physical ?? []).filter((action): action is NonNullable<WebSemanticDescriptor['actions']>[number] =>
            ['click', 'fill', 'select', 'press', 'drag', 'shortcut', 'clipboard', 'ime', 'rich-text'].includes(action)),
        },
      } : {}),
    }
  })
  const built = buildWebSemanticSnapshot({
    revision: raw.revision,
    descriptors: [...raw.descriptors, ...accessibilityDescriptors, ...businessDescriptors],
    route: currentRoute,
    focusedSelector: raw.focused,
  })
  lastSnapshot = built.snapshot
  rememberWebSnapshot(built.snapshot)
  descriptorsByNodeId = built.descriptorsByNodeId
  return built.snapshot
}

interface RawWebAxNode extends WebAccessibilityNode {
  ignored?: boolean
  backendDOMNodeId?: number
}

async function captureWebAccessibilityDescriptors(): Promise<WebSemanticDescriptor[]> {
  if (!context) throw new UiValidationError('DRIVER_DISCONNECTED', 'The WebUI browser context is unavailable.')
  const session = await context.newCDPSession(activePage())
  try {
    await session.send('Accessibility.enable')
    const tree = await session.send('Accessibility.getFullAXTree') as { nodes?: RawWebAxNode[] }
    const candidates = (tree.nodes ?? []).filter(node => {
      if (node.ignored || !Number.isSafeInteger(node.backendDOMNodeId)) return false
      const role = boundedAxString(node.role?.value, 100).toLocaleLowerCase()
      return role.length > 0 && !['none', 'generic', 'statictext', 'inlinetextbox'].includes(role)
    }).slice(0, 500)
    const descriptors: WebSemanticDescriptor[] = []
    for (let offset = 0; offset < candidates.length; offset += 25) {
      const batch = await Promise.all(candidates.slice(offset, offset + 25).map(node => resolveWebAxNode(session, node)))
      descriptors.push(...batch.filter((item): item is WebSemanticDescriptor => item !== undefined))
    }
    return descriptors
  } catch (error) {
    throw new UiValidationError('DRIVER_DISCONNECTED', 'WebUI Accessibility Tree capture failed.', {
      details: { cause: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000) },
      retryable: true,
    })
  } finally {
    await session.detach().catch(() => undefined)
  }
}

async function resolveWebAxNode(session: CDPSession, node: RawWebAxNode): Promise<WebSemanticDescriptor | undefined> {
  const backendNodeId = node.backendDOMNodeId
  if (typeof backendNodeId !== 'number' || !Number.isSafeInteger(backendNodeId)) return undefined
  const resolved = await session.send('DOM.resolveNode', { backendNodeId }) as { object?: { objectId?: string } }
  const objectId = resolved.object?.objectId
  if (!objectId) return undefined
  try {
    const location = await session.send('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const element = this && this.nodeType === 1 ? this : this && this.parentElement;
        if (!element || !(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return null;
        const testId = element.getAttribute('data-testid');
        let selector = testId ? '[data-testid=' + JSON.stringify(testId) + ']' : '';
        if (!selector) {
          const parts = [];
          let current = element;
          while (current && current !== document.documentElement && parts.length < 12) {
            let part = current.tagName.toLowerCase();
            if (current.id) { part += '#' + CSS.escape(current.id); parts.unshift(part); break; }
            const parent = current.parentElement;
            if (parent) part += ':nth-child(' + ([...parent.children].indexOf(current) + 1) + ')';
            parts.unshift(part);
            current = parent;
          }
          selector = parts.join(' > ');
        }
        return { selector, testId: testId || undefined, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }`,
    }) as { result?: { value?: { selector?: unknown; testId?: unknown; bounds?: unknown } | null } }
    const value = location.result?.value
    if (!value || typeof value.selector !== 'string' || value.selector.length === 0) return undefined
    return buildWebAccessibilityDescriptor(node, {
      selector: value.selector,
      ...(typeof value.testId === 'string' ? { testId: value.testId } : {}),
      ...(isAxBounds(value.bounds) ? { bounds: value.bounds } : {}),
    })
  } finally {
    await session.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

function boundedAxString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' || typeof value === 'boolean' ? String(value).slice(0, max) : ''
}

function isAxBounds(value: unknown): value is NonNullable<WebSemanticDescriptor['bounds']> {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]))
}

async function snapshotResponse(params: Record<string, unknown>): Promise<unknown> {
  const target = params.target && typeof params.target === 'object' && !Array.isArray(params.target) ? params.target as Record<string, unknown> : undefined
  if (target?.kind === 'extension') return extensionDefinitionSnapshot(target)
  const current = await snapshot()
  if (params.sinceRevision === undefined) return current
  if (!Number.isSafeInteger(params.sinceRevision) || Number(params.sinceRevision) < 0) {
    throw new UiValidationError('INVALID_REQUEST', 'sinceRevision must be a non-negative safe integer.')
  }
  const sinceRevision = Number(params.sinceRevision)
  const previous = snapshotHistory.get(sinceRevision)
  if (!previous) return { ...current, sinceRevision, full: true, resetRequired: true }
  return incrementalWebSnapshot(previous, current)
}

async function extensionDefinitionSnapshot(target: Record<string, unknown>): Promise<unknown> {
  const bounded = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 10_000) throw new UiValidationError('INVALID_REQUEST', `${field} must be a bounded non-empty string.`)
    return value
  }
  const sessionId = bounded(target.sessionId, 'target.sessionId')
  const extensionId = bounded(target.extensionId, 'target.extensionId')
  const runtimeId = target.runtimeId === undefined ? undefined : bounded(target.runtimeId, 'target.runtimeId')
  const definitionId = target.definitionId === undefined ? undefined : bounded(target.definitionId, 'target.definitionId')
  const definitions = await activePage().evaluate(async filter => {
    const bridge = (globalThis as unknown as Record<string, unknown>).__MORTISE_UI_VALIDATION_EXTENSION_BRIDGE_V1__ as {
      schemaVersion?: number
      snapshot?: (input: { sessionId: string; extensionId: string }) => unknown
    } | undefined
    if (bridge?.schemaVersion !== 1 || typeof bridge.snapshot !== 'function') throw new Error('Extension validation bridge is unavailable.')
    return await Promise.resolve(bridge.snapshot(filter))
  }, { sessionId, extensionId }).catch(error => {
    throw new UiValidationError('NOT_READY', error instanceof Error ? error.message : String(error), { retryable: true })
  })
  if (!Array.isArray(definitions)) throw new UiValidationError('NOT_READY', 'Extension validation bridge returned an invalid snapshot.', { retryable: true })
  const selected = definitions.filter(item => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    const definition = record.definition && typeof record.definition === 'object' ? record.definition as Record<string, unknown> : undefined
    return (runtimeId === undefined || record.runtimeId === runtimeId) && (definitionId === undefined || definition?.id === definitionId)
  })
  if (definitionId && selected.length === 0) throw new UiValidationError('TARGET_NOT_FOUND', 'Extension validation definition was not found.')
  return { kind: 'extension', definitions: selected, revision: await liveRevision(), verificationLevel: 'scenario-verified' }
}

async function action(raw: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const request = parseUiValidationActionRequest(raw)
  const beforeState = await rendererStateSnapshot()
  const before = lastSnapshot ?? await snapshot()
  if (await liveRevision() !== before.revision) throw new UiValidationError('STALE_REF', 'The UI changed after the last snapshot.', { retryable: true })
  const resolved = resolveWebTarget(request.target, before, descriptorsByNodeId)
  if (resolved.node.states?.disabled) throw new UiValidationError('DISABLED', 'The target is disabled.')
  if (!resolved.node.actions?.includes(request.action)) throw new UiValidationError('UNSUPPORTED', `${request.action} is not declared for this target.`)
  const locator = activePage().locator(resolved.descriptor.selector)
  if (await locator.count() !== 1) throw new UiValidationError('STALE_REF', 'The target no longer resolves uniquely.', { retryable: true })
  const timeout = boundedTimeout(request.timeoutMs)
  const mode = request.mode ?? 'physical'
  if (resolved.descriptor.actionModes && !resolved.descriptor.actionModes[mode]?.includes(request.action)) {
    throw new UiValidationError('UNSUPPORTED', `${request.action} is not declared for ${mode} operation on this component.`)
  }
  let interaction: { visible: boolean; focused: boolean; hit: boolean; obscuredBy?: string } | undefined
  if (mode === 'semantic') {
    if (!resolved.descriptor.semanticId) throw new UiValidationError('UNSUPPORTED', 'This target has no command-backed business semantic action.')
    await activePage().evaluate(async semanticRequest => {
      const bridge = (window as unknown as { __mortiseUiValidation?: { action?: (request: typeof semanticRequest) => Promise<unknown> } }).__mortiseUiValidation
      if (typeof bridge?.action !== 'function') throw new Error('UI semantic bridge is unavailable')
      await bridge.action(semanticRequest)
    }, { id: resolved.descriptor.semanticId, action: request.action, ...(request.value === undefined ? {} : { value: request.value }) })
  } else {
  interaction = await locator.evaluate(element => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && style.pointerEvents !== 'none' && rect.width > 0 && rect.height > 0
    const top = visible ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
    const hit = !!top && (top === element || element.contains(top))
    return {
      visible,
      focused: document.activeElement === element || (!!document.activeElement && element.contains(document.activeElement)),
      hit,
      ...(hit || !top ? {} : { obscuredBy: top.tagName.toLowerCase() + (top.id ? `#${top.id}` : '') }),
    }
  })
  if (!interaction.visible) throw new UiValidationError('TARGET_NOT_FOUND', 'The target is not visible in the viewport.')
  if (!interaction.hit) throw new UiValidationError('TARGET_NOT_FOUND', 'The target is obscured at its interaction point.', { details: { obscuredBy: interaction.obscuredBy } })
  if (request.action === 'click') await locator.click({ timeout })
  else if (request.action === 'fill') {
    await locator.focus({ timeout })
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A', { timeout })
    await locator.press('Backspace', { timeout })
    await activePage().keyboard.type(request.value!, { delay: 0 })
  }
  else if (request.action === 'select') await locator.selectOption(request.value!, { timeout })
  else if (request.action === 'press' || request.action === 'shortcut') await locator.press([...modifierNames(request), request.key!].join('+'), { timeout })
  else if (request.action === 'clipboard') {
    await locator.focus({ timeout })
    await context!.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(webUrl).origin })
    await activePage().evaluate(value => navigator.clipboard.writeText(value), request.value!)
    await locator.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V', { timeout })
  } else if (request.action === 'ime') {
    await locator.focus({ timeout })
    const cdp = await context!.newCDPSession(activePage())
    try {
      await cdp.send('Input.imeSetComposition', {
        text: request.value!, selectionStart: request.value!.length, selectionEnd: request.value!.length,
        replacementStart: 0, replacementEnd: 0,
      })
      await cdp.send('Input.insertText', { text: request.value! })
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    } finally {
      await cdp.detach()
    }
  } else if (request.action === 'rich-text') {
    await locator.focus({ timeout })
    await activePage().keyboard.insertText(request.value!)
  } else if (request.action === 'drag') {
    const bounds = resolved.node.bounds
    if (!bounds) throw new UiValidationError('UNSUPPORTED', 'Drag requires target layout bounds.')
    const mouse = activePage().mouse
    await mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await mouse.down()
    await mouse.move(request.to!.x, request.to!.y, { steps: 10 })
    await mouse.up()
  } else throw new UiValidationError('UNSUPPORTED', `WebUI action is unsupported: ${request.action}`)
  }
  await settleRenderer()
  const settledBy = ['render-idle']
  if (raw.waitUntil && typeof raw.waitUntil === 'object' && !Array.isArray(raw.waitUntil)) {
    const waitUntil = raw.waitUntil as Record<string, unknown>
    await waitFor({
      ...(waitUntil.predicate === undefined ? { predicate: waitUntil } : waitUntil),
      timeoutMs: typeof waitUntil.timeoutMs === 'number' ? waitUntil.timeoutMs : request.timeoutMs,
      afterSeq: beforeState.latestSeq,
      ...(typeof waitUntil.stableForMs === 'number' ? { stableForMs: waitUntil.stableForMs } : typeof raw.stableForMs === 'number' ? { stableForMs: raw.stableForMs } : {}),
    }, signal)
    settledBy.push('explicit-condition')
  }
  if (Array.isArray(raw.settle)) {
    for (const condition of raw.settle) {
      if (condition !== 'rpc-idle' && condition !== 'render-idle') throw new UiValidationError('UNSUPPORTED', `Unsupported WebUI settle condition: ${String(condition)}`)
      await waitFor({ predicate: { kind: condition }, timeoutMs: request.timeoutMs, afterSeq: beforeState.latestSeq }, signal)
      if (!settledBy.includes(condition)) settledBy.push(condition)
    }
  }
  const after = await snapshot()
  const stateEvents = await activePage().evaluate(afterSeq => {
    const host = window.__mortiseUiValidation as typeof window.__mortiseUiValidation & { readStateEvents?: (cursor: number) => { latestSeq: number; events: Array<Record<string, unknown>> } }
    return host?.readStateEvents?.(afterSeq) ?? { latestSeq: afterSeq, events: [] }
  }, beforeState.latestSeq)
  return {
    actionId: randomUUID(), beforeRevision: before.revision, afterRevision: after.revision,
    targetResolved: pickTarget(resolved.node),
    eventSeqs: stateEvents.events.map(event => Number(event.seq)).filter(Number.isSafeInteger),
    stateChanges: stateEvents.events.filter(event => String(event.type).startsWith('state.')).map(event => event.payload),
    settledBy,
    observed: { route: currentRoute, focusRef: after.focusRef, ...(interaction ? { interaction } : {}) },
    warnings: request.action === 'select' && mode === 'physical' ? ['select uses the component selection adapter and is scenario-verified'] : [],
    mode,
    verificationLevel: mode === 'semantic' || request.action === 'select' ? 'scenario-verified' : 'renderer-verified',
  }
}

async function waitFor(raw: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const request = parseUiValidationWaitRequest(raw)
  const timeoutMs = boundedTimeout(request.timeoutMs)
  const stableForMs = request.stableForMs ?? 0
  const matched = await waitForWebCondition({
    baseline: webWaitBaseline,
    evaluate: () => evaluatePredicate(request.predicate, request.afterSeq),
    waitForChange: waitForPageSignal,
    timeoutMs,
    stableForMs,
    signal,
  })
  const state = await rendererStateSnapshot()
  return {
    matchedAtSeq: state.latestSeq,
    revision: Math.max(await liveRevision(), state.revision),
    elapsedMs: matched.elapsedMs,
    observed: matched.observed,
  }
}

async function assertCondition(raw: Record<string, unknown>): Promise<unknown> {
  const request = raw.predicate ? parseUiValidationWaitRequest(raw) : parseUiValidationWaitRequest({ predicate: raw })
  const observed = await evaluatePredicate(request.predicate, request.afterSeq)
  if (!observed.matched) throw new UiValidationError('TARGET_NOT_FOUND', 'UI assertion did not match.', { details: { observed: observed.value as never } })
  return { matched: true, revision: await liveRevision(), observed: observed.value }
}

async function evaluatePredicate(predicate: UiValidationWaitPredicate, afterSeq = 0): Promise<{ matched: boolean; value: unknown }> {
  if (predicate.kind === 'app-phase') { const value = await appStatus(); return { matched: value.phase === predicate.phase, value } }
  if (predicate.kind === 'route') {
    const matched = Object.entries(predicate.route).every(([key, value]) => currentRoute[key as keyof UiValidationRoute] === value)
    return { matched, value: currentRoute }
  }
  if (predicate.kind === 'rpc-idle' || predicate.kind === 'render-idle') {
    const status = await appStatus()
    const pending = status.pending as { rpc: number; render: number; transitions: number }
    const count = predicate.kind === 'rpc-idle' ? pending.rpc : pending.render + pending.transitions
    return { matched: count === 0, value: { pending: count } }
  }
  if (predicate.kind === 'session-state') {
    const renderer = await rendererStateSnapshot()
    const session = renderer.states.find(state => state.scope === 'session' && state.entityId === predicate.sessionId)
    const detailState = session?.detail?.state ?? session?.detail?.status
    return { matched: session?.phase === predicate.state || detailState === predicate.state, value: session ?? null }
  }
  if (predicate.kind === 'state') {
    const renderer = await rendererStateSnapshot()
    const state = renderer.states.find(item => item.scope === predicate.scope
      && (predicate.windowId === undefined || item.windowId === predicate.windowId)
      && (predicate.entityId === undefined || item.entityId === predicate.entityId)
      && (predicate.phase === undefined || item.phase === predicate.phase)
      && (predicate.detail === undefined || Object.entries(predicate.detail).every(([key, value]) => item.detail?.[key] === value)))
    return { matched: state !== undefined, value: state ?? { predicate, state: renderer } }
  }
  if (predicate.kind === 'event') {
    const result = await activePage().evaluate(({ type, after }) => {
      const host = window.__mortiseUiValidation as typeof window.__mortiseUiValidation & { readStateEvents?: (afterSeq: number) => { latestSeq: number; events: Array<Record<string, unknown>>; droppedBeforeSeq?: number } }
      const events = host?.readStateEvents?.(after) ?? { latestSeq: 0, events: [] }
      return { latestSeq: events.latestSeq, droppedBeforeSeq: events.droppedBeforeSeq, event: events.events.find(event => event.type === type) }
    }, { type: predicate.type, after: afterSeq })
    if (result.droppedBeforeSeq !== undefined) {
      throw new UiValidationError('EVENTS_DROPPED', 'Requested WebUI validation events are no longer available.', {
        details: { afterSeq, droppedBeforeSeq: result.droppedBeforeSeq },
        retryable: true,
      })
    }
    return { matched: result.event !== undefined, value: result.event ?? { latestSeq: result.latestSeq } }
  }
  const current = await snapshot()
  if (predicate.kind === 'semantic-ready') {
    return { matched: current.nodes.length > 0, value: { nodeCount: current.nodes.length, revision: current.revision } }
  }
  if (predicate.kind === 'text') {
    const matches = current.nodes.filter(node => predicate.exact ? node.name === predicate.value : node.name.includes(predicate.value))
    return { matched: matches.length > 0, value: { count: matches.length, refs: matches.slice(0, 10).map(node => node.ref) } }
  }
  try {
    const resolved = resolveWebTarget(predicate.target, current, descriptorsByNodeId)
    const value = predicate.state ? resolved.node.states?.[predicate.state] : true
    return { matched: predicate.state ? value === (predicate.equals ?? true) : true, value: pickTarget(resolved.node) }
  } catch (error) {
    if (error instanceof UiValidationError && error.code === 'TARGET_NOT_FOUND') return { matched: false, value: { count: 0 } }
    throw error
  }
}

async function captureEvidence(raw: Record<string, unknown>): Promise<unknown> {
  const request = parseUiValidationEvidenceCaptureRequest({
    label: typeof raw.label === 'string' ? raw.label : 'evidence',
    include: Array.isArray(raw.include) ? raw.include : ['screenshot', 'semantic-snapshot', 'events', 'console', 'page-errors', 'network-summary', 'driver-info', 'runtime-log', 'state-manifest'],
    ...(raw.afterSeq === undefined ? {} : { afterSeq: raw.afterSeq }), ...(raw.redact === undefined ? {} : { redact: raw.redact }),
  })
  if (request.include.includes('trace') && request.redact !== false) {
    throw new UiValidationError('UNSUPPORTED', 'Playwright trace can contain typed input and requires explicit redact:false acknowledgement.')
  }
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
  const bundleDir = join(artifactsDir, id)
  await mkdir(bundleDir, { recursive: true })
  const artifacts: UiValidationEvidenceArtifact[] = []
  const captureErrors: Array<{ kind: UiValidationEvidenceKind; message: string }> = []
  const add = async (kind: UiValidationEvidenceKind, name: string, mimeType: string, writer: (path: string) => Promise<void>) => {
    const path = join(bundleDir, name); await writer(path); artifacts.push(await artifact(kind, path, mimeType))
  }
  for (const kind of request.include) {
    try {
    if (kind === 'screenshot') await add(kind, 'screenshot.png', 'image/png', path => activePage().screenshot({ path, fullPage: true }).then(() => undefined))
    else if (kind === 'semantic-snapshot') {
      const previous = lastEvidenceSnapshot
      const current = await snapshot()
      await add(kind, 'snapshot.full.json', 'application/json', path => jsonFile(path, Promise.resolve(current)))
      await add(kind, 'snapshot.incremental.json', 'application/json', path => jsonFile(path, Promise.resolve(previous
        ? incrementalWebSnapshot(previous, current)
        : { ...current, sinceRevision: 0, full: true, resetRequired: true })))
      lastEvidenceSnapshot = structuredClone(current)
    }
    else if (kind === 'console') await add(kind, 'console.json', 'application/json', path => jsonFile(path, Promise.resolve(redactValue(consoleEvents, [token, serverSecret]))))
    else if (kind === 'page-errors') await add(kind, 'page-errors.json', 'application/json', path => jsonFile(path, Promise.resolve(redactValue(pageErrors, [token, serverSecret]))))
    else if (kind === 'network-summary') await add(kind, 'network-summary.json', 'application/json', path => jsonFile(path, Promise.resolve(redactValue(webNetworkSummary(), [token, serverSecret]))))
    else if (kind === 'driver-info') await add(kind, 'driver.json', 'application/json', path => jsonFile(path, Promise.resolve({ name: 'playwright-cdp', playwrightVersion: '1.61', rawProtocolExposed: false, browser: browser?.version() ?? 'unknown' })))
    else if (kind === 'runtime-log') await add(kind, 'runtime.log', 'text/plain', async path => writeFile(path, await runtimeLog(), 'utf8'))
    else if (kind === 'state-manifest') await add(kind, 'state.json', 'application/json', async path => {
      const [status, renderer] = await Promise.all([appStatus(), rendererStateSnapshot()])
      await jsonFile(path, Promise.resolve({
        protocolVersion: 1, runId, surface: 'webui', status, renderer, route: currentRoute,
        scenario: activeWebScenario ?? null, seed: activeWebScenario?.seed ?? null,
        viewport: activePage().viewportSize(), verificationLevel: runVerificationLevel,
        clocks: { application: activeWebScenario?.clock ?? 'real', applicationDomains: activeWebScenario?.clockDomains ?? [], os: 'not-virtualized', network: 'not-virtualized' },
        driver: { name: 'playwright-cdp', rawProtocolExposed: false }, createdAt: new Date().toISOString(),
      }))
    })
    else if (kind === 'events') await add(kind, 'events.json', 'application/json', async path => {
      const afterSeq = request.afterSeq ?? 0
      const events = await activePage().evaluate(cursor => {
        const host = window.__mortiseUiValidation as typeof window.__mortiseUiValidation & { readStateEvents?: (after: number) => unknown }
        return host?.readStateEvents?.(cursor) ?? { latestSeq: 0, events: [] }
      }, afterSeq)
      await jsonFile(path, Promise.resolve({ afterSeq, ...events as object }))
    })
    else if (kind === 'trace' && context && tracing) {
      const path = join(bundleDir, 'trace.zip')
      try {
        await context.tracing.stop({ path })
        tracing = false
        artifacts.push(await artifact(kind, path, 'application/zip'))
      } catch (error) {
        tracing = false
        const errorPath = join(bundleDir, 'trace.error.json')
        await jsonFile(errorPath, Promise.resolve({ error: error instanceof Error ? error.message : String(error) }))
        artifacts.push(await artifact(kind, errorPath, 'application/json'))
      } finally {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).then(() => { tracing = true }).catch(() => undefined)
      }
    }
    } catch (error) {
      captureErrors.push({ kind, message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (captureErrors.length > 0) {
    await add('page-errors', 'capture-errors.json', 'application/json', path => jsonFile(path, Promise.resolve(captureErrors)))
  }
  const renderer = await rendererStateSnapshot()
  const eventFrom = request.afterSeq === undefined ? renderer.latestSeq : Math.min(request.afterSeq + 1, renderer.latestSeq)
  return {
    bundleDir,
    artifacts,
    seqRange: { from: eventFrom, to: renderer.latestSeq },
    revision: Math.max(await liveRevision(), renderer.revision),
    verificationLevel: runVerificationLevel,
  }
}

function rememberWebSnapshot(snapshot: SemanticSnapshot): void {
  snapshotHistory.set(snapshot.revision, structuredClone(snapshot))
  while (snapshotHistory.size > 32) snapshotHistory.delete(snapshotHistory.keys().next().value!)
}

function incrementalWebSnapshot(previous: SemanticSnapshot, current: SemanticSnapshot): Record<string, unknown> {
  const before = new Map(previous.nodes.map(node => [node.nodeId, node]))
  const after = new Map(current.nodes.map(node => [node.nodeId, node]))
  const added: SemanticSnapshot['nodes'] = []
  const updated: SemanticSnapshot['nodes'] = []
  const removed: Array<{ nodeId: string; ref: string }> = []
  for (const [nodeId, node] of after) {
    const old = before.get(nodeId)
    if (!old) added.push(node)
    else if (JSON.stringify({ ...old, ref: undefined }) !== JSON.stringify({ ...node, ref: undefined })) updated.push(node)
  }
  for (const [nodeId, node] of before) if (!after.has(nodeId)) removed.push({ nodeId, ref: node.ref })
  return {
    sinceRevision: previous.revision,
    revision: current.revision,
    full: false,
    windowId: current.windowId,
    changes: { added, updated, removed },
  }
}

function attachPageEvidence(target: Page): void {
  target.on('console', message => boundedPush(consoleEvents, { at: new Date().toISOString(), type: message.type(), text: message.text().slice(0, 10_000) }, 1_000))
  target.on('pageerror', error => boundedPush(pageErrors, { at: new Date().toISOString(), message: error.message.slice(0, 10_000), stack: error.stack?.slice(0, 20_000) }, 1_000))
  target.on('response', response => boundedPush(networkEvents, {
    at: new Date().toISOString(), type: 'response', url: response.url(), status: response.status(), method: response.request().method(), resourceType: response.request().resourceType(),
  }, 2_000))
  target.on('requestfailed', request => boundedPush(networkEvents, {
    at: new Date().toISOString(), type: 'failed', url: request.url(), method: request.method(), resourceType: request.resourceType(), error: request.failure()?.errorText,
  }, 2_000))
}

function webNetworkSummary(): Record<string, unknown> {
  const byStatus: Record<string, number> = {}
  const byResourceType: Record<string, number> = {}
  const byOrigin: Record<string, number> = {}
  for (const entry of networkEvents) {
    const status = String(entry.status ?? entry.type ?? 'unknown')
    byStatus[status] = (byStatus[status] ?? 0) + 1
    const resourceType = String(entry.resourceType ?? 'unknown')
    byResourceType[resourceType] = (byResourceType[resourceType] ?? 0) + 1
    let origin = 'invalid'
    try { origin = new URL(String(entry.url)).origin } catch { /* invalid URL */ }
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1
  }
  return { captured: true, count: networkEvents.length, byStatus, byResourceType, byOrigin, requests: networkEvents }
}

function boundedPush<T>(target: T[], value: T, max: number): void {
  target.push(value)
  if (target.length > max) target.splice(0, target.length - max)
}

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  for (const [stream, source] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    source?.on('data', chunk => {
      const text = String(chunk); childOutput.push({ at: new Date().toISOString(), process: name, stream, text: text.slice(0, 20_000) })
      process[stream].write(`[web-${name}] ${text}`)
    })
  }
  return child
}

async function waitForAppReady(timeoutMs: number): Promise<void> {
  const browserPage = activePage()
  await browserPage.locator('#root').waitFor({ state: 'attached', timeout: timeoutMs })
  await browserPage.waitForFunction(() => Boolean((window as unknown as { electronAPI?: unknown }).electronAPI), undefined, { timeout: timeoutMs })
  await browserPage.locator('button,a,input,textarea,select,[role],[data-testid]').first().waitFor({ state: 'visible', timeout: timeoutMs })
}

async function settleRenderer(): Promise<void> {
  await activePage().evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))))
}

async function liveRevision(): Promise<number> {
  if (!page || page.isClosed()) throw new UiValidationError('DRIVER_DISCONNECTED', 'The WebUI page is unavailable.')
  return page.evaluate(() => (window as unknown as { __mortiseUiValidation?: { revision: number } }).__mortiseUiValidation?.revision ?? 0)
}

function activePage(): Page {
  if (!page || page.isClosed()) throw new UiValidationError('WINDOW_GONE', 'The WebUI page no longer exists.')
  return page
}

async function webWaitBaseline(): Promise<WebWaitBaseline> {
  const [revision, renderer] = await Promise.all([liveRevision(), rendererStateSnapshot()])
  return { revision: Math.max(revision, renderer.revision), latestSeq: renderer.latestSeq }
}

async function waitForPageSignal(baseline: WebWaitBaseline, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (timeoutMs <= 0) return
  if (signal?.aborted) throw abortedWebWait(signal)
  const cancelEvent = `mortise:ui-validation:wait-cancel:${randomUUID()}`
  const pageWait = activePage().evaluate(({ baseline, timeoutMs, cancelEvent }) => new Promise<'changed' | 'timeout' | 'cancelled'>(resolveWait => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (result: 'changed' | 'timeout' | 'cancelled') => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      observer.disconnect()
      window.removeEventListener('mortise:ui-validation:semantic-change', changed)
      window.removeEventListener('mortise:ui-validation:state-change', changed)
      window.removeEventListener(cancelEvent, cancelled)
      resolveWait(result)
    }
    const changed = () => finish('changed')
    const cancelled = () => finish('cancelled')
    const current = () => {
      const host = window.__mortiseUiValidation as typeof window.__mortiseUiValidation & { stateSnapshot?: () => { revision?: number; latestSeq?: number } }
      const state = host?.stateSnapshot?.()
      return {
        revision: Math.max(Number(host?.revision ?? 0), Number(state?.revision ?? 0)),
        latestSeq: Number(state?.latestSeq ?? 0),
      }
    }
    const observer = new MutationObserver(changed)
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    window.addEventListener('mortise:ui-validation:semantic-change', changed, { once: true })
    window.addEventListener('mortise:ui-validation:state-change', changed, { once: true })
    window.addEventListener(cancelEvent, cancelled, { once: true })
    const afterSubscribe = current()
    if (afterSubscribe.revision > baseline.revision || afterSubscribe.latestSeq > baseline.latestSeq) changed()
    else timeout = setTimeout(() => finish('timeout'), timeoutMs)
  }), { baseline, timeoutMs, cancelEvent })
  const onAbort = () => {
    const target = page
    if (target && !target.isClosed()) {
      void target.evaluate(eventName => window.dispatchEvent(new Event(eventName)), cancelEvent).catch(() => undefined)
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    const result = await pageWait
    if (result === 'cancelled' || signal?.aborted) throw abortedWebWait(signal)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

function abortedWebWait(signal?: AbortSignal): UiValidationError {
  return new UiValidationError('ABORTED', 'WebUI validation wait was aborted.', {
    details: signal?.reason === undefined ? undefined : { reason: String(signal.reason) },
    retryable: true,
  })
}

async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  commandServer.closeAllConnections()
  await new Promise<void>(resolveClose => commandServer.close(() => resolveClose()))
  await cleanup()
  process.exit(0)
}

async function cleanup(): Promise<void> {
  if (context && tracing) await context.tracing.stop().catch(() => undefined)
  tracing = false
  await browser?.close().catch(() => undefined)
  for (const child of children.reverse()) await terminateChild(child)
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolveDone => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', () => resolveDone()); killer.once('error', () => resolveDone())
    })
  } else child.kill('SIGTERM')
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Failed to reserve loopback port.'))
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { const response = await fetch(url); if (response.status < 500) return } catch { /* service is starting */ }
    if (children.some(child => child.exitCode !== null)) throw new Error('WebUI RPC or Vite process exited during startup.')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`WebUI did not become ready within ${timeoutMs}ms.`)
}

function findBrowserExecutable(): string {
  const configured = process.env.MORTISE_UI_BROWSER_EXECUTABLE
  const candidates = [configured,
    process.platform === 'win32' ? join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.platform === 'win32' ? join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
  ].filter((value): value is string => Boolean(value))
  const found = candidates.find(existsSync)
  if (!found) throw new Error('No Chromium browser found. Set MORTISE_UI_BROWSER_EXECUTABLE.')
  return found
}

function verificationLevel(method: string): UiValidationVerificationLevel {
  return method === 'ui.action' ? 'renderer-verified' : 'scenario-verified'
}

function resultVerificationLevel(method: string, result: unknown): UiValidationVerificationLevel {
  if (typeof result === 'object' && result !== null) {
    const level = (result as { verificationLevel?: unknown }).verificationLevel
    if (level === 'scenario-verified' || level === 'renderer-verified' || level === 'native-verified') return level
  }
  return verificationLevel(method)
}

function modifierNames(request: UiValidationActionRequest): string[] {
  const map = { shift: 'Shift', control: 'Control', alt: 'Alt', meta: 'Meta' }
  return (request.modifiers ?? []).map(value => map[value])
}

function pickTarget(node: SemanticSnapshot['nodes'][number]): Record<string, unknown> {
  return { ref: node.ref, nodeId: node.nodeId, ...(node.testId ? { testId: node.testId } : {}), role: node.role, name: node.name }
}

function recordParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UiValidationError('INVALID_REQUEST', 'params must be an object.')
  return value as Record<string, unknown>
}

function boundedTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_WAIT_MS) : UI_VALIDATION_DEFAULT_TIMEOUT_MS
}

function boundedLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.slice(0, 80).replace(/[^A-Za-z0-9._-]/g, '_') || fallback
}

function boundedLogBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 256_000
  return Math.max(1_024, Math.min(value, 1_000_000))
}

function boundedViewportDimension(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new UiValidationError('INVALID_REQUEST', `${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function tailText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value)
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8')
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function authorized(value: string | null): boolean {
  if (!value?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7)); const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function sendNodeJson(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
  response.end(body)
}

function redactUrl(value: string): string {
  try { const url = new URL(value); url.search = ''; url.hash = ''; return url.toString() } catch { return '[invalid-url]' }
}

async function artifact(kind: UiValidationEvidenceKind, path: string, mimeType: string): Promise<UiValidationEvidenceArtifact> {
  const bytes = await readFile(path); const info = await stat(path)
  return { kind, path, mimeType, sizeBytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function jsonFile(path: string, value: Promise<unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(await value, null, 2)}\n`, 'utf8')
}

async function runtimeLog(): Promise<string> {
  const path = join(mortiseConfigDir, 'logs', 'runtime.log')
  const runtime = await readFile(path, 'utf8').catch(() => 'runtime log unavailable')
  return `${runtime}\n\n[web-adapter]\n${JSON.stringify(redactValue(childOutput, [token, serverSecret]))}`
}
