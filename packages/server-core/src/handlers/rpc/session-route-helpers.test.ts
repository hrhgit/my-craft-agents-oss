import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { encodeWorkspaceSessionBucket } from '@mortise/shared/config/paths';
import { setSharedPiSessionsDirForTests } from '@mortise/shared/sessions';
import {
  collectSessionSearchRoots,
  serializeExtensionCommandArgs,
} from './session-route-helpers.ts';

function writePiSession(
  root: string,
  workspaceId: string,
  fileName: string,
  header: Record<string, unknown>,
): string {
  const bucket = join(root, encodeWorkspaceSessionBucket(workspaceId));
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
    writePiSession(sessionsRoot, 'workspace-a', '2026-07-04T10-00-00_session-a.jsonl', {
      type: 'session',
      id: 'session-a',
      timestamp: '2026-07-04T10:00:00.000Z',
      cwd: workspaceRoot,
      mortise: { workspaceId: 'workspace-a' },
    });
    const roots = collectSessionSearchRoots('workspace-a', [{ id: 'session-a' }]).sort();

    expect(roots).toEqual([join(sessionsRoot, encodeWorkspaceSessionBucket('workspace-a'))]);
  });

  it('does not scan a different cwd bucket', () => {
    const differentCwd = join(workspaceRoot, 'project-b');
    writePiSession(sessionsRoot, 'workspace-other', '2026-07-04T10-05-00_session-b.jsonl', {
      type: 'session',
      id: 'session-b',
      timestamp: '2026-07-04T10:05:00.000Z',
      cwd: differentCwd,
      mortise: { workspaceId: 'workspace-other' },
    });

    const roots = collectSessionSearchRoots('workspace-b', [{ id: 'session-b' }]);

    expect(roots).toEqual([]);
  });
});
