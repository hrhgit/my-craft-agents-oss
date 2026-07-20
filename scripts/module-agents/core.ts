import { spawn } from 'node:child_process'
import { matches, ownedFiles, type ModuleRepository } from './repository.ts'
import { changedFiles } from './git.ts'
import type { ImpactResultV1, ModuleDocumentV1, ModuleTestResultV1, RouteCandidateV1, RouteResultV1, ValidationEntryV1, ValidationLevelV1, ValidationRunV1 } from './types.ts'

function normalizedFiles(files: string[]): string[] {
  return [...new Set(files.map(file => file.replaceAll('\\', '/').replace(/^\.\//, '')))].sort()
}

export function route(repo: ModuleRepository, query: string, files: string[] = []): RouteResultV1 {
  files = normalizedFiles(files)
  const queryLower = query.toLocaleLowerCase('en-US')
  const words = new Set(queryLower.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [])
  const candidates: RouteCandidateV1[] = []
  for (const module of repo.modules) {
    let score = 0
    const reasons: string[] = []
    const owned = files.filter(file => matches(file, module.owns))
    const related = files.filter(file => !owned.includes(file) && matches(file, module.related))
    if (owned.length) {
      score += 100 + Math.min(owned.length - 1, 4) * 5
      reasons.push(`owns ${owned.slice(0, 3).join(', ')}`)
    }
    if (related.length) {
      score += 55 + Math.min(related.length - 1, 4) * 3
      reasons.push(`related to ${related.slice(0, 3).join(', ')}`)
    }
    const identity = `${module.id} ${module.name}`.toLocaleLowerCase('en-US')
    if (queryLower && (identity.includes(queryLower) || queryLower.includes(module.id))) {
      score += 70
      reasons.push(`query names ${module.id}`)
    }
    const keywordHits = module.keywords.filter(keyword => {
      const lower = keyword.toLocaleLowerCase('en-US')
      return queryLower.includes(lower) || words.has(lower)
    })
    if (keywordHits.length) {
      score += Math.min(45, keywordHits.length * 15)
      reasons.push(`keywords: ${keywordHits.slice(0, 4).join(', ')}`)
    }
    const summaryWords = new Set(module.summary.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [])
    const summaryHits = [...words].filter(word => word.length >= 4 && summaryWords.has(word))
    if (summaryHits.length) {
      score += Math.min(20, summaryHits.length * 4)
      reasons.push(`summary terms: ${summaryHits.slice(0, 4).join(', ')}`)
    }
    if (score > 0) candidates.push({ module: module.id, confidence: Math.min(1, score / 100), reasons, depends_on: module.depends_on })
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.module.localeCompare(b.module))
  const hasPathOwner = candidates.some(candidate => candidate.reasons.some(reason => reason.startsWith('owns ')))
  const relevant = candidates.filter(candidate => hasPathOwner
    ? candidate.reasons.some(reason => /^(owns |related to |query names )/.test(reason))
    : candidate.confidence >= 0.1)
  return { schema: 'module-agent/route/v1', query, files, candidates: relevant.slice(0, repo.config.max_route_candidates) }
}

export async function impact(repo: ModuleRepository, base: string): Promise<ImpactResultV1> {
  const managed = new Set(repo.files)
  const files = (await changedFiles(repo.root, base)).filter(file => managed.has(file))
  const impacted = repo.modules.flatMap(module => {
    const owned_files = files.filter(file => matches(file, module.owns))
    const related_files = files.filter(file => !owned_files.includes(file) && matches(file, module.related))
    if (!owned_files.length && !related_files.length) return []
    return [{ module, owned_files, related_files, reason: owned_files.length ? 'owner' as const : 'related' as const }]
  }).sort((a, b) => a.module.id.localeCompare(b.module.id))
  const owners = impacted.filter(item => item.owned_files.length).length
  const recommendContract = owners > 1 || impacted.some(item => item.related_files.length > 0 || item.reason === 'related')
  const modules = impacted.map(({ module, ...item }) => ({
    module: module.id,
    ...item,
    validation: {
      recommended_level: recommendContract ? 'contract' as const : 'fast' as const,
      available_plans: (['fast', 'contract', 'full'] as const).map(level => ({
        level,
        validation_ids: validationPlan(module, level).map(entry => entry.id),
      })),
    },
  }))
  return { schema: 'module-agent/impact/v1', base, files, modules }
}

const validationKindsByLevel: Record<ValidationLevelV1, Set<ValidationEntryV1['kind']>> = {
  fast: new Set(['unit']),
  contract: new Set(['unit', 'contract']),
  full: new Set(['unit', 'contract', 'integration', 'physical']),
}

export function validationPlan(module: ModuleDocumentV1, level: ValidationLevelV1): ValidationEntryV1[] {
  return module.validation.filter(entry => validationKindsByLevel[level].has(entry.kind))
}

async function runValidation(repo: ModuleRepository, entry: ValidationEntryV1): Promise<ValidationRunV1> {
  const started = performance.now()
  const child = spawn(entry.command, {
    cwd: repo.root,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const capture = (stream: NodeJS.ReadableStream): Promise<{ value: string; truncated: boolean }> => new Promise(resolve => {
    let value = ''
    let truncated = false
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const remaining = repo.config.test_output_limit - value.length
      if (remaining > 0) value += chunk.slice(0, remaining)
      if (chunk.length > remaining) truncated = true
    })
    stream.on('end', () => resolve({ value, truncated }))
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      try { process.kill(-child.pid!, 'SIGTERM') } catch { child.kill() }
    }
  }, repo.config.test_timeout_ms)
  const [exitCode, stdout, stderr] = await Promise.all([
    new Promise<number>(resolve => child.on('close', code => resolve(code ?? 1))),
    capture(child.stdout!),
    capture(child.stderr!),
  ])
  clearTimeout(timer)
  return {
    ...entry,
    status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed',
    exit_code: exitCode,
    duration_ms: Math.round(performance.now() - started),
    stdout: stdout.value,
    stderr: stderr.value,
    output_truncated: stdout.truncated || stderr.truncated,
  }
}

export async function testModule(repo: ModuleRepository, module: ModuleDocumentV1, level: ValidationLevelV1, dryRun = false): Promise<ModuleTestResultV1> {
  const plan = validationPlan(module, level)
  if (dryRun) {
    return {
      schema: 'module-agent/test/v1', module: module.id, level, dry_run: true, passed: null,
      validations: plan.map(entry => ({ ...entry, status: 'planned' })),
    }
  }
  const validations: ValidationRunV1[] = []
  for (const entry of plan) validations.push(await runValidation(repo, entry))
  return {
    schema: 'module-agent/test/v1', module: module.id, level, dry_run: false,
    passed: validations.every(entry => !entry.required || entry.status === 'passed'),
    validations,
  }
}

export function listModules(repo: ModuleRepository, details = false) {
  return repo.modules.map(module => ({
    id: module.id,
    name: module.name,
    summary: module.summary,
    status: module.status,
    keywords: module.keywords,
    files: ownedFiles(repo, module).length,
    ...(details ? {
      owns: module.owns,
      related: module.related,
      depends_on: module.depends_on,
      collaborates_with: module.collaborates_with,
      validation: module.validation,
      scope_digest: module.scope_digest,
    } : {}),
  }))
}
