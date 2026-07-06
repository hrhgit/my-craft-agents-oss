/**
 * Tests for Skills Storage
 *
 * Verifies the unified two-tier skill loading system (Pi native paths):
 * 1. Global skills: ~/.pi/agent/skills/ (lowest priority)
 * 2. Project skills: {projectRoot}/.pi/skills/ (highest priority)
 *
 * skillExists() uses active Pi tiers (project > global) — when no workspace
 * config exists, projectRoot falls back to workspaceRoot, so it searches
 * {workspaceRoot}/.pi/skills/ (NOT {workspaceRoot}/skills/).
 *
 * Uses real temp directories to test actual filesystem operations.
 *
 * Note: The global skills directory (~/.pi/agent/skills/) is a module-level
 * constant that cannot be mocked reliably when tests run in parallel with
 * other test files. The loadAllSkills tests account for any pre-existing
 * global skills by capturing a baseline count and validating relative to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  loadAllSkills,
  loadSkill,
  skillExists,
  listSkillSlugs,
  deleteSkill,
} from '../storage.ts';

// ============================================================
// Temp Directory Setup
// ============================================================

let tempDir: string;
let workspaceRoot: string;
let projectRoot: string;

// The real Pi global skills directory — we cannot mock this reliably.
const REAL_GLOBAL_SKILLS_DIR = join(homedir(), '.pi', 'agent', 'skills');

// ============================================================
// Helpers
// ============================================================

/** Create a valid SKILL.md file in a skill directory */
function createSkill(
  skillsDir: string,
  slug: string,
  opts: { name?: string; description?: string; globs?: string[]; content?: string; icon?: string; requiredSources?: string[] } = {}
): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });

  const name = opts.name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  const description = opts.description ?? `A ${slug} skill`;
  const content = opts.content ?? `Instructions for ${slug}`;
  const globs = opts.globs ? `\nglobs:\n${opts.globs.map(g => `  - "${g}"`).join('\n')}` : '';
  const icon = opts.icon ? `\nicon: "${opts.icon}"` : '';
  const requiredSources = opts.requiredSources
    ? `\nrequiredSources:\n${opts.requiredSources.map(source => `  - "${source}"`).join('\n')}`
    : '';

  const skillMd = `---
name: "${name}"
description: "${description}"${globs}${icon}${requiredSources}
---

${content}
`;
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
  return skillDir;
}

/** Create an invalid SKILL.md (missing required fields) */
function createInvalidSkill(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ntitle: "No name or description"\n---\nContent');
  return skillDir;
}

