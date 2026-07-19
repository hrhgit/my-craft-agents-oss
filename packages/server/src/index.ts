#!/usr/bin/env bun
/**
 * @mortise/server — standalone headless Mortise Agent server.
 *
 * Usage:
 *   MORTISE_SERVER_TOKEN=<secret> bun run packages/server/src/index.ts
 *
 * Environment:
 *   MORTISE_SERVER_TOKEN         — required bearer token for client auth
 *   MORTISE_RPC_HOST             — bind address (default: 127.0.0.1)
 *   MORTISE_RPC_PORT             — bind port (default: 9100)
 *   MORTISE_RPC_TLS_CERT         — path to PEM certificate file (enables TLS/wss)
 *   MORTISE_RPC_TLS_KEY          — path to PEM private key file (required with cert)
 *   MORTISE_RPC_TLS_CA           — path to PEM CA chain file (optional)
 *   MORTISE_APP_ROOT             — app root path (default: cwd)
 *   MORTISE_RESOURCES_PATH       — resources path (default: cwd/resources)
 *   MORTISE_IS_PACKAGED          — 'true' for production (default: false)
 *   MORTISE_VERSION              — app version (default: 0.0.0-dev)
 *   MORTISE_DEBUG                — 'true' for debug logging
 *   MORTISE_WEBUI_DIR            — path to built web UI assets (enables web UI on RPC port)
 *   MORTISE_WEBUI_PASSWORD       — optional shorter password for web login (falls back to MORTISE_SERVER_TOKEN)
 *   MORTISE_WEBUI_SECURE_COOKIE  — optional true/false override for the session cookie Secure flag
 *   MORTISE_WEBUI_WS_URL         — optional browser-facing ws:// or wss:// URL returned by /api/config
 *   MORTISE_MESSAGING_WA_WORKER  — absolute path to worker.cjs (default: packages/messaging-whatsapp-worker/dist/worker.cjs)
 *   MORTISE_MESSAGING_NODE_BIN   — Node binary used to spawn the WhatsApp worker (default: node)
 */

import { join } from 'node:path'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { version as packageVersion } from '../package.json'
import { enableDebug } from '@mortise/shared/utils/debug'
import {
  bootstrapServer,
  generateServerToken,
  publishServerEndpoint,
  removeServerEndpoint,
  startHealthHttpServer,
} from '@mortise/server-core/bootstrap'
import { validateSession, createWebuiHandler, nodeHttpAdapter } from '@mortise/server-core/webui'
import type { WebuiHandler } from '@mortise/server-core/webui'
import { getCredentialManager } from '@mortise/shared/credentials'
import { CONFIG_DIR, getWorkspaces } from '@mortise/shared/config'
import { errorMessage } from '@mortise/shared/utils'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@mortise/messaging-gateway'

// --generate-token: print a crypto-random token and exit
if (process.argv.includes('--generate-token')) {
  console.log(generateServerToken())
  process.exit(0)
}
import type { WsRpcTlsOptions } from '@mortise/server-core/transport'
import { registerCoreRpcHandlers, cleanupClientFileWatches } from '@mortise/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@mortise/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@mortise/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@mortise/server-core/services'
import type { HandlerDeps } from '@mortise/server-core/handlers'

process.env.MORTISE_IS_PACKAGED ??= 'false'

// Prevent unhandled rejections from crashing the server.
// SDK subprocess abort can reject promises that propagate up unhandled;
// Bun (unlike Node) terminates the process on unhandled rejections by default.
process.on('unhandledRejection', (reason) => {
  const msg = errorMessage(reason)
  console.error(`[server] Unhandled rejection (caught, not crashing): ${msg}`)
})

if (process.env.MORTISE_DEBUG === 'true' || process.env.MORTISE_DEBUG === '1') {
  enableDebug()
}

function parseOptionalBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') return undefined

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false

  console.error(`Invalid ${name}: expected one of true/false/1/0/yes/no/on/off.`)
  process.exit(1)
}

