/**
 * Tests for content-based config validators used by PreToolUse hook.
 * These validators check file content in memory before it reaches disk.
 */
import { describe, it, expect } from 'bun:test';
import {
  validateSkillContent,
  validatePermissionsContent,
  validateToolIconsContent,
  detectConfigFileType,
  detectAppConfigFileType,
  validateConfigFileContent,
} from '../src/config/validators.ts';
import { CONFIG_DIR } from '../src/config/paths.ts';

// ============================================================
// validateSkillContent
// ============================================================

describe('validateSkillContent', () => {
  it('passes for valid SKILL.md content', () => {
    const content = `---
name: My Skill
description: A test skill for testing
---

# Instructions

Do things.
`;
    const result = validateSkillContent(content, 'my-skill');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes with optional fields (globs, alwaysAllow)', () => {
    const content = `---
name: Git Helper
description: Helps with git operations
globs:
  - "**/*.ts"
alwaysAllow:
  - Bash
---

Help with git.
`;
    const result = validateSkillContent(content, 'git-helper');
    expect(result.valid).toBe(true);
  });

  it('fails when frontmatter is missing name', () => {
    const content = `---
description: A skill without a name
---

Content here.
`;
    const result = validateSkillContent(content, 'test-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'name')).toBe(true);
  });

  it('fails when frontmatter is missing description', () => {
    const content = `---
name: Test Skill
---

Content here.
`;
    const result = validateSkillContent(content, 'test-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'description')).toBe(true);
  });

  it('fails when body is empty', () => {
    const content = `---
name: Empty Skill
description: This skill has no body
---
`;
    const result = validateSkillContent(content, 'empty-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('empty'))).toBe(true);
  });

  it('fails when slug has invalid characters', () => {
    const content = `---
name: Test
description: Test skill
---

Content.
`;
    const result = validateSkillContent(content, 'Invalid_Slug');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Slug'))).toBe(true);
  });

  it('fails for invalid YAML frontmatter', () => {
    const content = `---
name: [invalid yaml
  unclosed: {bracket
---

Content.
`;
    const result = validateSkillContent(content, 'test-skill');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('frontmatter');
  });
});

// ============================================================
// validatePermissionsContent
// ============================================================

describe('validatePermissionsContent', () => {
  it('passes for valid permissions config', () => {
    const config = JSON.stringify({
      allowedBashPatterns: ['git status', 'npm test'],
      allowedMcpPatterns: ['mcp__session__.*'],
    });
    const result = validatePermissionsContent(config);
    expect(result.valid).toBe(true);
  });

  it('passes for empty object (all fields optional)', () => {
    const result = validatePermissionsContent('{}');
    expect(result.valid).toBe(true);
  });

  it('passes with object-form patterns (pattern + comment)', () => {
    const config = JSON.stringify({
      allowedBashPatterns: [
        { pattern: 'git .*', comment: 'Allow git commands' },
        'npm test',
      ],
    });
    const result = validatePermissionsContent(config);
    expect(result.valid).toBe(true);
  });

  it('fails for invalid JSON', () => {
    const result = validatePermissionsContent('{{bad}}');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Invalid JSON');
  });

  it('fails for invalid regex patterns', () => {
    const config = JSON.stringify({
      allowedBashPatterns: ['[invalid regex('],
    });
    const result = validatePermissionsContent(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('uses custom displayFile for error messages', () => {
    const result = validatePermissionsContent('bad', 'workspace/permissions.json');
    expect(result.errors[0].file).toBe('workspace/permissions.json');
  });
});

// ============================================================
// validateToolIconsContent
// ============================================================

describe('validateToolIconsContent', () => {
  it('passes for valid tool icon mappings', () => {
    const config = JSON.stringify({
      version: 1,
      tools: [{
        id: 'git-tool',
        displayName: 'Git',
        icon: 'git.svg',
        commands: ['git'],
      }],
    });
    const result = validateToolIconsContent(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================
// detectConfigFileType
// ============================================================

describe('detectConfigFileType', () => {
  const workspaceRoot = '/Users/test/.mortise/workspaces/ws-123';

  it('detects skill SKILL.md files', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/.pi/skills/commit/SKILL.md`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('skill');
    expect(result!.slug).toBe('commit');
    expect(result!.displayFile).toBe('.pi/skills/commit/SKILL.md');
  });

  it('detects workspace-level permissions.json', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/permissions.json`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('permissions');
    expect(result!.displayFile).toBe('permissions.json');
  });

  it('detects workspace-level automations.json', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/automations.json`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('automations');
    expect(result!.displayFile).toBe('automations.json');
  });

  it('returns null for files outside workspace root', () => {
    const result = detectConfigFileType(
      '/some/other/path/config.json',
      workspaceRoot
    );
    expect(result).toBeNull();
  });

  it('returns null for non-config files in workspace', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/notes/guide.md`,
      workspaceRoot
    );
    expect(result).toBeNull();
  });

  it('returns null for nested non-matching paths', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/nested/deep/config.json`,
      workspaceRoot
    );
    expect(result).toBeNull();
  });
});

// ============================================================
// detectAppConfigFileType
// ============================================================

describe('detectAppConfigFileType', () => {
  it('detects app-level tool icon mappings', () => {
    const result = detectAppConfigFileType(`${CONFIG_DIR}/tool-icons/tool-icons.json`);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('tool-icons');
    expect(result!.displayFile).toBe('tool-icons/tool-icons.json');
  });
});

// ============================================================
// validateConfigFileContent (dispatch)
// ============================================================

describe('validateConfigFileContent', () => {
  it('dispatches to skill validator', () => {
    const detection = { type: 'skill' as const, slug: 'my-skill', displayFile: '.pi/skills/my-skill/SKILL.md' };
    const content = `---
name: Test
description: Test skill
---

Content here.
`;
    const result = validateConfigFileContent(detection, content);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('dispatches to permissions validator', () => {
    const detection = { type: 'permissions' as const, displayFile: 'permissions.json' };
    const result = validateConfigFileContent(detection, '{}');
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('dispatches to automations validator', () => {
    const detection = { type: 'automations' as const, displayFile: 'automations.json' };
    const result = validateConfigFileContent(detection, JSON.stringify({
      version: 1,
      automations: {},
    }));
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('dispatches to tool icon validator', () => {
    const detection = { type: 'tool-icons' as const, displayFile: 'tool-icons/tool-icons.json' };
    const result = validateConfigFileContent(detection, JSON.stringify({
      version: 1,
      tools: [],
    }));
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('returns validation errors for invalid content', () => {
    const detection = { type: 'permissions' as const, displayFile: 'permissions.json' };
    const result = validateConfigFileContent(detection, '{ not valid json }');
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
  });
});
