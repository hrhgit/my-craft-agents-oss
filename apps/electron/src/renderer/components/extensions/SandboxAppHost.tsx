import * as React from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import type { ExtensionUINode } from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'

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
}

const STORAGE_PREFIX = 'craft.extensionSandbox.v1'
const MAX_MESSAGE_BYTES = 32_768
const MAX_STORAGE_BYTES = 65_536
const RATE_WINDOW_MS = 10_000
const RATE_LIMIT = 120

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
    }) });
    const acceptInit = event => {
      if (event.source !== parent || event.data?.type !== 'craft:sandbox-init' || event.data?.nonce !== ${JSON.stringify(nonce)} || !event.ports[0]) return;
      window.removeEventListener('message', acceptInit);
      port = event.ports[0];
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
  })();`
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${escapeClosingTag(node.css ?? '', 'style')}</style><script>${escapeClosingTag(bootstrap, 'script')}</script></head><body>${node.html}<script>${escapeClosingTag(node.script ?? '', 'script')}</script></body></html>`
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
  const loadedDocumentRef = React.useRef(false)
  const [nonce, setNonce] = React.useState(() => crypto.randomUUID())
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const minHeight = node.minHeight ?? 120
  const maxHeight = node.maxHeight ?? 720
  const [height, setHeight] = React.useState(node.preferredHeight ?? minHeight)
  const permissions = React.useMemo(() => new Set(node.permissions ?? []), [node.permissions])
  const srcDoc = React.useMemo(() => buildSandboxDocument(node, nonce), [node, nonce])

  React.useEffect(() => {
    setStatus('loading')
    onStatusChange?.('loading')
    channelRef.current?.port1.close()
    channelRef.current?.port2.close()
    channelRef.current = null
    loadedDocumentRef.current = false
  }, [extensionId, node, nonce, onStatusChange, runtimeId, sessionId])

  React.useEffect(() => {
    setHeight(node.preferredHeight ?? minHeight)
  }, [minHeight, node.preferredHeight])

  const handleLoad = React.useCallback(() => {
    const frame = iframeRef.current
    if (!frame?.contentWindow) return
    if (loadedDocumentRef.current) {
      channelRef.current?.port1.close()
      channelRef.current?.port2.close()
      setStatus('error')
      onStatusChange?.('error')
      return
    }
    loadedDocumentRef.current = true
    channelRef.current?.port1.close()
    channelRef.current?.port2.close()
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
      respond(requestId, false, undefined, 'Unsupported sandbox request')
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
    }, '*', [channel.port2])
  }, [extensionId, maxHeight, minHeight, node.appId, node.initialState, nonce, onStatusChange, permissions, runtimeId, sessionId])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => setStatus(current => {
      if (current !== 'loading') return current
      onStatusChange?.('error')
      return 'error'
    }), 5000)
    return () => {
      window.clearTimeout(timeout)
      channelRef.current?.port1.close()
      channelRef.current?.port2.close()
      channelRef.current = null
    }
  }, [extensionId, node, nonce, onStatusChange, runtimeId, sessionId])

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