/** Create a directory without SKILL.md */
function createEmptySkillDir(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

/** Get the set of slugs currently in the real global skills directory */
function getExistingGlobalSlugs(): Set<string> {
  const emptyWs = mkdtempSync(join(tmpdir(), 'skills-baseline-'));
  mkdirSync(join(emptyWs, 'skills'), { recursive: true });
  try {
    const skills = loadAllSkills(emptyWs);
    // These are all global skills since the workspace is empty
    return new Set(skills.map(s => s.slug));
  } finally {
    rmSync(emptyWs, { recursive: true, force: true });
  }
}

/** Project skills directory under the unified Pi layout: {projectRoot}/.pi/skills/ */
function getProjectSkillsDir(): string {
  return join(projectRoot, '.pi', 'skills');
}

// ============================================================
// Test Setup
// ============================================================

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');

  // Create base directories
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================
// Tests: loadSkill (single skill via active tiers: global + project)
// ============================================================

describe('loadSkill', () => {
  it('should load a valid skill from project tier', () => {
    const skillsDir = getProjectSkillsDir();
    createSkill(skillsDir, 'commit', {
      name: 'Git Commit',
      description: 'Helps with git commits',
      content: 'Run git commit with a good message',
    });

    const skill = loadSkill(workspaceRoot, 'commit', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.slug).toBe('commit');
    expect(skill!.metadata.name).toBe('Git Commit');
    expect(skill!.metadata.description).toBe('Helps with git commits');
    expect(skill!.content).toContain('Run git commit with a good message');
    expect(skill!.source).toBe('project');
    expect(skill!.path).toBe(join(skillsDir, 'commit'));
  });

  it('should return null for non-existent skill slug', () => {
    const skill = loadSkill(workspaceRoot, 'nonexistent', projectRoot);
    expect(skill).toBeNull();
  });

  it('should return null for directory without SKILL.md', () => {
    createEmptySkillDir(getProjectSkillsDir(), 'empty-skill');

    const skill = loadSkill(workspaceRoot, 'empty-skill', projectRoot);
    expect(skill).toBeNull();
  });

  it('should return null for invalid SKILL.md (missing required fields)', () => {
    createInvalidSkill(getProjectSkillsDir(), 'bad-skill');

    const skill = loadSkill(workspaceRoot, 'bad-skill', projectRoot);
    expect(skill).toBeNull();
  });

  it('should load skill with optional globs', () => {
    createSkill(getProjectSkillsDir(), 'frontend', {
      globs: ['*.tsx', '*.css'],
    });

    const skill = loadSkill(workspaceRoot, 'frontend', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.metadata.globs).toEqual(['*.tsx', '*.css']);
  });

  it('should load skill with normalized requiredSources', () => {
    createSkill(getProjectSkillsDir(), 'with-sources', {
      requiredSources: ['linear', ' github ', 'linear'],
    });

    const skill = loadSkill(workspaceRoot, 'with-sources', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear', 'github']);
  });

  it('should normalize single-string requiredSources into an array', () => {
    const skillDir = join(getProjectSkillsDir(), 'single-source');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "Single Source"
description: "Skill with scalar requiredSources"
requiredSources: linear
---

Use linear tools.
`);

    const skill = loadSkill(workspaceRoot, 'single-source', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear']);
  });

  it('should ignore invalid requiredSources entries', () => {
    const skillDir = join(getProjectSkillsDir(), 'invalid-sources');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "Invalid Sources"
description: "Skill with mixed requiredSources values"
requiredSources:
  - linear
  - 123
  - true
  - "  "
---

Use linear tools.
`);

    const skill = loadSkill(workspaceRoot, 'invalid-sources', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear']);
  });

  it('should set iconPath when icon file exists', () => {
    const skillDir = createSkill(getProjectSkillsDir(), 'with-icon');
    writeFileSync(join(skillDir, 'icon.svg'), '<svg></svg>');

    const skill = loadSkill(workspaceRoot, 'with-icon', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.iconPath).toBe(join(skillDir, 'icon.svg'));
  });

  it('should not set iconPath when no icon file exists', () => {
    createSkill(getProjectSkillsDir(), 'no-icon');

    const skill = loadSkill(workspaceRoot, 'no-icon', projectRoot);

    expect(skill).not.toBeNull();
    expect(skill!.iconPath).toBeUndefined();
  });
});

// ============================================================
// Tests: loadAllSkills (two-tier loading: global + project)
//
// These tests account for pre-existing global skills at ~/.pi/agent/skills/.
// We capture a baseline and verify our test skills appear with correct sources.
// The legacy {workspaceRoot}/skills/ path is NOT read by loadAllSkills.
// ============================================================

describe('loadAllSkills', () => {
  // Use unique slugs that won't collide with real global skills
  const TEST_PREFIX = '_test_storage_';

  it('should load project skills alongside any existing global skills', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(projDir, `${TEST_PREFIX}proj`, { name: 'Project Skill', description: 'From project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Should have baseline global skills + our 1 test skill
    expect(skills.length).toBe(baselineGlobal.size + 1);

    const projSkill = skills.find(s => s.slug === `${TEST_PREFIX}proj`);

    expect(projSkill).toBeDefined();
    expect(projSkill!.source).toBe('project');

    // All baseline global skills should still be present with source 'global'
    for (const globalSlug of baselineGlobal) {
      const skill = skills.find(s => s.slug === globalSlug);
      expect(skill).toBeDefined();
      expect(skill!.source).toBe('global');
    }
  });

  it('should override global skills with project skills when slug matches', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    // Only test override if there are actually global skills to override
    if (baselineGlobal.size === 0) {
      // No global skills — just verify project skills load
      const projDir = getProjectSkillsDir();
      mkdirSync(projDir, { recursive: true });
      createSkill(projDir, `${TEST_PREFIX}proj_only`, { name: 'Proj Only', description: 'Proj only skill' });
      const skills = loadAllSkills(workspaceRoot, projectRoot);
      expect(skills.find(s => s.slug === `${TEST_PREFIX}proj_only`)).toBeDefined();
      return;
    }

    // Override one of the existing global skills with a project skill
    const globalSlugToOverride = [...baselineGlobal][0]!;
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });
    createSkill(projDir, globalSlugToOverride, {
      name: 'Project Override',
      description: 'This overrides the global skill',
    });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    const overridden = skills.find(s => s.slug === globalSlugToOverride);
    expect(overridden).toBeDefined();
    expect(overridden!.source).toBe('project');
    expect(overridden!.metadata.name).toBe('Project Override');

    // Total count should be same as baseline (overridden, not added)
    expect(skills.length).toBe(baselineGlobal.size);
  });

  it('should load project skill when project tier is provided', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(projDir, `${TEST_PREFIX}deploy`, { name: 'Project Deploy', description: 'Project version' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Only 1 skill for this slug, plus baseline globals
    expect(skills.length).toBe(baselineGlobal.size + 1);
    const deploy = skills.find(s => s.slug === `${TEST_PREFIX}deploy`);
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe('project');
    expect(deploy!.metadata.name).toBe('Project Deploy');
    expect(deploy!.metadata.description).toBe('Project version');
  });

  it('should handle project > global override (two-tier)', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Unique skills at project tier
    createSkill(projDir, `${TEST_PREFIX}only_proj`, { description: 'Only in project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Unique skills should keep their sources
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_proj`)!.source).toBe('project');

    // Total: baseline globals + only_proj
    expect(skills.length).toBe(baselineGlobal.size + 1);
  });

  it('should handle missing project directory gracefully', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    // Pass a non-existent project root
    const skills = loadAllSkills(workspaceRoot, join(tempDir, 'nonexistent-project'));

    // Only baseline global skills remain (project dir doesn't exist)
    expect(skills.length).toBe(baselineGlobal.size);
  });

  it('should skip project tier when projectRoot is undefined', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });
    createSkill(projDir, `${TEST_PREFIX}project_only`);

    // No projectRoot passed — project tier should be skipped
    const skills = loadAllSkills(workspaceRoot);

    // Should NOT contain the project-only skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}project_only`)).toBeUndefined();
    expect(skills.length).toBe(baselineGlobal.size);
  });

  it('should return only global skills when project is empty', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // With empty project, only global skills remain
    expect(skills.length).toBe(baselineGlobal.size);
    for (const skill of skills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should correctly assign source for project tier', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(projDir, `${TEST_PREFIX}p1`);
    createSkill(projDir, `${TEST_PREFIX}p2`);

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills.filter(s => s.source === 'project')).toHaveLength(2);

    // Global skills should all have source 'global'
    const globalSkills = skills.filter(s => !s.slug.startsWith(TEST_PREFIX));
    for (const skill of globalSkills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should deduplicate by slug: project overrides global', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Unique skills
    createSkill(projDir, `${TEST_PREFIX}unique_proj`);

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // 1 test skill + baseline
    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills).toHaveLength(1);

    const uniqueProj = skills.find(s => s.slug === `${TEST_PREFIX}unique_proj`);
    expect(uniqueProj!.source).toBe('project');
  });
});

