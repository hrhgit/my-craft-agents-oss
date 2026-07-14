import * as React from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import type { ExtensionUINode } from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'
import { extensionValidationStore } from './extension-validation-store'

type SandboxNode = Extract<ExtensionUINode, { type: 'sandbox-app' }>

interface SandboxAppHostProps {
  node: SandboxNode
  sessionId: string
  extensionId: string
  runtimeId: string
  onStatusChange?: (status: 'loading' | 'ready' | 'error') => void
}

type SandboxMessage = {
  type?: unknown
  requestId?: unknown
  command?: unknown
  args?: unknown
  key?: unknown
  value?: unknown
  height?: unknown
  definition?: unknown
  definitionId?: unknown
  state?: unknown
}

const STORAGE_PREFIX = 'craft.extensionSandbox.v1'
const MAX_MESSAGE_BYTES = 32_768
const MAX_STORAGE_BYTES = 65_536
const RATE_WINDOW_MS = 10_000
const RATE_LIMIT = 120
const sandboxValidationRevisions = new Map<string, number>()
const sandboxValidationLeases = new Map<string, symbol>()

type DevelopmentValidationHost = { schemaVersion: 1; available: true }

export function isSandboxValidationBridgeEnabled(node: SandboxNode, host?: DevelopmentValidationHost | null): boolean {
  const advertised = host ?? (typeof window === 'undefined' ? null : (window as unknown as {
    __CRAFT_EXTENSION_UI_VALIDATION__?: DevelopmentValidationHost
  }).__CRAFT_EXTENSION_UI_VALIDATION__ ?? null)
  return advertised?.schemaVersion === 1 && advertised.available === true && node.permissions?.includes('validation') === true
}

export function isAcceptableSandboxMessage(value: unknown): value is SandboxMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' && serialized.length <= MAX_MESSAGE_BYTES
  } catch {
    return false
  }
}

