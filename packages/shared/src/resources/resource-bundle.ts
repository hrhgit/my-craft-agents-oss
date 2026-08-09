/**
 * Resource Bundle — Export/Import Logic
 *
 * Exports workspace resources (skills and Automations V3 definitions) to a portable
 * ResourceBundle, and imports bundles into a target workspace.
 *
 * Key behaviors:
 * - All non-hidden files are included per resource (not just known file types)
 * - Import uses staging + atomic rename per resource (single watcher event)
 * - Automations update the canonical versioned store through optimistic concurrency
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
  restoreFiles,
  validateBundleFile,
} from '../utils/bundle-files.ts'
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts'
import {
  AutomationDefinitionV3Schema,
  AutomationDependencyDeclarationV1Schema,
} from '../automations/v3-schemas.ts'
import type { AutomationWorkspaceHostV3 } from '../automations/v3-host-runtime.ts'
import { debug } from '../utils/debug.ts'
import type {
  AutomationDefinitionV3,
  AutomationDependencyDeclarationV1,
} from '../automations/v3-types.ts'
import type {
  ResourceBundle,
  SkillBundleEntry,
  ExportResourcesOptions,
  ExportResult,
  ResourceImportMode,
  ResourceImportResult,
  ImportBucketResult,
  PortableAutomationEntryV1,
  AutomationDependencyResolverV1,
} from './types.ts'

// ============================================================
// Export
// ============================================================

/**
 * Export workspace resources to a portable ResourceBundle.
 *
 * @param workspaceRootPath - Absolute path to workspace root
 * @param options - Which resources to export
 * @returns Bundle + export warnings
 */
export function exportResources(
  workspaceRootPath: string,
  options: ExportResourcesOptions,
  workspaceId = workspaceRootPath,
  automationHost?: AutomationWorkspaceHostV3,
): ExportResult {
  const warnings: string[] = []
  const bundle: ResourceBundle = {
    version: 3,
    exportedAt: Date.now(),
    resources: {},
  }

  // Try to read workspace name for informational purposes
  try {
    const wsConfigPath = join(workspaceRootPath, 'config.json')
    if (existsSync(wsConfigPath)) {
      const wsConfig = JSON.parse(readFileSync(wsConfigPath, 'utf-8'))
      if (wsConfig.name) {
        bundle.sourceWorkspace = wsConfig.name
      }
    }
  } catch {
    // Non-fatal: sourceWorkspace is informational
  }

  // --- Export skills ---
  if (options.skills) {
    bundle.resources.skills = exportSkills(workspaceRootPath, options.skills, warnings)
  }

  // --- Export automations ---
  // Normalize: true → 'all', false/undefined → skip
  const automationSelection = options.automations === true ? 'all' : options.automations
  if (automationSelection) {
    if (!automationHost) throw new Error(`Automations V3 host is unavailable for workspace ${workspaceId}`)
    bundle.resources.automations = exportAutomations(automationHost, automationSelection, warnings)
  }

  // Validate total size
  const bundleJson = JSON.stringify(bundle)
  if (Buffer.byteLength(bundleJson) > MAX_BUNDLE_SIZE_BYTES) {
    warnings.push(`Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES / 1024 / 1024}MB size limit`)
  }

  return { bundle, warnings }
}

function exportSkills(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): SkillBundleEntry[] {
  const entries: SkillBundleEntry[] = []
  const skillsDir = getWorkspaceSkillsPath(workspaceRootPath)

  if (!existsSync(skillsDir)) return entries

  // Determine which slugs to export
  let slugs: string[]
  if (selection === 'all') {
    slugs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    const skillDir = join(skillsDir, slug)
    if (!existsSync(skillDir)) {
      warnings.push(`Skill '${slug}' not found, skipping`)
      continue
    }

    // Collect all files in the skill directory
    const files = collectDirectoryFiles(skillDir)

    // Validate that SKILL.md is present
    const hasSkillMd = files.some(f => f.relativePath === 'SKILL.md')
    if (!hasSkillMd) {
      warnings.push(`Skill '${slug}' missing SKILL.md, skipping`)
      continue
    }

    entries.push({ slug, files })
  }

  return entries
}

// ============================================================
// Export: Automations
// ============================================================

const SECRET_HEADER_PATTERNS = [/^authorization$/i, /^proxy-authorization$/i, /api[-_]?key/i]

function portableSecretId(definitionId: string, actionId: string, field: string): string {
  const digest = createHash('sha256').update(`${definitionId}\n${actionId}\n${field}`).digest('hex').slice(0, 32)
  return `portable-secret-${digest}`
}

