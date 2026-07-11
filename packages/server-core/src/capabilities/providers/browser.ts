import type { CapabilityProvider } from '../types.ts'
import { executeBrowserToolCommand, type BrowserPaneFns } from '@craft-agent/shared/agent'

export interface BrowserOpenInput { url: string; focus?: boolean }
export interface BrowserOpenResult { instanceId: string; url: string; title: string }
export type OpenBrowser = (input: BrowserOpenInput, route: { sessionId: string; workspaceId?: string }) => Promise<BrowserOpenResult>

function parseInput(input: unknown): BrowserOpenInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Browser input must be an object')
  const value = input as Record<string, unknown>
  if (typeof value.url !== 'string' || !value.url.trim()) throw new Error('url must be a non-empty string')
  let parsed: URL
  try { parsed = new URL(value.url) } catch { throw new Error('url must be absolute') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must use http or https')
  if (value.focus !== undefined && typeof value.focus !== 'boolean') throw new Error('focus must be a boolean')
  return { url: parsed.toString(), focus: value.focus as boolean | undefined }
}

export function createBrowserProvider(openBrowser: OpenBrowser): CapabilityProvider {
  return {
    capability: 'browser.open',
    async invoke(operation, input, context) {
      if (operation !== 'navigate') throw new Error(`Unsupported browser.open operation: ${operation}`)
      return openBrowser(parseInput(input), {
        sessionId: context.request.sessionId,
      })
    },
  }
}

export type BrowserControlOperation = 'back' | 'forward' | 'focus' | 'hide' | 'close'
export interface BrowserControlInput { instanceId: string }
export type ControlBrowser = (
  operation: BrowserControlOperation,
  input: BrowserControlInput,
  route: { sessionId: string },
) => Promise<void> | void

function parseControlInput(input: unknown): BrowserControlInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Browser control input must be an object')
  const instanceId = (input as Record<string, unknown>).instanceId
  if (typeof instanceId !== 'string' || !instanceId.trim()) throw new Error('instanceId must be a non-empty string')
  return { instanceId }
}

const CONTROL_OPERATIONS = new Set<BrowserControlOperation>(['back', 'forward', 'focus', 'hide', 'close'])

export function createBrowserControlProvider(controlBrowser: ControlBrowser): CapabilityProvider {
  return {
    capability: 'browser.control',
    async invoke(operation, input, context) {
      if (!CONTROL_OPERATIONS.has(operation as BrowserControlOperation)) {
        throw new Error(`Unsupported browser.control operation: ${operation}`)
      }
      await controlBrowser(operation as BrowserControlOperation, parseControlInput(input), {
        sessionId: context.request.sessionId,
      })
      return { completed: true }
    },
  }
}

export interface BrowserCommandInput { command: string | string[] }
export interface BrowserCommandOutput {
  text: string
  artifactRefs?: Array<{ type: 'image'; path: string; mimeType: 'image/png' | 'image/jpeg'; sizeBytes: number }>
}

export type ResolveBrowserCommandAdapter = (
  route: { sessionId: string },
) => BrowserPaneFns | undefined | Promise<BrowserPaneFns | undefined>

export type PersistBrowserCommandImage = (
  image: { data: string; mimeType: 'image/png' | 'image/jpeg'; sizeBytes: number },
  route: { sessionId: string },
) => Promise<{ path: string }>

function parseCommandInput(input: unknown): BrowserCommandInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Browser command input must be an object')
  const value = input as Record<string, unknown>
  const command = value.command
  if (Object.keys(value).some(key => key !== 'command')) throw new Error('Unexpected browser command input field')
  if (typeof command === 'string') {
    if (!command.trim() || command.length > 100_000) throw new Error('command must be non-empty and at most 100000 characters')
    return { command }
  }
  if (!Array.isArray(command) || command.length === 0 || command.length > 1_000 || command.some(part => typeof part !== 'string' || part.length > 100_000)) {
    throw new Error('command must be a non-empty string or bounded string array')
  }
  return { command: command as string[] }
}

/** Executes the established browser_tool command language without exposing Host APIs. */
export function createBrowserCommandProvider(
  resolveAdapter: ResolveBrowserCommandAdapter,
  persistImage?: PersistBrowserCommandImage,
): CapabilityProvider {
  return {
    capability: 'browser.command',
    async invoke(operation, input, context): Promise<BrowserCommandOutput> {
      if (operation !== 'execute') throw new Error(`Unsupported browser.command operation: ${operation}`)
      if (context.signal.aborted) throw context.signal.reason
      const parsed = parseCommandInput(input)
      const fns = await resolveAdapter({ sessionId: context.request.sessionId })
      if (!fns) throw new Error('Browser window controls are not available. This capability requires the desktop app.')
      const result = await executeBrowserToolCommand({
        command: parsed.command,
        fns,
        sessionId: context.request.sessionId,
      })
      if (context.signal.aborted) throw context.signal.reason
      const output: BrowserCommandOutput = { text: result.output }
      if (result.image) {
        if (!persistImage) throw new Error('Browser image artifact storage is unavailable')
        const artifact = await persistImage(result.image, { sessionId: context.request.sessionId })
        output.artifactRefs = [{
          type: 'image',
          path: artifact.path,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
        }]
      }
      return output
    },
  }
}
