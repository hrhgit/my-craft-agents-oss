import {
  UI_VALIDATION_PROTOCOL_VERSION,
  type UiValidationRequestEnvelope,
  type UiValidationResponseEnvelope,
} from '@craft-agent/shared/ui-validation'
import type { CraftUiFixtureSummary } from './fixture.ts'

export const CRAFT_UI_PROTOCOL_VERSION = UI_VALIDATION_PROTOCOL_VERSION

export type CraftUiSurface = 'electron' | 'webui'
export type CraftUiProfileMode = 'fixture' | 'isolated' | 'clone'
export type CraftUiWindowMode = 'foreground' | 'background'

export type CraftUiStartupPhase =
  | 'profile'
  | 'spawn'
  | 'endpoint'
  | 'app-readiness'
  | 'semantic-readiness'
  | 'initial-scenario'

export interface CraftUiFailureDiagnostics {
  phase: CraftUiStartupPhase
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

export interface CraftUiEndpointManifest {
  protocolVersion: typeof CRAFT_UI_PROTOCOL_VERSION
  runId: string
  surface: CraftUiSurface
  transport: 'http'
  url: string
  pid: number
  readyAt: string
}

export interface CraftUiRunManifest {
  protocolVersion: typeof CRAFT_UI_PROTOCOL_VERSION
  runId: string
  surface: CraftUiSurface
  status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
  createdAt: string
  updatedAt: string
  controllerPid: number
  launcherPid?: number
  hostPid?: number
  profileMode: CraftUiProfileMode
  windowMode: CraftUiWindowMode
  containsClonedUserData: boolean
  runDir: string
  profileDir: string
  artifactsDir: string
  endpointManifestPath: string
  tokenPath: string
  stdoutPath: string
  stderrPath: string
  adapterCommand: string[]
  error?: string
  lastResponseSeq?: number
  lastRevision?: number
  verificationLevel?: import('@craft-agent/shared/ui-validation').UiValidationVerificationLevel
  profileCleanedAt?: string
  cleanupError?: string
  failure?: CraftUiFailureDiagnostics
  initialScenario?: { name: string; seed?: number }
  fixture?: CraftUiFixtureSummary
}

export type CraftUiRequest = UiValidationRequestEnvelope
export type CraftUiResponse<T = unknown> = UiValidationResponseEnvelope<T>

export interface CraftUiArtifact {
  id: string
  kind: 'screenshot' | 'trace' | 'log' | 'snapshot' | 'other'
  path: string
  createdAt: string
  mimeType?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface CraftUiArtifactManifest {
  protocolVersion: typeof CRAFT_UI_PROTOCOL_VERSION
  runId: string
  updatedAt: string
  artifacts: CraftUiArtifact[]
}

export interface CraftUiHostAdapterEnvironment {
  CRAFT_UI_RUN_ID: string
  CRAFT_UI_SURFACE: CraftUiSurface
  CRAFT_UI_RUN_DIR: string
  CRAFT_UI_PROFILE_DIR: string
  CRAFT_UI_ARTIFACTS_DIR: string
  CRAFT_UI_ENDPOINT_MANIFEST: string
  CRAFT_UI_TOKEN: string
  CRAFT_UI_PROTOCOL_VERSION: string
  CRAFT_UI_ELECTRON_USER_DATA_DIR: string
  CRAFT_UI_WINDOW_MODE: CraftUiWindowMode
}

export interface CraftUiSurfaceDriver {
  ready(params?: Record<string, unknown>): Promise<CraftUiResponse>
  windows(params?: Record<string, unknown>): Promise<CraftUiResponse>
  snapshot(params?: Record<string, unknown>): Promise<CraftUiResponse>
  action(params: Record<string, unknown>): Promise<CraftUiResponse>
  wait(params: Record<string, unknown>): Promise<CraftUiResponse>
  screenshot(params?: Record<string, unknown>): Promise<CraftUiResponse>
  logs(params?: Record<string, unknown>): Promise<CraftUiResponse>
  resize(params: Record<string, unknown>): Promise<CraftUiResponse>
  dispose(): Promise<CraftUiResponse>
}