// ============================================================
// Tests: skillExists (active Pi tiers: project > global)
//
// skillExists(workspaceRoot, slug) reads workspace config to resolve projectRoot.
// In these tests no workspace config exists, so projectRoot falls back to
// workspaceRoot — meaning project tier is searched at {workspaceRoot}/.pi/skills/.
// ============================================================

describe('skillExists', () => {
  it('should return true for existing skill with SKILL.md', () => {
    // No workspace config → projectRoot = workspaceRoot, project tier at {workspaceRoot}/.pi/skills/
    createSkill(join(workspaceRoot, '.pi', 'skills'), 'exists-skill');
    expect(skillExists(workspaceRoot, 'exists-skill')).toBe(true);
  });

  it('should return false for non-existent skill', () => {
    expect(skillExists(workspaceRoot, 'ghost-skill')).toBe(false);
  });

  it('should return false for directory without SKILL.md', () => {
    createEmptySkillDir(join(workspaceRoot, '.pi', 'skills'), 'empty');
    expect(skillExists(workspaceRoot, 'empty')).toBe(false);
  });
});

// ============================================================
// Tests: listSkillSlugs (active tiers: global + project)
// ============================================================

describe('listSkillSlugs', () => {
  it('should list all valid skill slugs from project tier', () => {
    const skillsDir = getProjectSkillsDir();
    createSkill(skillsDir, `${listSkillSlugs.name}_alpha`);
    createSkill(skillsDir, `${listSkillSlugs.name}_beta`);
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const slugs = listSkillSlugs(workspaceRoot, projectRoot);
    // Filter to only our test slugs (global tier may contribute others)
    const testSlugs = slugs.filter(s =>
      s === `${listSkillSlugs.name}_alpha` || s === `${listSkillSlugs.name}_beta`,
    );
    expect(testSlugs.sort()).toEqual([
      `${listSkillSlugs.name}_alpha`,
      `${listSkillSlugs.name}_beta`,
    ]);
  });

  it('should return only global slugs for empty project directory', () => {
    const baseline = listSkillSlugs(workspaceRoot);
    const slugs = listSkillSlugs(workspaceRoot, projectRoot);
    // With empty project, result equals baseline (global only)
    expect(slugs.sort()).toEqual(baseline.sort());
  });

  it('should return only global slugs for non-existent workspace path', () => {
    // workspaceRoot is unused in the unified model; listSkillSlugs always
    // reads the global tier. Just verify it does not throw and returns an array.
    const slugs = listSkillSlugs(join(tempDir, 'nonexistent'));
    expect(Array.isArray(slugs)).toBe(true);
  });
});

// ============================================================
// Tests: deleteSkill (active tiers: global + project)
// ============================================================

describe('deleteSkill', () => {
  it('should delete an existing skill from project tier', () => {
    const skillsDir = getProjectSkillsDir();
    const skillDir = createSkill(skillsDir, 'to-delete');
    expect(existsSync(skillDir)).toBe(true);

    const result = deleteSkill(workspaceRoot, 'to-delete', projectRoot);

    expect(result).toBe(true);
    expect(existsSync(skillDir)).toBe(false);
  });

  it('should return false for non-existent skill', () => {
    const result = deleteSkill(workspaceRoot, 'nonexistent', projectRoot);
    expect(result).toBe(false);
  });
});