function parseOptionalWebSocketUrl(name: string, value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('must use ws:// or wss://')
    }
    return value
  } catch (error) {
    const message = errorMessage(error)
    console.error(`Invalid ${name}: ${message}`)
    process.exit(1)
  }
}

// In dev (monorepo), bundled assets root is the repo root (4 levels up from this file).
// In packaged mode, use MORTISE_BUNDLED_ASSETS_ROOT env or cwd.
const bundledAssetsRoot = process.env.MORTISE_BUNDLED_ASSETS_ROOT
  ?? join(import.meta.dir, '..', '..', '..', '..')

// TLS configuration — when cert + key paths are provided, server listens on wss://
let tls: WsRpcTlsOptions | undefined
const tlsCertPath = process.env.MORTISE_RPC_TLS_CERT
const tlsKeyPath = process.env.MORTISE_RPC_TLS_KEY
if (tlsCertPath || tlsKeyPath) {
  if (!tlsCertPath || !tlsKeyPath) {
    console.error('TLS requires both MORTISE_RPC_TLS_CERT and MORTISE_RPC_TLS_KEY.')
    process.exit(1)
  }
  tls = {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
    ...(process.env.MORTISE_RPC_TLS_CA ? { ca: readFileSync(process.env.MORTISE_RPC_TLS_CA) } : {}),
  }
}

// Web UI configuration
const webuiDir = process.env.MORTISE_WEBUI_DIR || undefined
const webuiEnabled = webuiDir && existsSync(webuiDir)
const webuiSecureCookies = parseOptionalBooleanEnv('MORTISE_WEBUI_SECURE_COOKIE', process.env.MORTISE_WEBUI_SECURE_COOKIE)
const webuiWsUrl = parseOptionalWebSocketUrl('MORTISE_WEBUI_WS_URL', process.env.MORTISE_WEBUI_WS_URL)
const serverToken = process.env.MORTISE_SERVER_TOKEN
const rpcHost = process.env.MORTISE_RPC_HOST ?? '127.0.0.1'
const isLoopbackRpcHost = ['127.0.0.1', 'localhost', '::1'].includes(rpcHost)

// ---------------------------------------------------------------------------
// Create WebUI handler early so it can be embedded in the WsRpcServer.
// The handler is a pure function — it doesn't need the session manager yet
// because health checks are injected lazily via getHealthCheck().
// ---------------------------------------------------------------------------

let webuiHandler: WebuiHandler | null = null
let webuiNodeHandler: ReturnType<typeof nodeHttpAdapter> | undefined

// Health check is injected lazily — the session manager isn't ready until
// after bootstrap completes, but the handler captures the closure.
let healthCheckFn: (() => { status: string }) | null = null

if (webuiEnabled && serverToken) {
  const rpcPort = parseInt(process.env.MORTISE_RPC_PORT ?? '9100', 10)
  const rpcProtocol = tls ? 'wss' as const : 'ws' as const

  webuiHandler = createWebuiHandler({
    webuiDir: webuiDir!,
    secret: serverToken,
    password: process.env.MORTISE_WEBUI_PASSWORD || undefined,
    autoLogin: process.env.MORTISE_WEBUI_AUTO_LOGIN === 'true' && isLoopbackRpcHost,
    secureCookies: webuiSecureCookies,
    publicWsUrl: webuiWsUrl,
    wsProtocol: rpcProtocol,
    // WebUI is served on the same port as WS — wsPort matches the RPC port
    wsPort: rpcPort,
    getHealthCheck: () => healthCheckFn?.() ?? { status: 'starting' },
    logger: { info: console.log, warn: console.warn, error: console.error } as any,
  })

  webuiNodeHandler = nodeHttpAdapter(webuiHandler.fetch)
}

