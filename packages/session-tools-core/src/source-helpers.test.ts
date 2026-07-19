import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, setSharedPiSessionsDirForTests } from '@mortise/shared/sessions';
import {
  getSkillPath,
  getSourcePath,
  loadSourceConfig,
  resolveSessionWorkingDirectory,
  sourceExists,
} from './source-helpers.ts';

const tempDirs: string[] = [];

afterEach(() => {
  setSharedPiSessionsDirForTests(undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('source slug path safety', () => {
  it('rejects dot segments that basename() would otherwise accept', () => {
    const workspaceRoot = join('tmp', 'workspace');

    expect(() => getSourcePath(workspaceRoot, '..')).toThrow('Invalid source slug');
    expect(() => getSourcePath(workspaceRoot, '.')).toThrow('Invalid source slug');
    expect(sourceExists(workspaceRoot, '..')).toBe(false);
    expect(loadSourceConfig(workspaceRoot, '..')).toBeNull();
  });
});

describe('Pi-first paths', () => {
  it('resolves project skills under .pi/skills and rejects unsafe slugs', () => {
    const workspaceRoot = join('tmp', 'workspace');
    expect(getSkillPath(workspaceRoot, 'review')).toBe(join(workspaceRoot, '.pi', 'skills', 'review'));
    expect(() => getSkillPath(workspaceRoot, '..')).toThrow('Invalid skill slug');
  });

  it('resolves workingDirectory from the Pi session bucket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-tools-pi-first-'));
    tempDirs.push(root);
    const piSessionsRoot = join(root, 'pi-sessions');
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    setSharedPiSessionsDirForTests(piSessionsRoot);

    const session = await createSession(workspaceRoot);
    expect(resolveSessionWorkingDirectory(workspaceRoot, session.mortiseId)).toBe(workspaceRoot);
  });

  it('does not read a legacy workspace sessions directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-tools-legacy-rejection-'));
    tempDirs.push(root);
    const workspaceRoot = join(root, 'workspace');
    const legacyDir = join(workspaceRoot, 'sessions', 'legacy-session');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'session.jsonl'), JSON.stringify({
      type: 'session',
      version: 3,
      id: 'legacy-session',
      timestamp: new Date(0).toISOString(),
      cwd: workspaceRoot,
      mortise: { id: 'legacy-session', workingDirectory: workspaceRoot },
    }));
    setSharedPiSessionsDirForTests(join(root, 'empty-pi-sessions'));

    expect(resolveSessionWorkingDirectory(workspaceRoot, 'legacy-session')).toBeUndefined();
  });
});
