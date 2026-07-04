import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePiSessionCwd } from '../../shared/src/config/paths.ts';
import { listSpawnedChildSessions } from './child-session-listing.ts';

function writeSessionFile(
  root: string,
  cwd: string,
  fileName: string,
  header: Record<string, unknown>,
): string {
  const bucket = join(root, encodePiSessionCwd(cwd));
  mkdirSync(bucket, { recursive: true });
  const filePath = join(bucket, fileName);
  writeFileSync(filePath, `${JSON.stringify(header)}\n`, 'utf-8');
  // Pin mtime to the header timestamp: listSpawnedChildSessions sorts by file
  // mtime, and back-to-back writes can land in the same mtime resolution
  // window, making the sort order flip randomly.
  if (typeof header.timestamp === 'string') {
    const ts = new Date(header.timestamp);
    utimesSync(filePath, ts, ts);
  }
  return filePath;
}

describe('listSpawnedChildSessions', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds spawned children across cwd buckets', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-child-sessions-'));
    tempRoots.push(root);

    writeSessionFile(root, '/workspace/a', '2026-07-04T10-00-00_parent.jsonl', {
      type: 'session',
      id: 'parent',
      timestamp: '2026-07-04T10:00:00.000Z',
      cwd: '/workspace/a',
    });
    writeSessionFile(root, '/workspace/a', '2026-07-04T10-05-00_child-a.jsonl', {
      type: 'session',
      id: 'child-a',
      timestamp: '2026-07-04T10:05:00.000Z',
      cwd: '/workspace/a',
      spawnedFrom: 'parent',
      spawnConfig: { model: 'gpt-5' },
    });
    writeSessionFile(root, '/workspace/b', '2026-07-04T10-06-00_child-b.jsonl', {
      type: 'session',
      id: 'child-b',
      timestamp: '2026-07-04T10:06:00.000Z',
      cwd: '/workspace/b',
      spawnedFrom: 'parent',
      spawnConfig: { connection: 'pi-api-key' },
    });
    writeSessionFile(root, '/workspace/b', '2026-07-04T10-07-00_other.jsonl', {
      type: 'session',
      id: 'other',
      timestamp: '2026-07-04T10:07:00.000Z',
      cwd: '/workspace/b',
      spawnedFrom: 'someone-else',
    });

    const sessions = listSpawnedChildSessions('parent', root);

    expect(sessions.map((session) => session.sessionId)).toEqual(['child-b', 'child-a']);
    expect(sessions.map((session) => session.cwd).sort()).toEqual(['/workspace/a', '/workspace/b']);
    expect(sessions[0]?.spawnConfig?.connection).toBe('pi-api-key');
    expect(sessions[1]?.spawnConfig?.model).toBe('gpt-5');
  });
});
