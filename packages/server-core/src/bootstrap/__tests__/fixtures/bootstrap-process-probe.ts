import { existsSync, writeFileSync } from 'node:fs'
import type { PlatformServices } from '../../../runtime/platform'
import { WsRpcServer } from '../../../transport/server'
import { bootstrapServer } from '../../headless-start'

type ProbePhase =
  | 'lock-acquired'
  | 'handlers-registered'
  | 'session-initializing'
  | 'runtime-initializing'
  | 'model-refresh-starting'
  | 'listener-binding'
  | 'ready'

const targetPhase = process.env.MORTISE_BOOTSTRAP_PROBE_PHASE as ProbePhase
const markerFile = process.env.MORTISE_BOOTSTRAP_PROBE_MARKER
const stopFile = process.env.MORTISE_BOOTSTRAP_PROBE_STOP
const lockFile = process.env.MORTISE_BOOTSTRAP_PROBE_LOCK
const port = Number(process.env.MORTISE_BOOTSTRAP_PROBE_PORT)

if (!targetPhase || !markerFile || !stopFile || !lockFile || !Number.isInteger(port)) {
  throw new Error('Bootstrap process probe environment is incomplete')
}

function mark(phase: ProbePhase): void {
  writeFileSync(markerFile!, JSON.stringify({ phase, pid: process.pid, timestamp: Date.now() }), 'utf8')
}

function pauseSync(phase: ProbePhase): void {
  if (targetPhase !== phase) return
  mark(phase)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

async function pauseAsync(phase: ProbePhase): Promise<void> {
  if (targetPhase !== phase) return
  mark(phase)
  await new Promise<never>(() => {})
}

function createPlatform(): PlatformServices {
  return {
    appRootPath: process.cwd(),
    resourcesPath: process.cwd(),
    isPackaged: false,
    appVersion: 'bootstrap-process-probe',
    imageProcessor: {
      getMetadata: async () => null,
      process: async input => Buffer.isBuffer(input) ? input : Buffer.from(input),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    isDebugMode: true,
  }
}

if (targetPhase === 'listener-binding') {
  WsRpcServer.prototype.listen = async function probeListenerBinding(): Promise<void> {
    mark('listener-binding')
    await new Promise<never>(() => {})
  }
}

const sessionManager = { identity: 'bootstrap-process-probe' }
const instance = await bootstrapServer({
  serverToken: 'bootstrap-process-probe-token-0123456789',
  rpcHost: '127.0.0.1',
  rpcPort: port,
  serverLockName: lockFile,
  platformFactory: createPlatform,
  initModelRefreshService: () => {
    pauseSync('lock-acquired')
    return {
      startAll: () => pauseSync('model-refresh-starting'),
      stopAll: () => {},
    }
  },
  createSessionManager: () => sessionManager,
  createHandlerDeps: () => ({}),
  registerAllRpcHandlers: () => pauseSync('handlers-registered'),
  setSessionEventSink: () => {},
  initializeSessionManager: () => pauseAsync('session-initializing'),
  initializeRuntime: () => pauseAsync('runtime-initializing'),
  cleanupRuntime: () => {},
  cleanupSessionManager: () => {},
})

mark('ready')
while (!existsSync(stopFile)) await Bun.sleep(20)

// There are no clients in the probe. Bypass the notification grace period so
// the integration matrix exercises teardown without adding two seconds/case.
instance.wsServer.push = (() => { throw new Error('probe has no clients') }) as typeof instance.wsServer.push
await instance.stop()

