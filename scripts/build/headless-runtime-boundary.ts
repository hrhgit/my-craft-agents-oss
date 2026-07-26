import { readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

interface HeadlessImport {
  path?: string
  kind?: string
  external?: boolean
}

export interface HeadlessMetafile {
  inputs?: Record<string, { imports?: HeadlessImport[] }>
  outputs?: Record<string, { entryPoint?: string }>
}

const forbiddenSourcePatterns = [
  /(?:^|\/)packages\/tui(?:\/|$)/,
  /(?:^|\/)packages\/web-launcher(?:\/|$)/,
  /\/coding-agent\/src\/modes\/(?:interactive|print-mode)(?:[./]|$)/,
  /\/coding-agent\/src\/cli(?:[./-]|$)/,
  /\/coding-agent\/src\/main\.(?:ts|js)$/,
  /\/coding-agent\/src\/(?:migrations|package-manager-cli)\.(?:ts|js)$/,
  /\/coding-agent\/src\/core\/(?:export-html|package-manager|package-update-checker)(?:[./]|$)/,
  /\/coding-agent\/src\/core\/(?:footer-data-provider|keybindings|tools\/render-utils)\.(?:ts|js)$/,
  /\/coding-agent\/src\/utils\/(?:changelog|clipboard(?:-image|-native)?|version-check|windows-self-update)\.(?:ts|js)$/,
] as const

const forbiddenSpecifiers = new Set([
  '@mortise/pi-tui',
  '@mariozechner/pi-tui',
  '@mortise/pi-web-launcher',
])

function normalized(value: string): string {
  return value.replaceAll('\\', '/')
}

function entryPoints(metafile: HeadlessMetafile, inputs: Map<string, string>): string[] {
  const entries = Object.values(metafile.outputs ?? {})
    .map(output => output.entryPoint ? normalized(output.entryPoint) : undefined)
    .filter((entry): entry is string => entry !== undefined && inputs.has(entry))
  if (entries.length > 0) return [...new Set(entries)].sort()
  return [...inputs.keys()].filter(input => /\/coding-agent\/src\/bun\/headless\.(?:ts|js)$/.test(`/${input}`)).sort()
}

function violationForSource(path: string): string | undefined {
  return forbiddenSourcePatterns.some(pattern => pattern.test(`/${path}`))
    ? `retired source module ${path}`
    : undefined
}

export function headlessMetafileViolations(metafile: HeadlessMetafile): string[] {
  const rawInputs = metafile.inputs ?? {}
  const inputs = new Map(Object.keys(rawInputs).map(path => [normalized(path), path]))
  const queue = entryPoints(metafile, inputs)
  const parents = new Map<string, string | null>(queue.map(entry => [entry, null]))
  const violations: string[] = []

  const dependencyPath = (leaf: string): string[] => {
    const path: string[] = []
    let current: string | null | undefined = leaf
    while (current) {
      path.push(current)
      current = parents.get(current)
    }
    return path.reverse()
  }

  for (let index = 0; index < queue.length; index++) {
    const input = queue[index]!
    const forbiddenSource = violationForSource(input)
    if (forbiddenSource) {
      violations.push(`${forbiddenSource}\n  dependency path: ${dependencyPath(input).join(' -> ')}`)
    }

    for (const imported of rawInputs[inputs.get(input)!]?.imports ?? []) {
      if (!imported.path) continue
      const importedPath = normalized(imported.path)
      if (imported.external || !inputs.has(importedPath)) {
        if (forbiddenSpecifiers.has(importedPath)) {
          violations.push(
            `retired external module ${importedPath}\n  dependency path: ${[...dependencyPath(input), importedPath].join(' -> ')}`,
          )
        }
        continue
      }
      if (!parents.has(importedPath)) {
        parents.set(importedPath, input)
        queue.push(importedPath)
      }
    }
  }
  return [...new Set(violations)].sort()
}

export function assertHeadlessMetafile(metafile: HeadlessMetafile): void {
  const violations = headlessMetafileViolations(metafile)
  if (violations.length > 0) {
    throw new Error(`Headless runtime source closure contains retired product surfaces:\n${violations.join('\n')}`)
  }
}

function filesUnder(root: string, directory = root): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = resolve(directory, name)
    return statSync(path).isDirectory() ? filesUnder(root, path) : [normalized(relative(root, path))]
  })
}

export function assertHeadlessStagedRuntime(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const executable = platform === 'win32' ? 'pi.exe' : 'pi'
  const sidecarPlatform = platform === 'win32' ? 'windows' : platform
  const sidecar = platform === 'win32' ? 'pi-network-sidecar.exe' : 'pi-network-sidecar'
  const expected = [
    executable,
    'package.json',
    'photon_rs_bg.wasm',
    `sidecar/bin/${sidecarPlatform}-${arch}/${sidecar}`,
  ].sort()
  const observed = filesUnder(resolve(root)).sort()
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`Headless runtime staging mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`)
  }
  return observed
}
