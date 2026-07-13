/**
 * Tests for SessionPersistenceQueue in sessions/persistence-queue.ts
 *
 * Key behavior: Writes to the same session must be serialized to prevent
 * race conditions when rapid successive flushes write to the same .tmp file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { SessionPersistenceQueue } from '../src/sessions/persistence-queue.ts';
import { getSessionFilePath, setSharedPiSessionsDirForTests } from '../src/sessions/storage.ts';
import type { StoredSession } from '../src/sessions/types.ts';

const emptyTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  contextTokens: 0,
};

// Create a minimal stored session for testing
function createTestSession(
  id: string,
  workspaceRootPath: string,
  sdkSessionId?: string
): StoredSession {
  return {
    craftId: id,
    workspaceRootPath,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastMessageAt: Date.now(),
    messages: [],
    tokenUsage: emptyTokenUsage,
    sdkSessionId,
  };
}

function createSessionWithoutCraftId(
  id: string,
  workspaceRootPath: string,
  sdkSessionId?: string
): StoredSession {
  return {
    ...createTestSession(id, workspaceRootPath, sdkSessionId),
    craftId: undefined,
    id,
  } as unknown as StoredSession;
}

function readWrittenHeader(workspaceRootPath: string, sessionId: string): any {
  const filePath = getSessionFilePath(workspaceRootPath, sessionId);
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content.split('\n')[0]);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function blockNextWrite(queue: SessionPersistenceQueue): {
  started: Promise<void>;
  release: () => void;
} {
  let markStarted!: () => void;
  let releaseWrite!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releaseWrite = resolve; });
  const internals = queue as unknown as { write: (sessionId: string) => Promise<void> };
  const originalWrite = internals.write.bind(queue);
  internals.write = async (sessionId: string) => {
    markStarted();
    await blocked;
    await originalWrite(sessionId);
  };
  return { started, release: releaseWrite };
}

describe('SessionPersistenceQueue', () => {
  let testDir: string;
  let queue: SessionPersistenceQueue;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `persistence-queue-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    setSharedPiSessionsDirForTests(join(testDir, 'pi-sessions'));
    // Use 0ms debounce for immediate writes in tests
    queue = new SessionPersistenceQueue(0);
  });

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined);
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('writes session to disk', async () => {
    const session = createTestSession('test-session', testDir, 'sdk-123');
    queue.enqueue(session);
    await queue.flush('test-session');

    const filePath = getSessionFilePath(testDir, 'test-session');
    expect(existsSync(filePath)).toBe(true);

    const header = readWrittenHeader(testDir, 'test-session');
    expect(header.id).toBe('sdk-123');
    expect(header.craft.sdkSessionId).toBe('sdk-123');
  });

  it('serializes concurrent flushes for the same session', async () => {
    // This test verifies the fix for the race condition where
    // clearSessionForRecovery() + onSdkSessionIdUpdate() would
    // both flush rapidly and corrupt each other's writes.

    // Simulate the problematic sequence:
    // 1. First write with sdkSessionId = undefined (clearing)
    const session1 = createTestSession('test-session', testDir, undefined);
    queue.enqueue(session1);
    const flush1 = queue.flush('test-session');

    // 2. Second write with new sdkSessionId (before first completes)
    const session2 = createTestSession('test-session', testDir, 'new-thread-id');
    queue.enqueue(session2);
    const flush2 = queue.flush('test-session');

    // Wait for both to complete
    await Promise.all([flush1, flush2]);

    // The final file should have the NEWER data (new-thread-id)
    const header = readWrittenHeader(testDir, 'test-session');

    // Before the fix, this could randomly be undefined due to race condition
    expect(header.craft.sdkSessionId).toBe('new-thread-id');
  });

  it('allows parallel writes to different sessions', async () => {
    // Different sessions should write in parallel without blocking each other
    const sessionA = createTestSession('session-a', testDir, 'id-a');
    const sessionB = createTestSession('session-b', testDir, 'id-b');

    queue.enqueue(sessionA);
    queue.enqueue(sessionB);

    // Flush both in parallel
    await Promise.all([
      queue.flush('session-a'),
      queue.flush('session-b'),
    ]);

    // Both should be written correctly
    const headerA = readWrittenHeader(testDir, 'session-a');
    const headerB = readWrittenHeader(testDir, 'session-b');

    expect(headerA.craft.sdkSessionId).toBe('id-a');
    expect(headerB.craft.sdkSessionId).toBe('id-b');
  });

  it('rejects legacy id-only sessions without accepting id as the persistence key', async () => {
    const session = createSessionWithoutCraftId('legacy-a', testDir, 'id-a');

    queue.enqueue(session);
    await queue.flush('legacy-a');

    expect(queue.hasPending('legacy-a')).toBe(false);
    expect(existsSync(getSessionFilePath(testDir, 'legacy-a'))).toBe(false);
  });

  it('cancel waits for debounce-triggered writes already in progress', async () => {
    const session = createTestSession('blocked-session', testDir, 'sdk-blocked');
    const blocker = blockNextWrite(queue);

    queue.enqueue(session);
    await blocker.started;

    let cancelResolved = false;
    const cancelPromise = queue.cancel(session.craftId).then(() => {
      cancelResolved = true;
    });

    await sleep(40);
    expect(cancelResolved).toBe(false);

    blocker.release();
    await cancelPromise;

    expect(cancelResolved).toBe(true);
  });

  it('drops enqueue calls that arrive while delete cancellation waits on an in-progress write', async () => {
    const session = createTestSession('delete-race-session', testDir, 'sdk-blocked');
    const blocker = blockNextWrite(queue);
    const filePath = getSessionFilePath(testDir, session.craftId, undefined, session.createdAt);

    queue.enqueue(session);
    await blocker.started;

    const cancelPromise = queue.cancel(session.craftId, { preventFutureEnqueue: true });
    await sleep(40);

    queue.enqueue({
      ...session,
      sdkSessionId: 'sdk-should-not-revive',
    });

    blocker.release();
    await cancelPromise;
    rmSync(filePath, { force: true });

    await sleep(40);

    expect(queue.hasPending(session.craftId)).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  it('preserves active externally edited metadata while stripping retired organization fields', async () => {
    const session = {
      ...createTestSession('external-metadata-session', testDir, 'sdk-external'),
      name: 'old name',
    };

    queue.enqueue(session);
    await queue.flush(session.craftId);

    const filePath = getSessionFilePath(testDir, session.craftId, undefined, session.createdAt);
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    header.craft.name = 'external name';
    header.craft.sessionStatus = 'done';
    header.craft.labels = ['external'];
    header.craft.isFlagged = true;
    header.craft.isArchived = true;
    header.craft.archivedAt = 12345;
    writeFileSync(filePath, [JSON.stringify(header), ...lines.slice(1)].join('\n') + '\n', 'utf-8');

    queue.enqueue({
      ...session,
      lastUsedAt: Date.now() + 1,
    });
    await queue.flush(session.craftId);

    const updated = readWrittenHeader(testDir, session.craftId);
    expect(updated.craft.name).toBe('external name');
    expect(updated.craft.sessionStatus).toBeUndefined();
    expect(updated.craft.labels).toBeUndefined();
    expect(updated.craft.isFlagged).toBeUndefined();
    expect(updated.craft.isArchived).toBeUndefined();
    expect(updated.craft.archivedAt).toBeUndefined();

    queue.enqueue({
      ...session,
      lastUsedAt: Date.now() + 2,
    });
    await queue.flush(session.craftId);

    const updatedAgain = readWrittenHeader(testDir, session.craftId);
    expect(updatedAgain.craft.name).toBe('external name');
    expect(updatedAgain.craft.sessionStatus).toBeUndefined();
    expect(updatedAgain.craft.labels).toBeUndefined();
    expect(updatedAgain.craft.isFlagged).toBeUndefined();
    expect(updatedAgain.craft.isArchived).toBeUndefined();
    expect(updatedAgain.craft.archivedAt).toBeUndefined();
  });
});
