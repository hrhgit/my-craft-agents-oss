import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { protocol } from 'electron'
import { getPiExtensionCatalog } from '@mortise/shared/config/pi-global-config'
import { parseExtensionProtocolUrl } from './extension-protocol-url'

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'mortise-extension',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }])
}

export function registerExtensionHandler(): void {
  protocol.handle('mortise-extension', async (request) => {
    try {
      const target = parseExtensionProtocolUrl(request.url)
      if (!target) return new Response(null, { status: 404 })
      const { resourceType, extensionId, itemId, kind, index } = target
      const catalog = await getPiExtensionCatalog()
      const extension = catalog.extensions.find((candidate) => candidate.id === extensionId)
      const frontend = resourceType === 'frontend' && extension?.ui?.schemaVersion === 2
        ? (extension.ui.frontends ?? []).find((candidate) => candidate.id === itemId)
        : undefined
      const module = resourceType === 'module' && extension?.ui?.schemaVersion === 2
        ? (extension.ui.modules ?? []).find((candidate) => candidate.id === itemId)
        : undefined
      const override = resourceType === 'override' && extension?.ui?.schemaVersion === 2
        ? (extension.ui.overrides ?? []).find((candidate) => candidate.id === itemId)
        : undefined
      if (!extension || (!frontend && !module && !override)) return new Response(null, { status: 404 })
      const resource = kind === 'entry'
        ? (frontend?.entry ?? module?.entry ?? override?.entry)
        : kind === 'style' && index !== undefined
          ? (frontend?.styles?.[Number(index)] ?? module?.styles?.[Number(index)] ?? override?.styles?.[Number(index)])
          : undefined
      if (!resource?.startsWith('./')) return new Response(null, { status: 404 })
      const root = dirname(extension.resolvedPath)
      const filePath = resolve(root, resource)
      const rootRelative = relative(root, filePath)
      if (rootRelative.startsWith('..') || rootRelative.includes('..\\') || rootRelative.includes('../')) return new Response(null, { status: 404 })
      const fileStat = await stat(filePath)
      const resourceExtension = extname(filePath).toLowerCase()
      if ((kind === 'entry' && resourceExtension !== '.js' && resourceExtension !== '.mjs') || (kind === 'style' && resourceExtension !== '.css')) {
        return new Response(null, { status: 415 })
      }
      const realRelative = relative(await realpath(root), await realpath(filePath))
      if (!fileStat.isFile() || realRelative.startsWith('..') || realRelative.includes('..\\') || realRelative.includes('../')) return new Response(null, { status: 404 })
      const data = await readFile(filePath)
      return new Response(data, { headers: {
        'Content-Type': MIME_TYPES[resourceExtension] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
