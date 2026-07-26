import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import { load } from 'js-yaml'
import { configSchema, moduleFrontmatterSchema, moduleLockSchema, REQUIRED_HEADINGS } from './schema.ts'
import { repositoryDirtyFiles, repositoryFileBlobs, repositoryFileModes, repositoryFiles, scopeDigest } from './git.ts'
import type { ModuleDocumentV1, ModuleLockV1, ModuleSystemConfigV1, RepositoryValidationModeV1, ValidationDiagnosticV1, ValidationResultV1 } from './types.ts'

export interface ModuleRepository {
  root: string
  configPath: string
  lockPath: string
  lock: ModuleLockV1
  config: ModuleSystemConfigV1
  modules: ModuleDocumentV1[]
  files: string[]
  fileModes: Map<string, string>
  fileBlobs: Map<string, string>
  dirtyFiles: Set<string>
}

const globCache = new Map<string, Bun.Glob>()

export function matches(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    let glob = globCache.get(pattern)
    if (!glob) {
      glob = new Bun.Glob(pattern)
      globCache.set(pattern, glob)
    }
    return glob.match(path)
  })
}

export async function loadRepository(root = process.cwd()): Promise<ModuleRepository> {
  root = resolve(root)
  const configPath = join(root, '.agents', 'module-system.yaml')
  const config = configSchema.parse(load(await readFile(configPath, 'utf8')))
  const inside = (configuredPath: string, field: string): string => {
    const absolute = resolve(root, configuredPath)
    const relativePath = relative(root, absolute)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`${field} must stay inside the repository: ${configuredPath}`)
    return absolute
  }
  const modulesDir = inside(config.modules_dir, 'modules_dir')
  const lockPath = inside(config.lock_file, 'lock_file')
  inside(config.state_dir, 'state_dir')
  const names = (await readdir(modulesDir)).filter(name => name.endsWith('.md')).sort()
  const modules: ModuleDocumentV1[] = []
  for (const name of names) {
    const path = join(modulesDir, name)
    const parsed = matter(await readFile(path, 'utf8'))
    const data = moduleFrontmatterSchema.parse(parsed.data)
    modules.push({ ...data, scope_digest: '', body: parsed.content, path })
  }
  const lock = moduleLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')))
  for (const module of modules) module.scope_digest = lock.digests[module.id] ?? ''
  const [allFiles, fileModes, fileBlobs, dirtyFiles] = await Promise.all([
    repositoryFiles(root),
    repositoryFileModes(root),
    repositoryFileBlobs(root),
    repositoryDirtyFiles(root),
  ])
  const files = allFiles.filter(path => matches(path, config.include) && !matches(path, config.exclude))
  return { root, configPath, lockPath, lock, config, modules, files, fileModes, fileBlobs, dirtyFiles }
}

function diagnostic(severity: 'error' | 'warning', code: string, message: string, module?: string, path?: string): ValidationDiagnosticV1 {
  return { schema: 'module-agent/diagnostic/v1', severity, code, message, module, path }
}

export function ownedFiles(repo: ModuleRepository, module: ModuleDocumentV1): string[] {
  return repo.files.filter(path => matches(path, module.owns))
}

function digestFiles(repo: ModuleRepository, module: ModuleDocumentV1): string[] {
  // Module documents are validated structurally, while the generated lock is
  // excluded to avoid making its own recorded digest self-referential.
  const lockFile = relative(repo.root, repo.lockPath).replaceAll('\\', '/')
  return ownedFiles(repo, module).filter(path => !/^\.agents\/modules\/[^/]+\.md$/.test(path) && path !== lockFile)
}

