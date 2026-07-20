/**
 * Resource Bundle Types
 *
 * Portable format for exporting/importing workspace resources
 * (skills and automations) between workspaces.
 *
 * Follows the same bundle pattern as session export/import.
 */

import type { BundleFile } from '../utils/bundle-files.ts'
import type { AutomationMatcher } from '../automations/types.ts'

// ============================================================
// Bundle Format
// ============================================================

/**
 * Portable representation of workspace resources.
 * JSON envelope with base64-encoded files — same pattern as SessionBundle.
 */
export interface ResourceBundle {
  /** Bundle format version */
  version: 1
  /** When the bundle was created (Unix timestamp ms) */
  exportedAt: number
  /** Informational: name of the workspace this was exported from */
  sourceWorkspace?: string
  /** The exported resources */
  resources: {
    skills?: SkillBundleEntry[]
    /** Per-automation entries (sanitized — webhook auth stripped) */
    automations?: AutomationBundleEntry[]
  }
}

/**
 * A skill in the bundle.
 * Files include everything in the skill folder (SKILL.md, icons, scripts, docs, etc.).
 * No separate metadata field — derive from SKILL.md at read time if needed.
 */
export interface SkillBundleEntry {
  /** Skill slug (folder name) */
  slug: string
  /** All non-hidden regular files in the skill directory */
  files: BundleFile[]
}

/**
 * An automation in the bundle.
 * Matcher config is sanitized (webhook auth stripped).
 */
export interface AutomationBundleEntry {
  /** Automation ID (6-char hex from automations.json) */
  id: string
  /** Display name (denormalized from matcher.name — metadata only, not used for identity) */
  name?: string
  /** Event type this automation is registered under */
  event: string
  /** The full matcher config (sanitized — webhook auth stripped) */
  matcher: AutomationMatcher
}

// ============================================================
// Import/Export Options & Results
// ============================================================

/**
 * Global import conflict mode for v1.
 * - 'skip': Keep existing resources, don't overwrite
 * - 'overwrite': Replace existing resources with imported ones
 */
export type ResourceImportMode = 'skip' | 'overwrite'

/**
 * Options for resource export.
 */
export interface ExportResourcesOptions {
  /** Skill slugs to export, or 'all' for every skill */
  skills?: string[] | 'all'
  /** Automation IDs/names to export, 'all' for every automation, or true (= 'all') */
  automations?: boolean | string[] | 'all'
}

/**
 * Result of a resource export.
 */
export interface ExportResult {
  bundle: ResourceBundle
  /** Export-time warnings (skipped resources, stripped secrets, non-portable paths, etc.) */
  warnings: string[]
}

/**
 * Per-resource-type import result with room for partial failures.
 */
export interface ImportBucketResult {
  /** Identifiers that were successfully imported (slugs for skills, IDs for automations) */
  imported: string[]
  /** Identifiers that were skipped (already exist + mode='skip') */
  skipped: string[]
  /** Identifiers that failed with an error */
  failed: Array<{ id: string; error: string }>
  /** Warnings (non-fatal issues) */
  warnings: string[]
}

/**
 * Result of a resource import.
 */
export interface ResourceImportResult {
  skills: ImportBucketResult
  automations: ImportBucketResult
}
