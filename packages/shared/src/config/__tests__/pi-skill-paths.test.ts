import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigWatcher } from '../watcher.ts';
import { detectConfigFileType } from '../validators.ts';

describe('Pi project skill paths', () => {
  it('detects only .pi/skills as the active project skill config path', () => {
    const root = join(tmpdir(), 'pi-skill-detection');
    expect(detectConfigFileType(join(root, '.pi', 'skills', 'review', 'SKILL.md'), root)).toEqual({
      type: 'skill',
      slug: 'review',
      displayFile: '.pi/skills/review/SKILL.md',
    });
    expect(detectConfigFileType(join(root, 'skills', 'review', 'SKILL.md'), root)).toBeNull();
  });

  it('routes .pi/skills watcher events and ignores the retired skills path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skill-watcher-'));
    const slug = 'watcher-pi-skill';
    const skillDir = join(root, '.pi', 'skills', slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: Watcher Pi Skill',
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
    await Bun.sleep(150);

    expect(changed).toEqual([slug]);
    rmSync(root, { recursive: true, force: true });
  });
});
