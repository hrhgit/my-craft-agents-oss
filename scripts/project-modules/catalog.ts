import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import { projectModuleSchema, type ProjectModule, type ProjectModuleDiagnostic } from './schema'

export interface ProjectModuleCatalog {
  schema: 'project-modules/catalog/v1'
  modules: ProjectModule[]
  consumers: Record<string, string[]>
}

export interface ProjectModuleLintResult {
  schema: 'project-modules/lint/v1'
  valid: boolean
  modules: number
  diagnostics: ProjectModuleDiagnostic[]
}

function repositoryPath(root: string, path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function diagnostic(
  code: ProjectModuleDiagnostic['code'],
  message: string,
  document: string,
  module?: string,
): ProjectModuleDiagnostic {
  return { code, message, document, ...(module ? { module } : {}) }
}

export async function loadProjectModules(root: string): Promise<{
  modules: ProjectModule[]
  diagnostics: ProjectModuleDiagnostic[]
}> {
  const directory = resolve(root, '.agents', 'modules')
  const documents = (await readdir(directory)).filter(name => name.endsWith('.md')).sort()
  const modules: ProjectModule[] = []
  const diagnostics: ProjectModuleDiagnostic[] = []

  for (const name of documents) {
    const absolute = resolve(directory, name)
    const document = repositoryPath(root, relative(root, absolute))
    try {
      const parsed = matter(await readFile(absolute, 'utf8'))
      const data = projectModuleSchema.parse(parsed.data)
      if (basename(name, '.md') !== data.id) {
        diagnostics.push(diagnostic('FILENAME_MISMATCH', `Document must be named ${data.id}.md.`, document, data.id))
      }
      for (const entrypoint of data.entrypoints) {
        if (entrypoint.replaceAll('\\', '/').split('/').includes('node_modules')) {
          diagnostics.push(diagnostic('INVALID_ENTRYPOINT', `Entrypoint cannot use node_modules: ${entrypoint}`, document, data.id))
          continue
        }
        const target = resolve(root, entrypoint)
        if (!existsSync(target) || !statSync(target).isFile()) {
          diagnostics.push(diagnostic('MISSING_ENTRYPOINT', `Entrypoint does not exist: ${entrypoint}`, document, data.id))
        }
      }
      for (const interactionDocument of data.frontend_impact.interaction_docs) {
        const target = resolve(root, interactionDocument)
        if (!existsSync(target) || !statSync(target).isFile()) {
          diagnostics.push(diagnostic('MISSING_INTERACTION_DOCUMENT', `Interaction document does not exist: ${interactionDocument}`, document, data.id))
        }
      }
      modules.push({ ...data, document })
    } catch (error) {
      diagnostics.push(diagnostic(
        'INVALID_DOCUMENT',
        error instanceof Error ? error.message : String(error),
        document,
      ))
    }
  }

  const byId = new Map<string, ProjectModule>()
  for (const module of modules) {
    if (byId.has(module.id)) diagnostics.push(diagnostic('DUPLICATE_ID', `Duplicate module id: ${module.id}`, module.document, module.id))
    else byId.set(module.id, module)
  }
  for (const module of modules) {
    for (const reference of [...module.depends_on, ...module.related]) {
      if (reference === module.id || !byId.has(reference)) {
        diagnostics.push(diagnostic('INVALID_REFERENCE', `Unknown module reference: ${reference}`, module.document, module.id))
      }
    }
  }

  return { modules: modules.sort((a, b) => a.id.localeCompare(b.id)), diagnostics }
}

export async function lintProjectModules(root: string): Promise<ProjectModuleLintResult> {
  const loaded = await loadProjectModules(root)
  return {
    schema: 'project-modules/lint/v1',
    valid: loaded.diagnostics.length === 0,
    modules: loaded.modules.length,
    diagnostics: loaded.diagnostics,
  }
}

export async function buildProjectModuleCatalog(root: string): Promise<ProjectModuleCatalog> {
  const loaded = await loadProjectModules(root)
  if (loaded.diagnostics.length) {
    throw new Error(`Project module catalog is invalid: ${JSON.stringify(loaded.diagnostics)}`)
  }
  const consumers: Record<string, string[]> = Object.fromEntries(loaded.modules.map(module => [module.id, []]))
  for (const module of loaded.modules) {
    for (const dependency of module.depends_on) consumers[dependency]!.push(module.id)
  }
  for (const ids of Object.values(consumers)) ids.sort()
  return { schema: 'project-modules/catalog/v1', modules: loaded.modules, consumers }
}

export function renderProjectModuleCatalog(catalog: ProjectModuleCatalog): string {
  const lines = [
    '# Project Modules',
    '',
    'Select the smallest relevant set, then read each linked module document in full. Multiple matches do not imply task decomposition.',
    '',
  ]
  for (const module of catalog.modules.filter(module => module.status !== 'deprecated')) {
    lines.push(`- \`${module.id}\` - ${module.summary}`)
    lines.push(`  Read when: ${module.when_to_read.join('; ')}`)
    lines.push(`  Frontend: ${module.frontend_impact.affects ? module.frontend_impact.areas.join('; ') : 'none'}`)
    if (module.frontend_impact.interaction_docs.length) {
      lines.push(`  Interactions: ${module.frontend_impact.interaction_docs.map(path => `\`${path}\``).join(', ')}`)
    }
    lines.push(`  Document: \`${module.document}\``)
    if (module.depends_on.length) lines.push(`  Depends on: ${module.depends_on.map(id => `\`${id}\``).join(', ')}`)
    const consumers = catalog.consumers[module.id] ?? []
    if (consumers.length) lines.push(`  Used by: ${consumers.map(id => `\`${id}\``).join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}