function portableAutomationDefinition(
  definition: AutomationDefinitionV3,
  warnings: string[],
): PortableAutomationEntryV1 {
  const sanitized = structuredClone(definition)
  const dependencies: AutomationDependencyDeclarationV1[] = [
    ...(sanitized.configuration?.missingDependencies ?? []),
  ]
  for (const trigger of sanitized.triggers) {
    if (trigger.type !== 'event' || (trigger.source !== 'extension' && trigger.source !== 'external')) continue
    dependencies.push({
      kind: 'event-source',
      id: `${trigger.source}:${trigger.eventType}`,
      triggerId: trigger.id,
      source: trigger.source,
      required: true,
    })
  }
  for (const action of sanitized.actions) {
    if (action.type === 'prompt' && action.target.kind === 'session' && action.target.session !== 'event-session') {
      dependencies.push({ kind: 'session', id: action.target.session.id, actionId: action.id, required: true })
      continue
    }
    if (action.type !== 'webhook') continue
    if (action.auth?.type === 'basic') {
      dependencies.push({ kind: 'secret', id: action.auth.password.id, actionId: action.id, field: 'auth.password', required: true })
    } else if (action.auth?.type === 'bearer') {
      dependencies.push({ kind: 'secret', id: action.auth.token.id, actionId: action.id, field: 'auth.token', required: true })
    }
    for (const key of Object.keys(action.headers ?? {})) {
      if (!SECRET_HEADER_PATTERNS.some(pattern => pattern.test(key))) continue
      const id = portableSecretId(definition.id, action.id, `headers.${key}`)
      action.headers![key] = `\${mortise-secret:${id}}`
      dependencies.push({ kind: 'secret', id, actionId: action.id, field: `headers.${key}`, required: true })
      warnings.push(`Automation '${definition.name}': replaced webhook header '${key}' with a secret dependency`)
    }
  }
  const deduplicated = [...new Map(dependencies.map(dependency => [JSON.stringify(dependency), dependency])).values()]
  return { schemaVersion: 1, definition: sanitized, dependencies: deduplicated }
}

