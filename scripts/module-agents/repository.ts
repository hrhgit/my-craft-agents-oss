import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import { load } from 'js-yaml'
import { configSchema, moduleFrontmatterSchema, REQUIRED_HEADINGS } from './schema.ts'
import { repositoryDirtyFiles, repositoryFileBlobs, repositoryFileModes, repositoryFiles, scopeDigest } from './git.ts'
import type { ModuleDocumentV1, ModuleSystemConfigV1, ValidationDiagnosticV1, ValidationResultV1 } from './types.ts'

export interface ModuleRepository {
  root: string
  configPath: string
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
  const modulesDir = resolve(root, config.modules_dir)
  const relativeModulesDir = relative(root, modulesDir)
  if (relativeModulesDir.startsWith('..') || isAbsolute(relativeModulesDir)) {
    throw new Error(`modules_dir must stay inside the repository: ${config.modules_dir}`)
  }
  const names = (await readdir(modulesDir)).filter(name => name.endsWith('.md')).sort()
  const modules: ModuleDocumentV1[] = []
  for (const name of names) {
    const path = join(modulesDir, name)
    const parsed = matter(await readFile(path, 'utf8'))
    const data = moduleFrontmatterSchema.parse(parsed.data)
    modules.push({ ...data, body: parsed.content, path })
  }
  const [allFiles, fileModes, fileBlobs, dirtyFiles] = await Promise.all([
    repositoryFiles(root),
    repositoryFileModes(root),
    repositoryFileBlobs(root),
    repositoryDirtyFiles(root),
  ])
  const files = allFiles.filter(path => matches(path, config.include) && !matches(path, config.exclude))
  return { root, configPath, config, modules, files, fileModes, fileBlobs, dirtyFiles }
}

function diagnostic(severity: 'error' | 'warning', code: string, message: string, module?: string, path?: string): ValidationDiagnosticV1 {
  return { schema: 'module-agent/diagnostic/v1', severity, code, message, module, path }
}

export function ownedFiles(repo: ModuleRepository, module: ModuleDocumentV1): string[] {
  return repo.files.filter(path => matches(path, module.owns))
}

function digestFiles(repo: ModuleRepository, module: ModuleDocumentV1): string[] {
  // Module documents are validated as protocol inputs. Hashing them would make
  // the module-agent-system digest depend on the digest value stored inside it.
  return ownedFiles(repo, module).filter(path => !/^\.agents\/modules\/[^/]+\.md$/.test(path))
}

export async function validateRepository(repo: ModuleRepository, strict = false): Promise<ValidationResultV1> {
  const diagnostics: ValidationDiagnosticV1[] = []
  const byId = new Map<string, ModuleDocumentV1>()
  for (const module of repo.modules) {
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

  for (const module of repo.modules) {
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

  const owners = new Map<string, string[]>()
  for (const file of repo.files) owners.set(file, repo.modules.filter(module => matches(file, module.owns)).map(module => module.id))
  for (const [file, modules] of owners) {
    if (modules.length === 0) diagnostics.push(diagnostic('error', 'UNOWNED_FILE', 'Managed file has no owning module.', undefined, file))
    if (modules.length > 1) diagnostics.push(diagnostic('error', 'OVERLAPPING_OWNERSHIP', `Managed file is owned by: ${modules.join(', ')}.`, undefined, file))
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
  for (const id of byId.keys()) visit(id, [])

  for (const module of repo.modules) {
    const actual = await scopeDigest(repo.root, module.owns, digestFiles(repo, module), repo.fileModes, repo.fileBlobs, repo.dirtyFiles)
    if (module.scope_digest !== actual) diagnostics.push(diagnostic('error', 'STALE_SCOPE_DIGEST', `scope_digest is ${module.scope_digest || '<empty>'}; expected ${actual}.`, module.id, module.path))
  }
  const invalid = diagnostics.some(item => item.severity === 'error')
  return { schema: 'module-agent/validation/v1', valid: !invalid, strict, modules: repo.modules.length, files: repo.files.length, diagnostics }
}

export async function refreshModule(repo: ModuleRepository, module: ModuleDocumentV1): Promise<string> {
  const digest = await scopeDigest(repo.root, module.owns, digestFiles(repo, module), repo.fileModes, repo.fileBlobs, repo.dirtyFiles)
  const source = await readFile(module.path, 'utf8')
  if (!/^scope_digest\s*:/m.test(source.split(/^---\s*$/m)[1] ?? '')) throw new Error(`${module.id}: missing scope_digest frontmatter field`)
  const updated = source.replace(/^(scope_digest\s*:\s*).*$/m, `$1${digest}`)
  if (updated !== source) await writeFile(module.path, updated, 'utf8')
  module.scope_digest = digest
  return digest
}
