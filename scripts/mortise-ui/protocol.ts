import {
  UI_VALIDATION_PROTOCOL_VERSION,
  type UiValidationRequestEnvelope,
  type UiValidationResponseEnvelope,
} from '@mortise/shared/ui-validation'
import type { MortiseUiFixtureSummary } from './fixture.ts'

export const MORTISE_UI_PROTOCOL_VERSION = UI_VALIDATION_PROTOCOL_VERSION

export type MortiseUiSurface = 'electron' | 'webui'
export type MortiseUiProfileMode = 'fixture' | 'isolated' | 'clone'
export type MortiseUiWindowMode = 'foreground' | 'background'

export interface MortiseUiHistoryEntry {
  at: string
  command: string
  outcome: 'succeeded' | 'failed'
  seq?: number
  revision?: number
  errorCode?: string
  summary?: string
}

export interface MortiseUiMountedExtensionEntry {
  id: string
  path: string
  version: string
  targets: string[]
  overrodeExisting: boolean
}

export interface MortiseUiMountedExtension {
  packageRoot: string
  packageName?: string
  entries: MortiseUiMountedExtensionEntry[]
}

export type MortiseUiStartupPhase =
  | 'profile'
  | 'build'
  | 'spawn'
  | 'endpoint'
  | 'app-readiness'
  | 'semantic-readiness'
  | 'initial-scenario'

export interface MortiseUiFailureDiagnostics {
  phase: MortiseUiStartupPhase
  message: string
  stderrTail: string
  paths: {
    runManifest: string
    stdout: string
    stderr: string
    artifacts: string
  }
  cleanup: {
    attempted: boolean
    remainingPids: number[]
    profileRemoved: boolean
    error?: string
  }
}

export interface MortiseUiEndpointManifest {
  protocolVersion: typeof MORTISE_UI_PROTOCOL_VERSION
  runId: string
  surface: MortiseUiSurface
  transport: 'http'
  url: string
  pid: number
  readyAt: string
  buildId?: string
}

export interface MortiseUiRunManifest {
  protocolVersion: typeof MORTISE_UI_PROTOCOL_VERSION
  runId: string
  label?: string
  surface: MortiseUiSurface
  status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
  createdAt: string
  updatedAt: string
  controllerPid: number
  launcherPid?: number
  launcherStartedAt?: number
  hostPid?: number
  hostStartedAt?: number
  profileMode: MortiseUiProfileMode
  windowMode: MortiseUiWindowMode
  containsClonedUserData: boolean
  runDir: string
  profileDir: string
  artifactsDir: string
  endpointManifestPath: string
  tokenPath: string
  stdoutPath: string
  stderrPath: string
  adapterCommand: string[]
  buildId?: string
  buildDir?: string
  buildError?: string
  error?: string
  lastResponseSeq?: number
  lastRevision?: number
  verificationLevel?: import('@mortise/shared/ui-validation').UiValidationVerificationLevel
  profileCleanedAt?: string
  cleanupError?: string
  failure?: MortiseUiFailureDiagnostics
  initialScenario?: { name: string; seed?: number }
  fixture?: MortiseUiFixtureSummary
  mountedExtensions?: MortiseUiMountedExtension[]
  history?: MortiseUiHistoryEntry[]
}

export type MortiseUiRequest = UiValidationRequestEnvelope
export type MortiseUiResponse<T = unknown> = UiValidationResponseEnvelope<T>

export interface MortiseUiArtifact {
  id: string
  kind: 'screenshot' | 'trace' | 'log' | 'snapshot' | 'other'
  path: string
  createdAt: string
  mimeType?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface MortiseUiArtifactManifest {
  protocolVersion: typeof MORTISE_UI_PROTOCOL_VERSION
  runId: string
  updatedAt: string
  artifacts: MortiseUiArtifact[]
}

export interface MortiseUiHostAdapterEnvironment {
  MORTISE_UI_RUN_ID: string
  MORTISE_UI_SURFACE: MortiseUiSurface
  MORTISE_UI_RUN_DIR: string
  MORTISE_UI_PROFILE_DIR: string
  MORTISE_UI_ARTIFACTS_DIR: string
  MORTISE_UI_ENDPOINT_MANIFEST: string
  MORTISE_UI_TOKEN: string
  MORTISE_UI_PROTOCOL_VERSION: string
  MORTISE_UI_ELECTRON_USER_DATA_DIR: string
  MORTISE_UI_WINDOW_MODE: MortiseUiWindowMode
  MORTISE_UI_BUILD_ID?: string
  MORTISE_UI_BUILD_DIR?: string
}

export interface MortiseUiSurfaceDriver {
  ready(params?: Record<string, unknown>): Promise<MortiseUiResponse>
  windows(params?: Record<string, unknown>): Promise<MortiseUiResponse>
  snapshot(params?: Record<string, unknown>): Promise<MortiseUiResponse>
  action(params: Record<string, unknown>): Promise<MortiseUiResponse>
  wait(params: Record<string, unknown>): Promise<MortiseUiResponse>
  screenshot(params?: Record<string, unknown>): Promise<MortiseUiResponse>
  logs(params?: Record<string, unknown>): Promise<MortiseUiResponse>
  resize(params: Record<string, unknown>): Promise<MortiseUiResponse>
  dispose(): Promise<MortiseUiResponse>
}
