import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertValidExtensionManifest,
  isExtensionManifestId,
  type ExtensionManifestHost,
  type ExtensionManifestV1,
} from '../../pi/packages/coding-agent/src/core/extension-manifest.ts'
import type { MortiseUiMountedExtension } from './protocol.ts'

const EXTENSION_ENTRY_KEYS = ['id', 'path', 'activation', 'targets', 'manifest', 'ui'] as const
const EXTENSION_ACTIVATIONS = ['startup', 'beforeFirstRequest', 'lazy'] as const

interface ExtensionEntry {
  id: string
  path: string
  activation?: unknown
  targets: ExtensionManifestHost[]
  manifest: ExtensionManifestV1
  ui?: unknown
}

interface LoadedExtensionPackage {
  packageRoot: string
  packageName?: string
  entries: ExtensionEntry[]
}

export function mountMortiseUiExtensions(piAgentDir: string, sourcePaths: string[]): MortiseUiMountedExtension[] {
  const packages = sourcePaths.map(loadExtensionPackage)
  const mountedIds = new Set<string>()
  for (const pkg of packages) {
    for (const entry of pkg.entries) {
      if (mountedIds.has(entry.id)) throw new Error(`Mounted extension id is duplicated: ${entry.id}`)
      mountedIds.add(entry.id)
    }
  }

  if (packages.length === 0) return []
  const settingsPath = join(piAgentDir, 'settings.json')
  const settings = readSettings(settingsPath)
  const existing = settings.extensions
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error('Cannot mount extensions because the isolated Pi settings extensions field is not an array')
  }
  const existingEntries = Array.isArray(existing) ? existing : []
  const existingIds = new Set(existingEntries.flatMap(entry => {
    const id = extensionEntryId(entry)
    return id ? [id] : []
  }))
  const retainedEntries = existingEntries.filter(entry => {
    const id = extensionEntryId(entry)
    return !id || !mountedIds.has(id)
  })

  const mounted: MortiseUiMountedExtension[] = packages.map(pkg => ({
    packageRoot: pkg.packageRoot,
    ...(pkg.packageName ? { packageName: pkg.packageName } : {}),
    entries: pkg.entries.map(entry => ({
      id: entry.id,
      path: entry.path,
      version: String(entry.manifest.version),
      targets: [...entry.targets],
      overrodeExisting: existingIds.has(entry.id),
    })),
  }))
  settings.extensions = [
    ...retainedEntries,
    ...packages.flatMap(pkg => pkg.entries.map(entry => ({
      id: entry.id,
      path: entry.path,
      ...(entry.activation === undefined ? {} : { activation: entry.activation }),
      targets: entry.targets,
      manifest: entry.manifest,
      ...(entry.ui === undefined ? {} : { ui: entry.ui }),
    }))),
  ]
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return mounted
}

function loadExtensionPackage(inputPath: string): LoadedExtensionPackage {
  if (!inputPath.trim()) throw new Error('--extension requires a non-empty directory path')
  const requestedRoot = resolve(inputPath)
  if (!existsSync(requestedRoot)) throw new Error(`Extension directory does not exist: ${requestedRoot}`)
  if (!statSync(requestedRoot).isDirectory()) throw new Error(`Extension path is not a directory: ${requestedRoot}`)
  const packageRoot = realpathSync(requestedRoot)
  const packageJsonPath = join(packageRoot, 'package.json')
  if (!existsSync(packageJsonPath)) throw new Error(`Extension directory is missing package.json: ${packageRoot}`)

  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) }
  catch (error) { throw new Error(`Extension package.json is invalid JSON: ${packageJsonPath}`, { cause: error }) }
  if (!isRecord(parsed)) throw new Error(`Extension package.json must contain an object: ${packageJsonPath}`)
  const pi = parsed.pi
  if (!isRecord(pi) || !Array.isArray(pi.extensions) || pi.extensions.length === 0) {
    throw new Error(`Extension package must declare at least one pi.extensions entry: ${packageJsonPath}`)
  }

  const entries = pi.extensions.map((rawEntry, index) => parseEntry(rawEntry, packageRoot, `${packageJsonPath} pi.extensions[${index}]`))
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Extension package declares duplicate id ${entry.id}: ${packageJsonPath}`)
    ids.add(entry.id)
  }
  return {
    packageRoot,
    ...(typeof parsed.name === 'string' && parsed.name.trim() ? { packageName: parsed.name.trim() } : {}),
    entries,
  }
}

function parseEntry(value: unknown, packageRoot: string, context: string): ExtensionEntry {
  if (!isRecord(value)) throw new Error(`${context} must be an object`)
  const unknownKey = Object.keys(value).find(key => !EXTENSION_ENTRY_KEYS.includes(key as typeof EXTENSION_ENTRY_KEYS[number]))
  if (unknownKey) throw new Error(`${context} contains unknown field ${unknownKey}`)
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!isExtensionManifestId(id)) throw new Error(`${context}.id must be a lowercase stable identifier`)
  const entryPath = typeof value.path === 'string' ? value.path.trim() : ''
  if (!entryPath) throw new Error(`${context}.path must be a non-empty relative path`)
  if (isAbsolute(entryPath)) throw new Error(`${context}.path must stay relative to the extension directory`)
  const absoluteEntryPath = resolve(packageRoot, entryPath)
  const relativeEntryPath = relative(packageRoot, absoluteEntryPath)
  if (relativeEntryPath === '..' || relativeEntryPath.startsWith(`..${sep}`) || isAbsolute(relativeEntryPath)) {
    throw new Error(`${context}.path escapes the extension directory`)
  }
  if (!existsSync(absoluteEntryPath) || !statSync(absoluteEntryPath).isFile()) {
    throw new Error(`${context}.path does not resolve to a file: ${absoluteEntryPath}`)
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0 || !value.targets.every(target => target === 'pi' || target === 'mortise')) {
    throw new Error(`${context}.targets must contain only pi or mortise`)
  }
  const targets = [...new Set(value.targets as ExtensionManifestHost[])]
  if (!targets.includes('mortise')) throw new Error(`${context}.targets must include mortise`)
  if (value.activation !== undefined && !EXTENSION_ACTIVATIONS.includes(value.activation as typeof EXTENSION_ACTIVATIONS[number])) {
    throw new Error(`${context}.activation is invalid`)
  }
  assertValidExtensionManifest(value.manifest, id, targets, context)
  return {
    id,
    path: absoluteEntryPath,
    ...(value.activation === undefined ? {} : { activation: value.activation }),
    targets,
    manifest: value.manifest,
    ...(value.ui === undefined ? {} : { ui: value.ui }),
  }
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`Isolated Pi settings are invalid JSON: ${path}`, { cause: error }) }
  if (!isRecord(parsed)) throw new Error(`Isolated Pi settings must contain an object: ${path}`)
  return parsed
}

function extensionEntryId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' ? value.id.trim() || undefined : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
