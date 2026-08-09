import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodePiSessionCwd, encodeWorkspaceSessionBucket } from '../../config/paths.ts';
import {
  listSessions,
  migrateLegacyWorkspaceSessionBuckets,
  setSharedPiSessionsDirForTests,
} from '../storage.ts';

function writeLegacySession(bucket: string, sessionId: string, workspaceId: string): string {
  mkdirSync(join(bucket, '.mortise', sessionId, 'plans'), { recursive: true });
  writeFileSync(join(bucket, '.mortise', sessionId, 'plans', 'plan.md'), `# ${sessionId}\n`);
  const file = join(bucket, `2026-08-07T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({
    type: 'session',
    version: 3,
    id: `pi-${sessionId}`,
    timestamp: '2026-08-07T00:00:00.000Z',
    cwd: 'E:/workspace',
    mortise: { id: sessionId, workspaceId, workspaceRootPath: 'E:/workspace' },
  })}\n`);
  return file;
}

describe('stable Workspace session buckets', () => {
  let root: string | undefined;

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined);
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('does not depend on process cwd', () => {
    root = mkdtempSync(join(tmpdir(), 'workspace-bucket-cwd-'));
    const firstCwd = join(root, 'source-launch');
    const secondCwd = join(root, 'installed-launch');
    mkdirSync(firstCwd, { recursive: true });
    mkdirSync(secondCwd, { recursive: true });
    const originalCwd = process.cwd();
    let first: string;
    let second: string;
    try {
      process.chdir(firstCwd);
      first = encodeWorkspaceSessionBucket('workspace-1');
      process.chdir(secondCwd);
      second = encodeWorkspaceSessionBucket('workspace-1');
    } finally {
      process.chdir(originalCwd);
    }

    expect(first!).toBe(second!);
    expect(first!).not.toBe(encodeWorkspaceSessionBucket('workspace-2'));
  });

  it('merges cwd-keyed legacy buckets and keeps sidecars', () => {
    root = mkdtempSync(join(tmpdir(), 'workspace-bucket-migration-'));
    setSharedPiSessionsDirForTests(root);
    const workspaceId = 'workspace-1';
    const workspaceRoot = join(root, 'workspace-root');
    const first = join(root, encodePiSessionCwd(join(root, 'source-one')));
    const second = join(root, encodePiSessionCwd(join(root, 'source-two')));
    writeLegacySession(first, 'session-one', workspaceId);
    writeLegacySession(second, 'session-two', workspaceId);

    const listed = listSessions(workspaceId, workspaceRoot);
    const target = join(root, encodeWorkspaceSessionBucket(workspaceId));

    expect(listed.map(session => session.mortiseId).sort()).toEqual(['session-one', 'session-two']);
    expect(existsSync(join(target, '.mortise', 'session-one', 'plans', 'plan.md'))).toBe(true);
    expect(existsSync(join(target, '.mortise', 'session-two', 'plans', 'plan.md'))).toBe(true);
    expect(existsSync(join(first, '2026-08-07T00-00-00-000Z_session-one.jsonl'))).toBe(false);
    expect(existsSync(join(second, '2026-08-07T00-00-00-000Z_session-two.jsonl'))).toBe(false);
  });

  it('does not overwrite a different destination file', () => {
    root = mkdtempSync(join(tmpdir(), 'workspace-bucket-conflict-'));
    setSharedPiSessionsDirForTests(root);
    const workspaceId = 'workspace-conflict';
    const source = join(root, encodePiSessionCwd(join(root, 'source')));
    const sourceFile = writeLegacySession(source, 'same-session', workspaceId);
    const target = join(root, encodeWorkspaceSessionBucket(workspaceId));
    mkdirSync(target, { recursive: true });
    const targetFile = join(target, '2026-08-07T00-00-00-000Z_same-session.jsonl');
    writeFileSync(targetFile, 'different-content\n');

    const report = migrateLegacyWorkspaceSessionBuckets(workspaceId, join(root, 'workspace-root'));

    expect(report.conflicts).toContain(sourceFile);
    expect(readFileSync(targetFile, 'utf8')).toBe('different-content\n');
    expect(existsSync(sourceFile)).toBe(true);
  });
});