function exportAutomations(
  host: AutomationWorkspaceHostV3,
  selection: string[] | 'all',
  warnings: string[],
): PortableAutomationEntryV1[] {
    const allDefinitions = host.exportDefinitions()
    const selected: AutomationDefinitionV3[] = []
    if (selection === 'all') {
      selected.push(...allDefinitions)
    } else {
      const matched = new Set<string>()
      for (const selector of selection) {
        const matches = allDefinitions.filter(item => item.id === selector || item.name === selector)
        if (matches.length === 0) warnings.push(`Automation selector '${selector}' did not match any automation`)
        if (matches.length > 1 && matches.every(item => item.id !== selector)) {
          warnings.push(`Automation name '${selector}' matched ${matches.length} automations`)
        }
        for (const definition of matches) {
          if (matched.has(definition.id)) continue
          matched.add(definition.id)
          selected.push(definition)
        }
      }
    }
    return selected.map(definition => portableAutomationDefinition(definition, warnings))
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate a ResourceBundle structure.
 * Returns { valid, errors } rather than a type guard, so callers get diagnostics.
 */
export function validateResourceBundle(bundle: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['Bundle is not an object'] }
  }

  const b = bundle as Record<string, unknown>

  if (b.version !== 3) {
    errors.push(`Unsupported bundle version: ${b.version}`)
  }

  if (typeof b.exportedAt !== 'number') {
    errors.push('Missing or invalid exportedAt')
  }

  if (!b.resources || typeof b.resources !== 'object') {
    errors.push('Missing or invalid resources')
    return { valid: false, errors }
  }

  const res = b.resources as Record<string, unknown>

  // Validate skills
  if (res.skills !== undefined) {
    if (!Array.isArray(res.skills)) {
      errors.push('resources.skills must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res.skills.length; i++) {
        const entry = res.skills[i]
        const prefix = `skills[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.slug !== 'string' || !e.slug) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }

        if (slugs.has(e.slug as string)) {
          errors.push(`${prefix}: duplicate slug '${e.slug}'`)
        }
        slugs.add(e.slug as string)

        if (!Array.isArray(e.files)) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          // Validate SKILL.md is present
          const hasSkillMd = (e.files as BundleFile[]).some(f =>
            typeof f === 'object' && f && (f as BundleFile).relativePath === 'SKILL.md',
          )
          if (!hasSkillMd) {
            errors.push(`${prefix}: missing SKILL.md`)
          }
          validateFileEntries(e.files as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // Validate automations
  if (res.automations !== undefined) {
    if (!Array.isArray(res.automations)) {
      errors.push('resources.automations must be an array')
    } else {
      const ids = new Set<string>()
      for (let i = 0; i < res.automations.length; i++) {
        const entry = res.automations[i]
        const prefix = `automations[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const portable = entry as Record<string, unknown>
        if (portable.schemaVersion !== 1) {
          errors.push(`${prefix}: schemaVersion must be 1`)
          continue
        }
        const parsed = AutomationDefinitionV3Schema.safeParse(portable.definition)
        if (!parsed.success) {
          errors.push(`${prefix}.definition: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
          continue
        }
        if (!Array.isArray(portable.dependencies)) {
          errors.push(`${prefix}.dependencies: must be an array`)
          continue
        }
        for (const [dependencyIndex, dependency] of portable.dependencies.entries()) {
          const dependencyResult = AutomationDependencyDeclarationV1Schema.safeParse(dependency)
          if (!dependencyResult.success) {
            errors.push(`${prefix}.dependencies[${dependencyIndex}]: ${dependencyResult.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
          }
        }
        if (ids.has(parsed.data.id)) {
          errors.push(`${prefix}: duplicate id '${parsed.data.id}'`)
        }
        ids.add(parsed.data.id)
      }
    }
  }

  // Validate total bundle size
  try {
    const size = Buffer.byteLength(JSON.stringify(bundle))
    if (size > MAX_BUNDLE_SIZE_BYTES) {
      errors.push(`Bundle size ${size} exceeds max ${MAX_BUNDLE_SIZE_BYTES}`)
    }
  } catch {
    errors.push('Bundle is not serializable')
  }

  return { valid: errors.length === 0, errors }
}

function validateFileEntries(files: BundleFile[], prefix: string, errors: string[]): void {
  const paths = new Set<string>()

  for (let j = 0; j < files.length; j++) {
    const file = files[j]
    if (!file || typeof file !== 'object') {
      errors.push(`${prefix}.files[${j}]: not an object`)
      continue
    }

    // Check for duplicate paths
    if (paths.has(file.relativePath)) {
      errors.push(`${prefix}.files[${j}]: duplicate path '${file.relativePath}'`)
    }
    paths.add(file.relativePath)

    const fileError = validateBundleFile(file)
    if (fileError) {
      errors.push(`${prefix}.files[${j}]: ${fileError}`)
    }
  }
}

// ============================================================
// Import
// ============================================================

/**
 * Import a ResourceBundle into a target workspace.
 *
 * Uses staging + atomic rename per resource to minimize watcher churn
 * and ensure true replacement on overwrite.
 *
 * @param workspaceRootPath - Absolute path to target workspace
 * @param bundle - The validated ResourceBundle to import
 * @param mode - 'skip' (keep existing) or 'overwrite' (replace)
 * @param skillsRootOverride - Optional absolute skills root; when provided, skills are
 *   imported there instead of the workspace's own skills directory (e.g. global import).
 */
export async function importResources(
  workspaceRootPath: string,
  bundle: ResourceBundle,
  mode: ResourceImportMode,
  workspaceId = workspaceRootPath,
  automationHost?: AutomationWorkspaceHostV3,
  dependencyResolver?: AutomationDependencyResolverV1,
  skillsRootOverride?: string,
): Promise<ResourceImportResult> {
  // Validate bundle first
  const validation = validateResourceBundle(bundle)
  const fatalErrors = validation.errors.filter(error => !error.startsWith('automations['))
  if (fatalErrors.length > 0) {
    const errorMsg = `Invalid bundle: ${fatalErrors.join('; ')}`
    const failedBucket = {
      imported: [], skipped: [], failed: [{ id: '*', error: errorMsg }], warnings: [],
      items: [{ id: '*', status: 'failed' as const, error: errorMsg }],
    }
    return {
      skills: { ...failedBucket },
      automations: { ...failedBucket },
    }
  }

  const skillsResult = bundle.resources.skills
    ? importSkills(workspaceRootPath, bundle.resources.skills, mode, skillsRootOverride)
    : emptyBucketResult()

  const automationsResult = bundle.resources.automations?.length
    ? await importAutomations(workspaceId, bundle.resources.automations, mode, automationHost, dependencyResolver)
    : emptyBucketResult()

  return {
    skills: skillsResult,
    automations: automationsResult,
  }
}

function emptyBucketResult(): ImportBucketResult {
  return { imported: [], skipped: [], failed: [], warnings: [], items: [] }
}

// ============================================================
// Import: Skills
// ============================================================

function importSkills(
  workspaceRootPath: string,
  entries: SkillBundleEntry[],
  mode: ResourceImportMode,
  skillsRootOverride?: string,
): ImportBucketResult {
  const result = emptyBucketResult()
  const skillsDir = skillsRootOverride ?? getWorkspaceSkillsPath(workspaceRootPath)

  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }

  for (const entry of entries) {
    try {
      const targetDir = join(skillsDir, entry.slug)
      const exists = existsSync(targetDir)

      if (exists && mode === 'skip') {
        result.skipped.push(entry.slug)
        result.items.push({ id: entry.slug, status: 'skipped' })
        continue
      }

      // Stage: build in temp dir
      const tmpDir = join(skillsDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
      mkdirSync(tmpDir, { recursive: true })

      try {
        // Restore all files
        restoreFiles(tmpDir, entry.files)

        // Validate: SKILL.md should exist
        if (!existsSync(join(tmpDir, 'SKILL.md'))) {
          result.failed.push({ id: entry.slug, error: 'SKILL.md missing after restore' })
          rmSync(tmpDir, { recursive: true })
          continue
        }

        // On overwrite: remove old dir
        if (exists) {
          rmSync(targetDir, { recursive: true })
        }

        // Atomic replace: rename temp → target
        renameSync(tmpDir, targetDir)
        result.imported.push(entry.slug)
        result.items.push({ id: entry.slug, status: 'imported' })
      } catch (err) {
        // Clean up temp dir on failure
        if (existsSync(tmpDir)) {
          rmSync(tmpDir, { recursive: true })
        }
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
      result.items.push({ id: entry.slug, status: 'failed', error: message })
    }
  }

  return result
}

// ============================================================
// Import: Automations
// ============================================================

async function importAutomations(
  workspaceId: string,
  entries: PortableAutomationEntryV1[],
  mode: ResourceImportMode,
  host?: AutomationWorkspaceHostV3,
  dependencyResolver?: AutomationDependencyResolverV1,
): Promise<ImportBucketResult> {
  const result = emptyBucketResult()
  for (const rawEntry of entries as unknown[]) {
    let id = 'unknown'
    try {
      if (!host) throw new Error(`Automations V3 host is unavailable for workspace ${workspaceId}`)
      if (!rawEntry || typeof rawEntry !== 'object') throw new Error('Portable Automation entry must be an object')
      const entry = rawEntry as PortableAutomationEntryV1
      if (entry.schemaVersion !== 1) throw new Error('Portable Automation schemaVersion must be 1')
      const parsed = AutomationDefinitionV3Schema.parse(entry.definition) as AutomationDefinitionV3
      id = parsed.id
      if (!Array.isArray(entry.dependencies)) throw new Error('Portable Automation dependencies must be an array')
      const declaredDependencies = entry.dependencies.map(dependency => (
        AutomationDependencyDeclarationV1Schema.parse(dependency) as AutomationDependencyDeclarationV1
      ))
      const normalized = portableAutomationDefinition(parsed, [])
      const dependencies = [...new Map([
        ...declaredDependencies,
        ...normalized.dependencies,
      ].map(dependency => [JSON.stringify(dependency), dependency])).values()]
      const missing: AutomationDependencyDeclarationV1[] = []
      for (const dependency of dependencies) {
        if (!dependencyResolver || !await dependencyResolver.isAvailable(dependency)) missing.push(dependency)
      }
      const desiredEnabled = parsed.configuration?.desiredEnabled ?? parsed.enabled
      const definition = structuredClone(normalized.definition)
      if (missing.length > 0) {
        definition.enabled = false
        definition.configuration = { status: 'incomplete', desiredEnabled, missingDependencies: missing }
      } else {
        definition.enabled = desiredEnabled
        delete definition.configuration
      }
      const imported = host.importDefinitions([definition], mode)
      if (imported.skipped.length > 0) {
        result.skipped.push(id)
        result.items.push({ id, status: 'skipped' })
      } else {
        result.imported.push(id)
        result.items.push({
          id,
          status: missing.length > 0 ? 'imported-disabled' : 'imported',
          ...(missing.length > 0 ? { missingDependencies: missing } : {}),
        })
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      result.failed.push({ id, error })
      result.items.push({ id, status: 'failed', error })
    }
  }
  return result
}
