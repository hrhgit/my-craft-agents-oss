import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { changedFiles, git, scopeDigest } from './git.ts'
import { route } from './core.ts'
import { matches, type ModuleRepository } from './repository.ts'
import { taskPlanSchema } from './schema.ts'
import type { TaskPlanPhaseV1, TaskPlanV1 } from './types.ts'

const planIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const phaseOrder: TaskPlanPhaseV1[] = ['discover', 'implement', 'integrate', 'accept', 'archive', 'closed']

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stateRoot(repo: ModuleRepository): string {
  return resolve(repo.root, repo.config.state_dir)
}

function planPath(repo: ModuleRepository, id: string): string {
  if (!planIdPattern.test(id)) throw new Error(`Invalid task plan id: ${id}`)
  return join(stateRoot(repo), 'plans', `${id}.json`)
}

async function savePlan(repo: ModuleRepository, plan: TaskPlanV1, create = false): Promise<void> {
  const path = planPath(repo, plan.id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: create ? 'wx' : 'w' })
}

export async function readTaskPlan(repo: ModuleRepository, id: string): Promise<TaskPlanV1> {
  const parsed = taskPlanSchema.parse(JSON.parse(await readFile(planPath(repo, id), 'utf8'))) as TaskPlanV1
  if (parsed.id !== id) throw new Error(`Task plan identity mismatch: ${id}`)
  const modules = parsed.owners.map(owner => {
    const module = repo.modules.find(candidate => candidate.id === owner)
    if (!module) throw new Error(`Task plan owner no longer exists: ${owner}`)
    return module
  })
  const expectedScopes = [...new Set([
    ...modules.flatMap(module => module.owns),
    ...parsed.owners.map(owner => `.agents/modules/${owner}.md`),
  ])].sort()
  if (JSON.stringify(parsed.allowed_scopes) !== JSON.stringify(expectedScopes)) throw new Error(`Task plan ownership changed; create a new plan: ${id}`)
  const expectedIntent = sha256(JSON.stringify({ query: parsed.query.trim(), files: parsed.route_files, base_commit: parsed.base_commit }))
  if (parsed.intent_hash !== expectedIntent) throw new Error(`Task plan intent identity mismatch: ${id}`)
  return parsed
}

export async function repositorySourceId(repo: ModuleRepository): Promise<string> {
  const lockFile = repo.config.lock_file.replaceAll('\\', '/').replace(/^\.\//, '')
  const files = repo.files.filter(file => !/^\.agents\/modules\/[^/]+\.md$/.test(file) && file !== lockFile)
  return scopeDigest(repo.root, ['task-source', ...repo.config.include], files, repo.fileModes, repo.fileBlobs, repo.dirtyFiles)
}

export async function createTaskPlan(
  repo: ModuleRepository,
  input: { id: string; query: string; files: string[]; base: string },
): Promise<TaskPlanV1> {
  const routed = route(repo, input.query, input.files)
  const pathOwners = routed.candidates.filter(candidate => candidate.reasons.some(reason => reason.startsWith('owns ')))
  const owners = (pathOwners.length ? pathOwners : routed.candidates.slice(0, 1)).map(candidate => candidate.module).sort()
  if (!owners.length) throw new Error('Task plan routing found no owner; provide a more specific query or --file path')
  const modules = owners.map(id => repo.modules.find(module => module.id === id)!)
  const baseCommit = new TextDecoder().decode(await git(repo.root, ['rev-parse', '--verify', `${input.base}^{commit}`])).trim()
  const now = new Date().toISOString()
  const files = [...new Set(input.files.map(file => file.replaceAll('\\', '/').replace(/^\.\//, '')))].sort()
  const plan: TaskPlanV1 = {
    schema: 'module-agent/task-plan/v1',
    id: input.id,
    query: input.query,
    intent_hash: sha256(JSON.stringify({ query: input.query.trim(), files, base_commit: baseCommit })),
    base_ref: input.base,
    base_commit: baseCommit,
    route_files: files,
    owners,
    allowed_scopes: [...new Set([
      ...modules.flatMap(module => module.owns),
      ...owners.map(id => `.agents/modules/${id}.md`),
    ])].sort(),
    recommended_tier: owners.length > 1 ? 'B' : 'A',
    phase: 'discover',
    reviewed_modules: [],
    checkpoints: { discover: now },
    created_at: now,
    updated_at: now,
  }
  await savePlan(repo, plan, true)
  return plan
}

export async function checkTaskPlan(
  repo: ModuleRepository,
  id: string,
  requestedPhase?: Exclude<TaskPlanPhaseV1, 'closed'>,
  reviewedModules: string[] = [],
): Promise<{ schema: 'module-agent/task-plan-check/v1'; valid: boolean; changed_files: string[]; outside_scope: string[]; source_id: string; missing_reviews: string[]; plan: TaskPlanV1 }> {
  const plan = await readTaskPlan(repo, id)
  if (plan.phase === 'closed') throw new Error(`Task plan is closed: ${id}`)
  const changed = await changedFiles(repo.root, plan.base_commit)
  const managed = new Set(repo.files)
  const changedManaged = changed.filter(file => managed.has(file))
  const outsideScope = changedManaged.filter(file => !matches(file, plan.allowed_scopes))
  const sourceId = await repositorySourceId(repo)
  let valid = outsideScope.length === 0

  for (const module of reviewedModules) {
    if (!plan.owners.includes(module)) throw new Error(`Cannot record review for non-owner module: ${module}`)
  }

  if (requestedPhase) {
    const currentIndex = phaseOrder.indexOf(plan.phase)
    const requestedIndex = phaseOrder.indexOf(requestedPhase)
    if (requestedIndex < currentIndex || requestedIndex > currentIndex + 1) throw new Error(`Invalid phase transition: ${plan.phase} -> ${requestedPhase}`)
    if (requestedPhase === 'integrate') {
      plan.frozen_source_id = sourceId
      plan.reviewed_modules = []
    } else if (requestedIndex > phaseOrder.indexOf('integrate') && plan.frozen_source_id !== sourceId) {
      valid = false
    }
    plan.reviewed_modules = [...new Set([...plan.reviewed_modules, ...reviewedModules])].sort()
    const missingReviews = plan.owners.filter(module => !plan.reviewed_modules.includes(module))
    if (requestedPhase === 'accept' && missingReviews.length) valid = false
    if (valid) {
      plan.phase = requestedPhase
      plan.checkpoints[requestedPhase] = new Date().toISOString()
    }
  } else {
    plan.reviewed_modules = [...new Set([...plan.reviewed_modules, ...reviewedModules])].sort()
  }
  plan.updated_at = new Date().toISOString()
  await savePlan(repo, plan)
  const missingReviews = plan.owners.filter(module => !plan.reviewed_modules.includes(module))
  return { schema: 'module-agent/task-plan-check/v1', valid, changed_files: changedManaged, outside_scope: outsideScope, source_id: sourceId, missing_reviews: missingReviews, plan }
}

export async function closeTaskPlan(repo: ModuleRepository, id: string): Promise<TaskPlanV1> {
  const plan = await readTaskPlan(repo, id)
  if (plan.phase !== 'archive') throw new Error(`Task plan must reach archive before close; current phase is ${plan.phase}`)
  const sourceId = await repositorySourceId(repo)
  if (plan.frozen_source_id !== sourceId) throw new Error(`Task plan source changed after acceptance: ${id}`)
  const now = new Date().toISOString()
  plan.phase = 'closed'
  plan.closed_at = now
  plan.updated_at = now
  await savePlan(repo, plan)
  return plan
}