export async function validateRepository(repo: ModuleRepository, mode: RepositoryValidationModeV1 = 'strict'): Promise<ValidationResultV1> {
  const includeStructure = mode !== 'freshness'
  const includeFreshness = mode !== 'structure'
  const diagnostics: ValidationDiagnosticV1[] = []
  const byId = new Map<string, ModuleDocumentV1>()
  if (includeStructure) for (const module of repo.modules) {
    if (byId.has(module.id)) diagnostics.push(diagnostic('error', 'DUPLICATE_MODULE_ID', `Module id ${module.id} is declared more than once.`, module.id, module.path))
    byId.set(module.id, module)
    const headings = [...module.body.matchAll(/^##\s+(.+?)\s*$/gm)].map(match => match[1])
    for (let index = 0; index < REQUIRED_HEADINGS.length; index += 1) {
      const heading = REQUIRED_HEADINGS[index]
      if (!headings.includes(heading)) diagnostics.push(diagnostic('error', 'MISSING_SECTION', `Missing required section: ${heading}.`, module.id, module.path))
      else if (headings[index] !== heading) diagnostics.push(diagnostic('error', 'SECTION_ORDER', `Required section ${heading} is out of order.`, module.id, module.path))
    }
    const history = module.body.match(/(?:^|\n)## Semantic history\s*\n([\s\S]*)$/)?.[1] ?? ''
    const entries = history.match(/^\s*[-*]\s+\S.*$/gm) ?? []
    if (entries.length > repo.config.history_limit) diagnostics.push(diagnostic('error', 'HISTORY_LIMIT', `Semantic history has ${entries.length} entries; maximum is ${repo.config.history_limit}.`, module.id, module.path))
  }
  if (includeStructure) {
    for (const module of repo.modules) {
      if (!(module.id in repo.lock.digests)) diagnostics.push(diagnostic('error', 'MISSING_LOCK_ENTRY', 'Module has no generated digest entry.', module.id, repo.lockPath))
    }
    for (const id of Object.keys(repo.lock.digests)) {
      if (!byId.has(id)) diagnostics.push(diagnostic('error', 'UNKNOWN_LOCK_ENTRY', `Digest entry does not identify a module: ${id}.`, id, repo.lockPath))
    }
  }

  if (includeStructure) for (const module of repo.modules) {
    const expectedFileName = `${module.id}.md`
    if (!module.path.replaceAll('\\', '/').endsWith(`/${expectedFileName}`)) diagnostics.push(diagnostic('error', 'MODULE_FILENAME', `Module document must be named ${expectedFileName}.`, module.id, module.path))
    for (const field of ['keywords', 'owns', 'related', 'depends_on', 'collaborates_with'] as const) {
      const values = module[field]
      if (new Set(values).size !== values.length) diagnostics.push(diagnostic('error', 'DUPLICATE_VALUE', `${field} contains duplicate values.`, module.id, module.path))
    }
    const validationIds = module.validation.map(entry => entry.id)
    if (new Set(validationIds).size !== validationIds.length) diagnostics.push(diagnostic('error', 'DUPLICATE_VALIDATION_ID', 'validation contains duplicate ids.', module.id, module.path))
    for (const pattern of module.owns) {
      if (!repo.files.some(file => matches(file, [pattern]))) {
        diagnostics.push(diagnostic('error', 'EMPTY_OWNERSHIP_PATTERN', `Ownership pattern matches no managed files: ${pattern}.`, module.id, module.path))
      }
    }
    for (const pattern of module.related) {
      if (!repo.files.some(file => matches(file, [pattern]))) {
        diagnostics.push(diagnostic('error', 'EMPTY_RELATED_PATTERN', `Related pattern matches no managed files: ${pattern}.`, module.id, module.path))
      }
    }
    for (const relation of [...module.depends_on, ...module.collaborates_with]) {
      if (relation === module.id || !byId.has(relation)) diagnostics.push(diagnostic('error', 'INVALID_RELATION', `Relation ${relation} does not identify another module.`, module.id, module.path))
    }
    for (const peer of module.collaborates_with) {
      if (byId.has(peer) && !byId.get(peer)!.collaborates_with.includes(module.id)) diagnostics.push(diagnostic('error', 'ASYMMETRIC_COLLABORATION', `${peer} must also collaborate with ${module.id}.`, module.id, module.path))
    }
  }

  if (includeStructure) {
    const owners = new Map<string, string[]>()
    for (const file of repo.files) owners.set(file, repo.modules.filter(module => matches(file, module.owns)).map(module => module.id))
    for (const [file, modules] of owners) {
      if (modules.length === 0) diagnostics.push(diagnostic('error', 'UNOWNED_FILE', 'Managed file has no owning module.', undefined, file))
      if (modules.length > 1) diagnostics.push(diagnostic('error', 'OVERLAPPING_OWNERSHIP', `Managed file is owned by: ${modules.join(', ')}.`, undefined, file))
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, chain: string[]): void => {
    if (visiting.has(id)) {
      diagnostics.push(diagnostic('warning', 'DEPENDENCY_CYCLE', `Dependency cycle: ${[...chain, id].join(' -> ')}.`, id))
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.depends_on ?? []) if (byId.has(dependency)) visit(dependency, [...chain, id])
    visiting.delete(id)
    visited.add(id)
  }
  if (includeStructure) for (const id of byId.keys()) visit(id, [])

  if (includeFreshness) for (const module of repo.modules) {
    const actual = await scopeDigest(repo.root, module.owns, digestFiles(repo, module), repo.fileModes, repo.fileBlobs, repo.dirtyFiles)
    if (module.scope_digest !== actual) diagnostics.push(diagnostic('error', 'STALE_SCOPE_DIGEST', `Recorded scope digest is ${module.scope_digest || '<empty>'}; expected ${actual}.`, module.id, repo.lockPath))
  }
  const invalid = diagnostics.some(item => item.severity === 'error')
  return { schema: 'module-agent/validation/v1', valid: !invalid, strict: mode === 'strict', mode, modules: repo.modules.length, files: repo.files.length, diagnostics }
}

export async function refreshModule(repo: ModuleRepository, module: ModuleDocumentV1): Promise<string> {
  const digest = await scopeDigest(repo.root, module.owns, digestFiles(repo, module), repo.fileModes, repo.fileBlobs, repo.dirtyFiles)
  repo.lock.digests[module.id] = digest
  const sorted: ModuleLockV1 = {
    schema: 'module-agent-lock/v1',
    digests: Object.fromEntries(Object.entries(repo.lock.digests).sort(([left], [right]) => left.localeCompare(right))),
  }
  await writeFile(repo.lockPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  repo.lock = sorted
  module.scope_digest = digest
  return digest
}
