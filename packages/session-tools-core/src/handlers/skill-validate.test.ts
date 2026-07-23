import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import { getResultText } from '../types.ts';
import { handleSkillValidate } from './skill-validate.ts';

describe('skill_validate injected skill roots', () => {
  let root: string;
  let globalRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-validate-'));
    globalRoot = join(root, 'global');
    projectRoot = join(root, 'project');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(baseDir: string, slug: string, name: string): void {
    const skillDir = join(baseDir, slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test skill\n---\n\nUse this skill.\n`
    );
  }

  function createContext(skillPaths: string[]): SessionToolContext {
    return {
      sessionId: 'session-1',
      workspacePath: root,
      skillsPath: skillPaths[0] ?? '',
      skillPaths,
      plansFolderPath: join(root, 'plans'),
      callbacks: { onPlanSubmitted: () => {} },
      fs: {
        exists: (path) => {
          try {
            return statSync(path).isFile();
          } catch {
            return false;
          }
        },
        readFile: (path) => readFileSync(path, 'utf8'),
        readFileBuffer: (path) => readFileSync(path),
        writeFile: (path, content) => writeFileSync(path, content),
        isDirectory: (path) => {
          try {
            return statSync(path).isDirectory();
          } catch {
            return false;
          }
        },
        readdir: () => [],
        stat: (path) => {
          const stats = statSync(path);
          return { size: stats.size, isDirectory: () => stats.isDirectory() };
        },
      },
    };
  }

  it('prefers later project roots over the global root', async () => {
    writeSkill(globalRoot, 'demo', 'Global Demo');
    writeSkill(projectRoot, 'demo', 'Project Demo');

    const result = await handleSkillValidate(createContext([globalRoot, projectRoot]), {
      skillSlug: 'demo',
    });

    expect(result.isError).toBe(false);
    expect(getResultText(result)).toContain(`Validated from project tier: ${join(projectRoot, 'demo', 'SKILL.md')}`);
  });

  it('labels the first injected root as global', async () => {
    writeSkill(globalRoot, 'demo', 'Global Demo');

    const result = await handleSkillValidate(createContext([globalRoot]), { skillSlug: 'demo' });

    expect(result.isError).toBe(false);
    expect(getResultText(result)).toContain(`Validated from global tier: ${join(globalRoot, 'demo', 'SKILL.md')}`);
  });

  it('reports every injected root when a skill is absent', async () => {
    const result = await handleSkillValidate(createContext([globalRoot, projectRoot]), {
      skillSlug: 'missing',
    });
    const text = getResultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain(`${join(projectRoot, 'missing', 'SKILL.md')} (project)`);
    expect(text).toContain(`${join(globalRoot, 'missing', 'SKILL.md')} (global)`);
  });
});