// Resolve WhatsApp worker paths up-front so the helper + Docker env stay in sync.
// The worker is a Node subprocess — Bun cannot run it directly — so we must
// pass an explicit `nodeBin` (Electron defaults nodeBin to process.execPath
// which is correct there but wrong under Bun).
const waWorkerEntry = process.env.MORTISE_MESSAGING_WA_WORKER
  ?? join(bundledAssetsRoot, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs')
const waNodeBin = process.env.MORTISE_MESSAGING_NODE_BIN ?? 'node'

// Built inside createHandlerDeps (needs sessionManager), populated with the WS
// publisher after bootstrapServer resolves.
let messagingHandle: MessagingBootstrapHandle | null = null

const instance = await (async () => {
  try {
    return await bootstrapServer<SessionManager, HandlerDeps>({
      bundledAssetsRoot,
      serverVersion: process.env.MORTISE_VERSION ?? packageVersion,
      tls,
      // When web UI is enabled, accept JWT session cookies on WebSocket upgrade
      validateSessionCookie: webuiEnabled && serverToken
        ? async (cookieHeader) => {
            const session = await validateSession(cookieHeader, serverToken)
            return session !== null
          }
        : undefined,
      // Embed the WebUI HTTP handler on the WS server's port
      httpHandler: webuiNodeHandler,
      applyPlatformToSubsystems: (platform) => {
        setFetcherPlatform(platform)
        setSessionPlatform(platform)
        setSessionRuntimeHooks({
          updateBadgeCount: () => {},
          captureException: (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            platform.captureError?.(err)
          },
        })
        setSearchPlatform(platform)
        setImageProcessor(platform.imageProcessor)
      },
      initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
        const manager = getCredentialManager()
        const [apiKey, oauth] = await Promise.all([
          manager.getProviderApiKey(slug).catch(() => null),
          manager.getProviderOAuth(slug).catch(() => null),
        ])
        return {
          apiKey: apiKey ?? undefined,
          oauthAccessToken: oauth?.accessToken,
          oauthRefreshToken: oauth?.refreshToken,
          oauthIdToken: oauth?.idToken,
        }
      }),
      createSessionManager: () => new SessionManager(),
      bindRpcServer: (sm, server) => sm.setRpcServer(server),
      createHandlerDeps: ({ sessionManager, platform, oauthFlowStore }) => {
        messagingHandle = createMessagingBootstrap({
          sessionManager,
          credentialManager: getCredentialManager(),
          getMessagingDir: (wsId: string) =>
            join(CONFIG_DIR, 'workspaces', wsId, 'messaging'),
          // Headless has no legacy messaging dir — workspaces start clean.
          whatsapp: {
            workerEntry: waWorkerEntry,
            nodeBin: waNodeBin,
            pairingMode: 'qr',
          },
        })
        return {
          sessionManager,
          platform,
          oauthFlowStore,
          messagingRegistry: messagingHandle.registry,
        }
      },
      registerAllRpcHandlers: registerCoreRpcHandlers,
      setSessionEventSink: (sessionManager, sink) => {
        if (!messagingHandle) {
          // createHandlerDeps always runs before setSessionEventSink, but be
          // defensive in case bootstrapServer's ordering ever changes.
          sessionManager.setEventSink(sink)
          return
        }
        sessionManager.setEventSink(messagingHandle.wrapSink(sink))
      },
      initializeSessionManager: async (sessionManager) => {
        await sessionManager.initialize()
      },
      cleanupSessionManager: async (sessionManager) => {
        try {
          await sessionManager.flushAllSessions()
        } finally {
          await sessionManager.cleanup()
        }
      },
      cleanupClientResources: cleanupClientFileWatches,
    })
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
})()

// ---------------------------------------------------------------------------
// Messaging post-bootstrap: bind the WS publisher and initialize local
// workspaces. Remote-owned workspaces are skipped because their messaging
// runs on the remote server.
// ---------------------------------------------------------------------------
if (messagingHandle !== null) {
  const handle: MessagingBootstrapHandle = messagingHandle
  handle.setPublisher(instance.wsServer.push.bind(instance.wsServer))
  try {
    const localWorkspaceIds = getWorkspaces()
      .filter((ws) => !ws.remoteServer)
      .map((ws) => ws.id)
    await handle.initializeWorkspaces(localWorkspaceIds)
  } catch (error) {
    console.error('[messaging] Workspace initialization failed:', error)
  }
}

