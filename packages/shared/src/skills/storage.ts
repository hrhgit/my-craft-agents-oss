/**
 * Skills Storage
 *
 * CRUD operations for skills. Pi/Craft 一体化后层级为：
 * - Global:  ~/.pi/agent/skills/                       (source: 'global')
 * - Project: {projectRoot}/.pi/skills/                 (source: 'project')
 *
 * workspaceRootPath 仅用于 API 兼容（deleteSkill 的 defense-in-depth 检查等），
 * 不再参与 skill 路径解析。
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { basename, join } from 'path';
import matter from 'gray-matter';
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts';
import { PI_SKILLS_DIR, PI_PROJECT_SKILLS_DIR } from '../config/paths.ts';
import { validateSlug } from '../config/validators.ts';
import { isPathWithinDirectory } from '../utils/paths.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Slug validation (path-traversal defense)
// ============================================================

/**
 * Validate a skill slug for safe filesystem operations.
 *
 * Returns the slug if it is safe to use as a directory name, or null
 * otherwise. Returning null matches the "not found" semantics used by
 * callers, keeping the public API backward-compatible (no thrown errors).
 *
 * Checks (defense-in-depth):
 * 1. Non-empty string.
 * 2. `basename(slug) === slug` — rejects any slug that contains path
 *    separators or leading directory components (e.g. `../etc`, `a/b`).
 * 3. `validateSlug(slug)` — reuses the canonical slug validator from
 *    `@craft-agent/shared/config`, which only permits lowercase
 *    alphanumeric + hyphens. This also rejects `.`, `/`, `\`, and any
 *    other characters that could enable traversal.
 */
export function validateSkillSlug(slug: unknown): string | null {
  if (!slug || typeof slug !== 'string') return null;
  // Reject slugs containing path separators/components. basename() strips
  // any leading directory components; if it differs from the input, the
  // slug had separators.
  if (basename(slug) !== slug) return null;
  // Reuse the canonical slug validator (lowercase alphanumeric + hyphens).
  if (!validateSlug(slug).valid) return null;
  return slug;
}

// ============================================================
// Active skills tiers (unified Pi native paths)
// ============================================================

/**
 * Returns the active skill directories (with source labels).
 *
 * Unified two-tier layout (Pi native paths):
 * - Global:  ~/.pi/agent/skills/                       (source: 'global')
 * - Project: {projectRoot}/.pi/skills/                 (source: 'project')  [when provided]
 *
 * Tiers are listed in ascending priority order (later entries override
 * earlier ones by slug). This layout is mode-independent — Craft and Pi
 * shell mode share the same skill roots. No 'workspace' tier exists anymore.
 *
 * @param workspaceRoot - Absolute path to the Craft workspace metadata folder.
 *   Retained for API compatibility; not used for path resolution in the
 *   unified layout (workspace-level skills now live under {projectRoot}/.pi/skills/).
 * @param projectRoot - Optional project root (working directory) for project-level skills.
 */
export function getActiveSkillsTiers(
  workspaceRoot: string,
  projectRoot?: string,
): Array<{ dir: string; source: SkillSource }> {
  const tiers: Array<{ dir: string; source: SkillSource }> = [
    { dir: PI_SKILLS_DIR, source: 'global' }, // Pi global (~/.pi/agent/skills/)
  ];
  if (projectRoot) {
    tiers.push({ dir: join(projectRoot, PI_PROJECT_SKILLS_DIR), source: 'project' });
  }
  return tiers;
}

/**
 * Resolve a skill slug to its directory across active tiers (highest priority
 * first). Returns null if not found or if the slug is invalid/unsafe.
 */
