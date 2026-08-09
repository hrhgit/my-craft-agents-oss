import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MORTISE_PROJECT_DIR,
  MORTISE_PROJECT_EXTENSIONS_DIR,
  MORTISE_PROJECT_SETTINGS_FILE,
  MORTISE_PROJECT_SKILLS_DIR,
  MORTISE_SESSIONS_DIR,
  resolveMortiseAgentDir,
} from '../paths.ts';
import { ConfigWatcher } from '../watcher.ts';
import { detectConfigFileType } from '../validators.ts';
import { getWorkspaceSessionsDir, getWorkspaceSkillsPath } from '../../workspaces/storage.ts';

describe('Mortise project skill paths', () => {
  it('honors the explicit Pi Agent root without loading the Pi runtime', () => {
    const configDir = join(tmpdir(), 'mortise-config-root');
    const agentDir = join(tmpdir(), 'mortise-agent-root');

    expect(resolveMortiseAgentDir({ MORTISE_CONFIG_DIR: configDir })).toBe(join(configDir, 'agent'));
    expect(resolveMortiseAgentDir({
      MORTISE_CONFIG_DIR: configDir,
      MORTISE_AGENT_DIR: `  ${agentDir}  `,
    })).toBe(agentDir);
  });

  it('publishes only Mortise-owned project resource paths', () => {
    const root = join(tmpdir(), 'mortise-project-paths');

    expect(MORTISE_PROJECT_DIR).toBe('.mortise');
    expect(MORTISE_PROJECT_SETTINGS_FILE).toBe('.mortise/settings.json');
    expect(MORTISE_PROJECT_SKILLS_DIR).toBe('.mortise/skills');
    expect(MORTISE_PROJECT_EXTENSIONS_DIR).toBe('.mortise/extensions');
    expect(getWorkspaceSkillsPath(root)).toBe(join(root, '.mortise', 'skills'));
    expect(getWorkspaceSessionsDir('workspace-test').startsWith(MORTISE_SESSIONS_DIR)).toBe(true);
  });

  it('detects only .mortise/skills as the active project skill config path', () => {
    const root = join(tmpdir(), 'mortise-skill-detection');
    expect(detectConfigFileType(join(root, '.mortise', 'skills', 'review', 'SKILL.md'), root)).toEqual({
      type: 'skill',
      slug: 'review',
      displayFile: '.mortise/skills/review/SKILL.md',
    });
    expect(detectConfigFileType(join(root, '.pi', 'skills', 'review', 'SKILL.md'), root)).toBeNull();
    expect(detectConfigFileType(join(root, 'skills', 'review', 'SKILL.md'), root)).toBeNull();
  });

  it('routes .mortise/skills watcher events and ignores retired project skill paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-skill-watcher-'));
    const slug = 'watcher-mortise-skill';
    const skillDir = join(root, '.mortise', 'skills', slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: Watcher Mortise Skill',
      'description: Test skill watcher routing.',
      '---',
      '',
      'Follow the test instructions.',
    ].join('\n'));

    const changed: string[] = [];
    const watcher = new ConfigWatcher(root, {
      onSkillChange: (changedSlug) => changed.push(changedSlug),
    });
    const testWatcher = watcher as unknown as {
      handleWorkspaceFileChange(relativePath: string, eventType: string): void;
    };

    testWatcher.handleWorkspaceFileChange(`skills/${slug}/SKILL.md`, 'change');
    testWatcher.handleWorkspaceFileChange(`.pi/skills/${slug}/SKILL.md`, 'change');
    testWatcher.handleWorkspaceFileChange(`.mortise/skills/${slug}/SKILL.md`, 'change');
    await Bun.sleep(150);

    expect(changed).toEqual([slug]);
    rmSync(root, { recursive: true, force: true });
  });
});
