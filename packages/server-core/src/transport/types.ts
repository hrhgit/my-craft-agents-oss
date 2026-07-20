/**
 * Transport-layer interfaces for the WS-based RPC.
 */

import type { PushTarget } from '@mortise/shared/protocol'

export interface RequestContext {
  clientId: string
  workspaceId: string | null
  webContentsId: number | null
  signal?: AbortSignal
}

export type HandlerFn = (ctx: RequestContext, ...args: any[]) => Promise<any> | any

export interface HandlerOptions {
  /** Override the default server-side handler budget for long-lived transactions. */
  timeoutMs?: number
}

export type WorkspaceAuthMethod = 'token' | 'cookie' | 'none'
export type WorkspaceAuthorizationPhase = 'handshake' | 'reconnect' | 'switch'

export interface WorkspaceAuthorizationRequest {
  workspaceId: string | null
  webContentsId: number | null
  clientId?: string
  token?: string
  authMethod: WorkspaceAuthMethod
  phase: WorkspaceAuthorizationPhase
}

export interface RpcServer {
  handle(channel: string, handler: HandlerFn, options?: HandlerOptions): void
  push(channel: string, target: PushTarget, ...args: any[]): void
  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any>
  updateClientWorkspace?(clientId: string, workspaceId: string): Promise<void> | void

  /** Whether a connected client advertised the given capability on handshake. */
  hasClientCapability(clientId: string, capability: string): boolean

  /** Connected clients (optionally narrowed by workspaceId) that advertised the capability. */
  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[]
}

export interface RpcClient {
  invoke(channel: string, ...args: any[]): Promise<any>
  invokeWithOptions?(channel: string, args: any[], options?: { timeoutMs?: number }): Promise<any>
  on(channel: string, callback: (...args: any[]) => void): () => void
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void
}

export type EventSink = (channel: string, target: PushTarget, ...args: any[]) => void