export function resolveSkillDir(
  slug: string,
  workspaceRoot: string,
  projectRoot?: string,
): string | null {
  // Validate slug to prevent path traversal (e.g. `../../../../etc`).
  if (validateSkillSlug(slug) === null) return null;

  const tiers = getActiveSkillsTiers(workspaceRoot, projectRoot);
  // Search in descending priority (project > workspace/global)
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i];
    if (!tier) continue;
    const skillDir = join(tier.dir, slug);
    if (existsSync(skillDir) && statSync(skillDir).isDirectory()) {
      return skillDir;
    }
  }
  return null;
}

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  const normalized = Array.from(new Set(
    asArray
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse SKILL.md content and extract frontmatter + body
 */
function parseSkillFile(content: string): { metadata: SkillMetadata; body: string } | null {
  try {
    const parsed = matter(content);

    // Validate required fields
    if (!parsed.data.name || !parsed.data.description) {
      return null;
    }

    // Validate and extract optional icon field
    // Only accepts emoji or URL - rejects inline SVG and relative paths
    const icon = validateIconValue(parsed.data.icon, 'Skills');

    return {
      metadata: {
        name: parsed.data.name as string,
        description: parsed.data.description as string,
        globs: parsed.data.globs as string[] | undefined,
        alwaysAllow: parsed.data.alwaysAllow as string[] | undefined,
        icon,
        requiredSources: normalizeRequiredSources(parsed.data.requiredSources),
      },
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(skillsDir: string, slug: string, source: SkillSource): LoadedSkill | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // Check directory exists
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null;
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null;
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
  };
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(skillsDir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills;
}

/**
 * Load a single skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function loadSkill(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  // Validate slug to prevent path traversal.
  if (validateSkillSlug(slug) === null) return null;
  return loadSkillBySlug(workspaceRoot, slug, projectRoot);
}

// ── Skills cache ────────────────────────────────────────────────────────
// loadAllSkills reads from up to 3 directories on every call (~100ms).
// The result rarely changes during a session, so we cache it per
// (workspaceRoot, projectRoot) pair with a short safety TTL.
//
// F17: TTL lowered from 5 minutes to 30 seconds. External pi CLI / manual
// skill creation must become visible quickly without waiting for a full
// cache invalidation hook on every workspace/session switch. 30s keeps the
// perf benefit for hot loops while bounding staleness for externally
// created skills.

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const SKILLS_CACHE_TTL = 30_000; // 30 seconds (F17: was 5 * 60_000)

/** Invalidate the skills cache (call on working dir change or skill file events). */
export function invalidateSkillsCache(): void {
  skillsCache.clear();
}

/**
 * Load all skills from all sources (global, project)
 * Skills with the same slug are overridden by higher-priority sources.
 * Priority: global (lowest) < project (highest)
 *
 * Results are cached per (workspaceRoot, projectRoot) pair. Call
 * invalidateSkillsCache() on working directory changes or skill file events.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param projectRoot - Optional project root (working directory) for project-level skills
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string): LoadedSkill[] {
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}`;
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills;
  }

  const skillsBySlug = new Map<string, LoadedSkill>();

  // Load from active tiers (Craft or Pi shell mode) in ascending priority order
  const tiers = getActiveSkillsTiers(workspaceRoot, projectRoot);
  for (const { dir, source } of tiers) {
    for (const skill of loadSkillsFromDir(dir, source)) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  const result = Array.from(skillsBySlug.values());
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return result;
}

/**
 * Load a single skill by slug from all sources (project > global).
 * Unlike loadAllSkills(), this only reads the specific slug directory — O(1) not O(N).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill slug to load
 * @param projectRoot - Optional project root for project-level skills
 */
export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  // Validate slug to prevent path traversal.
  if (validateSkillSlug(slug) === null) return null;

  // Search active tiers in descending priority (project > global)
  const tiers = getActiveSkillsTiers(workspaceRoot, projectRoot);
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i];
    if (!tier) continue;
    const skill = loadSkillFromDir(tier.dir, slug, tier.source);
    if (skill) return skill;
  }
  return null;
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete a skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function deleteSkill(workspaceRoot: string, slug: string, projectRoot?: string): boolean {
  // Validate slug to prevent path traversal (e.g. `../../../../etc`).
  if (validateSkillSlug(slug) === null) return false;

  const skillDir = resolveSkillDir(slug, workspaceRoot, projectRoot);
  if (!skillDir) return false;

  // Defense-in-depth: confirm skillDir is within a legitimate tier before
  // recursive deletion. This guards against any logical bypass in path
  // resolution and prevents deleting arbitrary directories.
  const tiers = getActiveSkillsTiers(workspaceRoot, projectRoot);
  const isWithinTier = tiers.some(tier => isPathWithinDirectory(skillDir, tier.dir));
  if (!isWithinTier) return false;

  try {
    rmSync(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a skill exists in active tiers (global + project).
 *
 * Searches active Pi tiers via resolveSkillDir (project > global priority).
 * workspaceRootPath 用于读取 workspace config 解析 projectRoot；
 * 若 config 缺失则 projectRoot 退化为 workspaceRoot（即搜索 {workspaceRoot}/.pi/skills/）。
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  // Validate slug to prevent path traversal (also enforced inside
  // resolveSkillDir, repeated here as defense-in-depth).
  if (validateSkillSlug(slug) === null) return false;

  const projectRoot = workspaceRoot;
  const skillDir = resolveSkillDir(slug, workspaceRoot, projectRoot);
  return Boolean(skillDir && existsSync(join(skillDir, 'SKILL.md')));
}

/**
 * List skill slugs in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function listSkillSlugs(workspaceRoot: string, projectRoot?: string): string[] {
  const tiers = getActiveSkillsTiers(workspaceRoot, projectRoot);
  const slugs = new Set<string>();
  for (const { dir } of tiers) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(dir, entry.name, 'SKILL.md');
        if (existsSync(skillFile)) {
          slugs.add(entry.name);
        }
      }
    } catch {
      // Ignore errors reading skills directory
    }
  }
  return Array.from(slugs);
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';