function escapeClosingTag(value: string, tag: 'script' | 'style'): string {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

function buildSandboxDocument(node: SandboxNode, nonce: string): string {
  const initialStateRevision = encodeURIComponent(JSON.stringify(node.initialState ?? null))
  const bootstrap = `(() => {
    let port;
    let sequence = 0;
    let resolveReady;
    const pending = new Map();
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const request = async (type, payload = {}) => {
      await ready;
      const requestId = 'sandbox-' + (++sequence);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        port.postMessage({ type, requestId, ...payload });
        setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(new Error('Craft sandbox request timed out'));
        }, 15000);
      });
    };
    let validationCapabilities = Object.freeze({ available: false, protocolVersions: [], verificationLevels: [], scenarios: false, sandboxBridge: false });
    Object.defineProperty(window, 'craft', { configurable: false, writable: false, value: Object.freeze({
      ready,
      invokeCommand: (command, args) => request('command.invoke', { command, args }),
      getTheme: () => request('theme.get'),
      resize: (height) => request('resize', { height }),
      storage: Object.freeze({
        get: (key) => request('storage.get', { key }),
        set: (key, value) => request('storage.set', { key, value }),
        delete: (key) => request('storage.delete', { key }),
      }),
      validation: Object.freeze({
        get capabilities() { return validationCapabilities; },
        publish: (definition) => request('validation.upsert', { definition }),
        updateState: (definitionId, state) => request('validation.updateState', { definitionId, state }),
        clear: (definitionId) => request('validation.remove', { definitionId }),
        clearAll: () => request('validation.reset'),
      }),
    }) });
    const acceptInit = event => {
      if (event.source !== parent || event.data?.nonce !== ${JSON.stringify(nonce)}) return;
      if (event.data?.type === 'craft:sandbox-probe') {
        parent.postMessage({ type: 'craft:sandbox-bootstrap-ready', nonce: ${JSON.stringify(nonce)} }, '*');
        return;
      }
      if (event.data?.type !== 'craft:sandbox-init' || !event.ports[0]) return;
      window.removeEventListener('message', acceptInit);
      port = event.ports[0];
      validationCapabilities = Object.freeze(event.data.validationCapabilities || validationCapabilities);
      port.onmessage = responseEvent => {
        const response = responseEvent.data;
        if (response?.type === 'response' && pending.has(response.requestId)) {
          const item = pending.get(response.requestId);
          pending.delete(response.requestId);
          if (response.ok) item.resolve(response.value); else item.reject(new Error(response.error || 'Sandbox request failed'));
        }
        if (response?.type === 'host-state') window.dispatchEvent(new CustomEvent('craftstate', { detail: response.value }));
      };
      port.start();
      resolveReady(event.data);
      port.postMessage({ type: 'ready' });
      window.dispatchEvent(new CustomEvent('craftready', { detail: event.data }));
    };
    window.addEventListener('message', acceptInit);
    parent.postMessage({ type: 'craft:sandbox-bootstrap-ready', nonce: ${JSON.stringify(nonce)} }, '*');
  })();`
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="craft-initial-state-revision" content="${initialStateRevision}"><style>${escapeClosingTag(node.css ?? '', 'style')}</style><script>${escapeClosingTag(bootstrap, 'script')}</script></head><body>${node.html}<script>${escapeClosingTag(node.script ?? '', 'script')}</script></body></html>`
}

function readTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const names = ['--background', '--foreground', '--muted', '--muted-foreground', '--border', '--accent', '--destructive']
  return Object.fromEntries(names.map(name => [name, style.getPropertyValue(name).trim()]))
}

function storageKey(extensionId: string, runtimeId: string, sessionId: string, appId: string): string {
  return `${STORAGE_PREFIX}.${encodeURIComponent(extensionId)}.${encodeURIComponent(runtimeId)}.${encodeURIComponent(sessionId)}.${encodeURIComponent(appId)}`
}

function loadStorage(extensionId: string, runtimeId: string, sessionId: string, appId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(extensionId, runtimeId, sessionId, appId)) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function saveStorage(extensionId: string, runtimeId: string, sessionId: string, appId: string, value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_STORAGE_BYTES) throw new Error('Sandbox storage quota exceeded')
  localStorage.setItem(storageKey(extensionId, runtimeId, sessionId, appId), serialized)
}

export function SandboxAppHost({ node, sessionId, extensionId, runtimeId, onStatusChange }: SandboxAppHostProps) {
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const channelRef = React.useRef<MessageChannel | null>(null)
  const initializedNonceRef = React.useRef<string | null>(null)
  const [nonce, setNonce] = React.useState(() => crypto.randomUUID())
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const minHeight = node.minHeight ?? 120
  const maxHeight = node.maxHeight ?? 720
  const [height, setHeight] = React.useState(node.preferredHeight ?? minHeight)
  const documentKey = JSON.stringify({
    appId: node.appId,
    html: node.html,
    css: node.css,
    script: node.script,
    initialState: node.initialState,
    minHeight: node.minHeight,
    maxHeight: node.maxHeight,
    preferredHeight: node.preferredHeight,
    permissions: node.permissions,
  })
  const permissions = React.useMemo(() => new Set(node.permissions ?? []), [documentKey])
  const validationEnabled = isSandboxValidationBridgeEnabled(node)
  const srcDoc = React.useMemo(() => buildSandboxDocument(node, nonce), [documentKey, nonce])
  const sandboxExtensionId = `${extensionId}:sandbox:${node.appId}`
  const validationOwnerKey = `${sessionId}\0${runtimeId}\0${sandboxExtensionId}`
  const nextValidationRevision = React.useCallback(() => {
    const revision = (sandboxValidationRevisions.get(validationOwnerKey) ?? 0) + 1
    sandboxValidationRevisions.set(validationOwnerKey, revision)
    return revision
  }, [validationOwnerKey])
  const resetValidation = React.useCallback(() => {
    if (!sandboxValidationRevisions.has(validationOwnerKey)) return
    extensionValidationStore.apply({
      schemaVersion: 1,
      extensionId: sandboxExtensionId,
      sessionId,
      runtimeId,
      revision: nextValidationRevision(),
      operation: 'reset',
    })
  }, [nextValidationRevision, runtimeId, sandboxExtensionId, sessionId, validationOwnerKey])

  React.useEffect(() => {
    const lease = Symbol(validationOwnerKey)
    sandboxValidationLeases.set(validationOwnerKey, lease)
    return () => {
      window.setTimeout(() => {
        if (sandboxValidationLeases.get(validationOwnerKey) !== lease) return
        resetValidation()
        sandboxValidationLeases.delete(validationOwnerKey)
      }, 0)
    }
  }, [documentKey, resetValidation, validationOwnerKey])

  React.useEffect(() => {
    setStatus('loading')
    onStatusChange?.('loading')
    channelRef.current?.port1.close()
    channelRef.current?.port2.close()
    channelRef.current = null
    initializedNonceRef.current = null
  }, [documentKey, extensionId, nonce, onStatusChange, runtimeId, sessionId])

  React.useEffect(() => {
    setHeight(node.preferredHeight ?? minHeight)
  }, [minHeight, node.preferredHeight])

  const initializeChannel = React.useCallback(() => {
    const frame = iframeRef.current
    if (!frame?.contentWindow) return
    if (initializedNonceRef.current === nonce) return
    initializedNonceRef.current = nonce
    channelRef.current?.port1.close()
    channelRef.current?.port2.close()
    resetValidation()
    const channel = new MessageChannel()
    channelRef.current = channel
    const timestamps: number[] = []
    const respond = (requestId: string, ok: boolean, value?: unknown, error?: string) => channel.port1.postMessage({ type: 'response', requestId, ok, value, error })
    channel.port1.onmessage = event => {
      if (!isAcceptableSandboxMessage(event.data)) return
      const now = Date.now()
      while (timestamps.length > 0 && (timestamps[0] ?? now) < now - RATE_WINDOW_MS) timestamps.shift()
      if (timestamps.length >= RATE_LIMIT) return
      timestamps.push(now)
      const message = event.data
      if (message.type === 'ready') {
        setStatus('ready')
        onStatusChange?.('ready')
        return
      }
      const requestId = typeof message.requestId === 'string' ? message.requestId : ''
      if (!requestId) return
      if (message.type === 'command.invoke') {
        if (!permissions.has('commands') || typeof message.command !== 'string' || message.command.length > 256) return respond(requestId, false, undefined, 'Command access denied')
        let args: string
        try {
          args = typeof message.args === 'string' ? message.args : JSON.stringify(message.args ?? {})
        } catch {
          return respond(requestId, false, undefined, 'Command arguments must be JSON serializable')
        }
        if (args.length > MAX_MESSAGE_BYTES) return respond(requestId, false, undefined, 'Command arguments are too large')
        void window.electronAPI?.invokeExtensionCommand?.(sessionId, message.command, args, extensionId)
          .then(result => respond(requestId, result.invoked, result, result.error))
          .catch(error => respond(requestId, false, undefined, error instanceof Error ? error.message : String(error)))
        return
      }
      if (message.type === 'theme.get') {
        return permissions.has('theme') ? respond(requestId, true, readTheme()) : respond(requestId, false, undefined, 'Theme access denied')
      }
      if (message.type === 'resize') {
        if (!permissions.has('resize') || typeof message.height !== 'number' || !Number.isFinite(message.height)) return respond(requestId, false, undefined, 'Resize access denied')
        const next = Math.max(minHeight, Math.min(maxHeight, Math.round(message.height)))
        setHeight(next)
        return respond(requestId, true, next)
      }
      if (message.type === 'storage.get' || message.type === 'storage.set' || message.type === 'storage.delete') {
        if (!permissions.has('storage') || typeof message.key !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(message.key) || ['__proto__', 'prototype', 'constructor'].includes(message.key)) return respond(requestId, false, undefined, 'Storage access denied')
        try {
          const current = loadStorage(extensionId, runtimeId, sessionId, node.appId)
          if (message.type === 'storage.get') return respond(requestId, true, current[message.key])
          if (message.type === 'storage.delete') delete current[message.key]
          else current[message.key] = message.value
          saveStorage(extensionId, runtimeId, sessionId, node.appId, current)
          return respond(requestId, true, true)
        } catch (error) {
          return respond(requestId, false, undefined, error instanceof Error ? error.message : String(error))
        }
      }
      if (message.type === 'validation.upsert') {
        if (!validationEnabled || !permissions.has('validation')) return respond(requestId, false, undefined, 'Validation bridge is unavailable')
        const accepted = extensionValidationStore.apply({
          schemaVersion: 1,
          extensionId: sandboxExtensionId,
          sessionId,
          runtimeId,
          revision: nextValidationRevision(),
          operation: 'upsert',
          definition: message.definition as never,
        }, { commandOwnerExtensionId: extensionId })
        return accepted ? respond(requestId, true, true) : respond(requestId, false, undefined, 'Validation definition was rejected')
      }
      if (message.type === 'validation.updateState') {
        if (!validationEnabled || !permissions.has('validation') || typeof message.definitionId !== 'string') return respond(requestId, false, undefined, 'Validation bridge is unavailable')
        const accepted = extensionValidationStore.updateState({
          extensionId: sandboxExtensionId,
          commandOwnerExtensionId: extensionId,
          sessionId,
          runtimeId,
        }, message.definitionId, nextValidationRevision(), message.state as never)
        return accepted ? respond(requestId, true, true) : respond(requestId, false, undefined, 'Validation state was rejected')
      }
      if (message.type === 'validation.remove') {
        if (!validationEnabled || !permissions.has('validation') || typeof message.definitionId !== 'string') return respond(requestId, false, undefined, 'Validation bridge is unavailable')
        const accepted = extensionValidationStore.apply({
          schemaVersion: 1,
          extensionId: sandboxExtensionId,
          sessionId,
          runtimeId,
          revision: nextValidationRevision(),
          operation: 'remove',
          definitionId: message.definitionId,
        }, { commandOwnerExtensionId: extensionId })
        return accepted ? respond(requestId, true, true) : respond(requestId, false, undefined, 'Validation definition was rejected')
      }
      if (message.type === 'validation.reset') {
        if (!validationEnabled || !permissions.has('validation')) return respond(requestId, false, undefined, 'Validation bridge is unavailable')
        const accepted = extensionValidationStore.apply({
          schemaVersion: 1,
          extensionId: sandboxExtensionId,
          sessionId,
          runtimeId,
          revision: nextValidationRevision(),
          operation: 'reset',
        }, { commandOwnerExtensionId: extensionId })
        return accepted ? respond(requestId, true, true) : respond(requestId, false, undefined, 'Validation definitions could not be cleared')
      }
      respond(requestId, false, undefined, 'Unsupported sandbox request')
    }
    channel.port1.onmessageerror = () => {
      setStatus('error')
      onStatusChange?.('error')
      resetValidation()
    }
    channel.port1.start()
    frame.contentWindow.postMessage({
      type: 'craft:sandbox-init',
      nonce,
      protocolVersion: 1,
      appId: node.appId,
      extensionId,
      sessionId,
      initialState: node.initialState,
      permissions: [...permissions],
      theme: permissions.has('theme') ? readTheme() : undefined,
      validationCapabilities: validationEnabled ? {
        schemaVersion: 1,
        available: true,
        protocolVersions: [1],
        verificationLevels: ['semantic', 'physical'],
        scenarios: true,
        sandboxBridge: true,
      } : { schemaVersion: 1, available: false, protocolVersions: [], verificationLevels: [], scenarios: false, sandboxBridge: false },
    }, '*', [channel.port2])
  }, [documentKey, extensionId, maxHeight, minHeight, nextValidationRevision, node.appId, nonce, onStatusChange, permissions, resetValidation, runtimeId, sandboxExtensionId, sessionId, validationEnabled])

  React.useEffect(() => {
    const handleBootstrapReady = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (event.data?.type !== 'craft:sandbox-bootstrap-ready' || event.data?.nonce !== nonce) return
      initializeChannel()
    }
    window.addEventListener('message', handleBootstrapReady)
    iframeRef.current?.contentWindow?.postMessage({ type: 'craft:sandbox-probe', nonce }, '*')
    return () => window.removeEventListener('message', handleBootstrapReady)
  }, [initializeChannel, nonce])

  const handleLoad = React.useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'craft:sandbox-probe', nonce }, '*')
  }, [nonce])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => setStatus(current => {
      if (current !== 'loading') return current
      onStatusChange?.('error')
      resetValidation()
      return 'error'
    }), 5000)
    return () => {
      window.clearTimeout(timeout)
      channelRef.current?.port1.close()
      channelRef.current?.port2.close()
      channelRef.current = null
      initializedNonceRef.current = null
    }
  }, [documentKey, extensionId, nonce, onStatusChange, runtimeId, sessionId])

  return (
    <div className="relative min-w-0 overflow-hidden border border-border/70 bg-background" data-sandbox-app={node.appId}>
      {status === 'error' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="size-4 text-amber-500" />
            <span>{node.title} did not start.</span>
            <button type="button" className="inline-flex size-7 items-center justify-center rounded hover:bg-muted" title="Reload extension app" onClick={() => { setStatus('loading'); onStatusChange?.('loading'); setNonce(crypto.randomUUID()) }}><RotateCw className="size-3.5" /></button>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={node.title}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={cn('block w-full border-0 bg-transparent', status === 'loading' && 'opacity-0')}
        style={{ height }}
        onLoad={handleLoad}
      />
    </div>
  )
}
