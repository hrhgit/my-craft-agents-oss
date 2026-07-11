import type { CapabilityProvider } from '../types.ts'

export interface FilePickInput {
  title?: string
  mode?: 'file' | 'directory'
  multiple?: boolean
  extensions?: string[]
}

export interface FilePickResult {
  cancelled: boolean
  paths: string[]
}

export type PickFiles = (input: FilePickInput) => Promise<FilePickResult>

function parseInput(input: unknown): FilePickInput {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('File picker input must be an object')
  const value = input as Record<string, unknown>
  if (value.title !== undefined && typeof value.title !== 'string') throw new Error('title must be a string')
  if (value.mode !== undefined && value.mode !== 'file' && value.mode !== 'directory') throw new Error('mode must be file or directory')
  if (value.multiple !== undefined && typeof value.multiple !== 'boolean') throw new Error('multiple must be a boolean')
  if (value.extensions !== undefined && (!Array.isArray(value.extensions) || value.extensions.some(item => typeof item !== 'string'))) {
    throw new Error('extensions must be an array of strings')
  }
  return value as FilePickInput
}

export function createFilesProvider(pickFiles: PickFiles): CapabilityProvider {
  return {
    capability: 'files.pick',
    async invoke(operation, input) {
      if (operation !== 'open') throw new Error(`Unsupported files.pick operation: ${operation}`)
      return pickFiles(parseInput(input))
    },
  }
}

export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

export interface FilePreviewInput { path: string; maxBytes: number }
export interface FilePreviewResult { mimeType: string; size: number; dataUrl: string }
export type ReadFilePreview = (
  input: FilePreviewInput,
  route: { sessionId: string },
) => Promise<FilePreviewResult>

function parsePreviewInput(input: unknown): FilePreviewInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('File preview input must be an object')
  const value = input as Record<string, unknown>
  if (typeof value.path !== 'string' || !value.path.trim()) throw new Error('path must be a non-empty string')
  if (value.maxBytes !== undefined && (!Number.isInteger(value.maxBytes) || (value.maxBytes as number) <= 0)) {
    throw new Error('maxBytes must be a positive integer')
  }
  return { path: value.path, maxBytes: Math.min((value.maxBytes as number | undefined) ?? FILE_PREVIEW_MAX_BYTES, FILE_PREVIEW_MAX_BYTES) }
}

export function createFilePreviewProvider(readPreview: ReadFilePreview): CapabilityProvider {
  return {
    capability: 'files.preview',
    async invoke(operation, input, context) {
      if (operation !== 'read') throw new Error(`Unsupported files.preview operation: ${operation}`)
      return readPreview(parsePreviewInput(input), { sessionId: context.request.sessionId })
    },
  }
}
