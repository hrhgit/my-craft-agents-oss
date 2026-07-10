import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { encodePiSessionCwd } from '@craft-agent/shared/config/paths';
import { setSharedPiSessionsDirForTests } from '@craft-agent/shared/sessions';
import {
  collectSessionSearchRoots,
  serializeExtensionCommandArgs,
} from './session-route-helpers.ts';

function writePiSession(
  root: string,
  cwd: string,
  fileName: string,
  header: Record<string, unknown>,
): string {
  const bucket = join(root, encodePiSessionCwd(cwd));
  mkdirSync(bucket, { recursive: true });
  const filePath = join(bucket, fileName);
  writeFileSync(filePath, `${JSON.stringify(header)}\n`, 'utf-8');
  return filePath;
}

describe('session route helpers', () => {
  let tmpRoot: string;
  let sessionsRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'session-route-helpers-'));
    sessionsRoot = join(tmpRoot, 'pi-sessions');
    workspaceRoot = join(tmpRoot, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    setSharedPiSessionsDirForTests(sessionsRoot);
  });

  it('normalizes omitted extension command args without creating a null prompt', () => {
    expect(serializeExtensionCommandArgs(undefined)).toBeUndefined();
    expect(serializeExtensionCommandArgs(null)).toBeUndefined();
    expect(serializeExtensionCommandArgs('discussion')).toBe('discussion');
    expect(serializeExtensionCommandArgs({ instructions: 'focus' })).toBe('{"instructions":"focus"}');
  });

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collects search roots only from the workspace root bucket', () => {
    writePiSession(sessionsRoot, workspaceRoot, '2026-07-04T10-00-00_session-a.jsonl', {
      type: 'session',
      id: 'session-a',
      timestamp: '2026-07-04T10:00:00.000Z',
      cwd: workspaceRoot,
    });
    const legacyDivergentCwd = join(workspaceRoot, 'project-b');

    const roots = collectSessionSearchRoots(workspaceRoot, [
      { id: 'session-a', workingDirectory: legacyDivergentCwd },
    ]).sort();

    expect(roots).toEqual([join(sessionsRoot, encodePiSessionCwd(workspaceRoot))]);
  });

  it('does not resolve sessions from a divergent legacy workingDirectory bucket', () => {
    const legacyDivergentCwd = join(workspaceRoot, 'project-b');
    writePiSession(sessionsRoot, legacyDivergentCwd, '2026-07-04T10-05-00_session-b.jsonl', {
      type: 'session',
      id: 'session-b',
      timestamp: '2026-07-04T10:05:00.000Z',
      cwd: legacyDivergentCwd,
    });

    const roots = collectSessionSearchRoots(workspaceRoot, [
      { id: 'session-b', workingDirectory: legacyDivergentCwd },
    ]);

    expect(roots).toEqual([]);
  });
});
