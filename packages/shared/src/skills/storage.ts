/**
 * Skills storage facade.
 *
 * Pi owns skill discovery and parsing. Mortise keeps these synchronous helpers as
 * stable UI/server seams and delegates catalog reads to Pi's host facade.
 */

import { existsSync, rmSync } from 'fs';
import { basename } from 'path';
import {
  listSkillsSync as listPiSkillsSync,
  type HostSkillSummary,
} from '@mortise/pi-coding-agent/host-facade';
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts';
import { validateSlug } from '../config/validators.ts';
import { isPathWithinDirectory } from '../utils/paths.ts';
import {
  validateIconValue,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Slug validation (path-traversal defense)
// ============================================================

export function validateSkillSlug(slug: unknown): string | null {
  if (!slug || typeof slug !== 'string') return null;
  if (basename(slug) !== slug) return null;
  if (!validateSlug(slug).valid) return null;
  return slug;
}

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
      .filter(Boolean),
  ));

  return normalized.length > 0 ? normalized : undefined;
}

function metadataFromHostSkill(skill: HostSkillSummary): SkillMetadata {
  const frontmatter = skill.frontmatter ?? {};
  return {
    name: skill.name,
    description: skill.description,
    globs: Array.isArray(frontmatter.globs) ? frontmatter.globs.filter((entry): entry is string => typeof entry === 'string') : undefined,
    alwaysAllow: Array.isArray(frontmatter.alwaysAllow) ? frontmatter.alwaysAllow.filter((entry): entry is string => typeof entry === 'string') : undefined,
    icon: validateIconValue(frontmatter.icon, 'Skills'),
    requiredSources: normalizeRequiredSources(frontmatter.requiredSources),
  };
}

function sourceFromHostSkill(skill: HostSkillSummary): SkillSource {
  return skill.sourceInfo.scope === 'project' ? 'project' : 'global';
}

function toLoadedSkill(skill: HostSkillSummary): LoadedSkill {
  return {
    slug: skill.slug,
    metadata: metadataFromHostSkill(skill),
    content: skill.body,
    iconPath: skill.iconPath,
    path: skill.baseDir,
    source: sourceFromHostSkill(skill),
  };
}

function listHostSkills(projectRoot?: string): ReturnType<typeof listPiSkillsSync> {
  return listPiSkillsSync({ cwd: projectRoot });
}

// ============================================================
// Active skills tiers
// ============================================================

export function getActiveSkillsTiers(
  workspaceRoot: string,
  projectRoot?: string,
): Array<{ dir: string; source: SkillSource }> {
  const roots = listHostSkills(projectRoot ?? workspaceRoot).skillRoots;
  return roots.map((dir, index) => ({
    dir,
    source: index === 0 ? 'global' : 'project',
  }));
}

export function resolveSkillDir(
  slug: string,
  workspaceRoot: string,
  projectRoot?: string,
): string | null {
  const skill = loadSkillBySlug(workspaceRoot, slug, projectRoot);
  return skill?.path ?? null;
}

// ============================================================
// Load operations
// ============================================================

export function loadSkill(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  if (validateSkillSlug(slug) === null) return null;
  return loadSkillBySlug(workspaceRoot, slug, projectRoot);
}

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const SKILLS_CACHE_TTL = 30_000;

export function invalidateSkillsCache(): void {
  skillsCache.clear();
}

export function loadAllSkills(workspaceRoot: string, projectRoot?: string): LoadedSkill[] {
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}`;
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills;
  }

  const result = listHostSkills(projectRoot ?? workspaceRoot).skills.map(toLoadedSkill);
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return result;
}

export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  if (validateSkillSlug(slug) === null) return null;
  const result = listHostSkills(projectRoot ?? workspaceRoot).skills.find(skill => skill.slug === slug);
  return result ? toLoadedSkill(result) : null;
}

// ============================================================
// Delete operations
// ============================================================

export function deleteSkill(workspaceRoot: string, slug: string, projectRoot?: string): boolean {
  if (validateSkillSlug(slug) === null) return false;

  const skillDir = resolveSkillDir(slug, workspaceRoot, projectRoot);
  if (!skillDir) return false;

  const tiers = getActiveSkillsTiers(workspaceRoot, projectRoot);
  const isWithinTier = tiers.some(tier => isPathWithinDirectory(skillDir, tier.dir));
  if (!isWithinTier) return false;

  try {
    rmSync(skillDir, { recursive: true });
    invalidateSkillsCache();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Utility functions
// ============================================================

export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillDir = resolveSkillDir(slug, workspaceRoot, workspaceRoot);
  return Boolean(skillDir && existsSync(skillDir));
}

export function listSkillSlugs(workspaceRoot: string, projectRoot?: string): string[] {
  return listHostSkills(projectRoot ?? workspaceRoot).skills.map(skill => skill.slug);
}

export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string,
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

export { isIconUrl } from '../utils/icon.ts';