// Wire up the lazy health check now that the session manager is ready
if (webuiHandler) {
  const { getHealthCheck } = await import('@mortise/server-core/handlers/rpc/server')
  const depsLike = { sessionManager: instance.sessionManager } as any
  healthCheckFn = () => getHealthCheck(depsLike)

  // Wire up OAuth callback deps so /api/oauth/callback works
  const { getSourceCredentialManager, loadWorkspaceSources } = await import('@mortise/shared/sources')
  const { getWorkspaceByNameOrId } = await import('@mortise/shared/config')
  const { pushTyped } = await import('@mortise/server-core/transport')
  const { RPC_CHANNELS } = await import('@mortise/shared/protocol')

  webuiHandler.setOAuthCallbackDeps({
    flowStore: instance.oauthFlowStore,
    credManager: getSourceCredentialManager(),
    sessionManager: instance.sessionManager,
    pushSourcesChanged: (workspaceId: string) => {
      const ws = getWorkspaceByNameOrId(workspaceId)
      const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
      pushTyped(instance.wsServer, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
    },
  })
}

// Start HTTP health endpoint if MORTISE_HEALTH_PORT is set
const healthPort = parseInt(process.env.MORTISE_HEALTH_PORT ?? '0', 10)
const healthServer = await startHealthHttpServer({
  port: healthPort,
  deps: { sessionManager: instance.sessionManager },
  wsServer: instance.wsServer,
  platform: instance.platform,
})

const serverProto = instance.protocol === 'wss' ? 'https' : 'http'
// Write token to a file with 0600 permissions instead of stdout,
// because container/logging systems often persist stdout and would leak the token.
const tokenFilePath = join(CONFIG_DIR, '.server-token')
writeFileSync(tokenFilePath, instance.token, { mode: 0o600 })

// Block binding to a non-localhost address without TLS — tokens would be sent in cleartext.
// Override with --allow-insecure-bind for explicitly trusted networks.
const isLocalBind = instance.host === '127.0.0.1' || instance.host === 'localhost' || instance.host === '::1'
if (!isLocalBind && instance.protocol === 'ws') {
  if (process.argv.includes('--allow-insecure-bind')) {
    console.warn(
      '\n⚠️  WARNING: Server is listening on a network address without TLS.\n' +
      '   Authentication tokens will be sent in cleartext.\n' +
      '   Set MORTISE_RPC_TLS_CERT and MORTISE_RPC_TLS_KEY to enable wss://.\n'
    )
  } else {
    console.error(
      '\n❌  Refusing to bind to a network address without TLS.\n' +
      '   Authentication tokens would be sent in cleartext.\n\n' +
      '   Options:\n' +
      '     1. Set MORTISE_RPC_TLS_CERT and MORTISE_RPC_TLS_KEY to enable wss://\n' +
      '     2. Pass --allow-insecure-bind to override (NOT recommended for production)\n'
    )
    await instance.stop()
    process.exit(1)
  }
}

const webuiAutoLogin = Boolean(webuiEnabled
  && process.env.MORTISE_WEBUI_AUTO_LOGIN === 'true'
  && isLocalBind)
publishServerEndpoint({
  host: instance.host,
  port: instance.port,
  protocol: instance.protocol,
  tokenFile: tokenFilePath,
  ...(webuiEnabled
    ? { webui: { enabled: true as const, autoLogin: webuiAutoLogin } }
    : {}),
})
console.log(`MORTISE_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
console.log(`MORTISE_SERVER_TOKEN_FILE=${tokenFilePath}`)
if (webuiHandler) {
  console.log(`MORTISE_WEBUI_URL=${serverProto}://0.0.0.0:${instance.port}`)
}

const shutdown = async () => {
  removeServerEndpoint()
  webuiHandler?.dispose()
  healthServer?.stop()
  if (messagingHandle) {
    try {
      await messagingHandle.dispose()
    } catch (error) {
      console.error('[messaging] dispose failed:', error)
    }
  }
  await instance.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
