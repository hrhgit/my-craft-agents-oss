import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPiMessageSearchPattern,
  extractPiSessionIdFromPath,
  searchSessions,
  setSearchPlatform,
} from './search';

const infoEvents: unknown[][] = [];
const silentLogger = {
  info(...args: unknown[]) { infoEvents.push(args); },
  warn() {},
  error() {},
  debug() {},
};

setSearchPlatform({
  appRootPath: process.cwd(),
  resourcesPath: process.cwd(),
  isPackaged: false,
  appVersion: 'test',
  imageProcessor: {
    async getMetadata() { return null; },
    async process() { return Buffer.alloc(0); },
  },
  logger: silentLogger,
  isDebugMode: false,
});

function createSessionFile(
  root: string,
  ordinal: number,
  sessionId: string,
  messages: string[],
): void {
  const entries = [
    JSON.stringify({ type: 'session', version: 1 }),
    ...messages.map((content, index) => JSON.stringify({
      type: 'message',
      id: `${sessionId}-${index}`,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
    })),
  ];
  writeFileSync(
    join(root, `${ordinal.toString().padStart(4, '0')}_${sessionId}.jsonl`),
    `${entries.join('\n')}\n`,
  );
}

describe('extractPiSessionIdFromPath', () => {
  it('extracts ids from flat Pi session files on Windows and POSIX paths', () => {
    expect(extractPiSessionIdFromPath('C:\\Users\\me\\.mortise\\agent\\sessions\\--work--\\2026-07-12T00-00-00-000Z_260712-fast-task.jsonl'))
      .toBe('260712-fast-task');
    expect(extractPiSessionIdFromPath('/home/me/.mortise/agent/sessions/--work--/plain-id.jsonl'))
      .toBe('plain-id');
  });

  it('preserves underscores in the Mortise session id', () => {
    expect(extractPiSessionIdFromPath('/sessions/2026-07-12T00-00-00-000Z_session_with_parts.jsonl'))
      .toBe('session_with_parts');
  });

  it('rejects the retired nested session filename and non-JSONL files', () => {
    expect(extractPiSessionIdFromPath('/sessions/legacy/session.jsonl')).toBeNull();
    expect(extractPiSessionIdFromPath('/sessions/session.txt')).toBeNull();
  });
});

describe('buildPiMessageSearchPattern', () => {
  it('matches real Pi user and assistant message entries but excludes tool results', () => {
    const pattern = new RegExp(buildPiMessageSearchPattern('needle'), 'i');
    const user = JSON.stringify({
      type: 'message',
      id: 'entry-user',
      parentId: null,
      timestamp: '2026-07-12T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'find needle here' }], timestamp: 1 },
    });
    const assistant = JSON.stringify({
      type: 'message',
      id: 'entry-assistant',
      parentId: 'entry-user',
      timestamp: '2026-07-12T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'needle found' }], timestamp: 2 },
    });
    const tool = JSON.stringify({
      type: 'message',
      id: 'entry-tool',
      parentId: 'entry-assistant',
      timestamp: '2026-07-12T00:00:02.000Z',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'needle noise' }] },
    });

    expect(pattern.test(user)).toBe(true);
    expect(pattern.test(assistant)).toBe(true);
    expect(pattern.test(tool)).toBe(false);
  });

  it('escapes literal regex characters in the query', () => {
    const pattern = new RegExp(buildPiMessageSearchPattern('a+b?'));
    expect(pattern.test(JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'literal a+b?' },
    }))).toBe(true);
  });
});

describe('searchSessions bounds', () => {
  it('returns and accumulates only a deterministic maxSessions prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-search-bounds-'));
    try {
      infoEvents.length = 0;
      for (let index = 0; index < 40; index += 1) {
        createSessionFile(root, index, `session-${index.toString().padStart(2, '0')}`, [
          `needle ${index} first`,
          `needle ${index} second`,
          `needle ${index} third`,
          `needle ${index} fourth`,
        ]);
      }

      const results = await searchSessions('needle', root, {
        maxSessions: 3,
        maxMatchesPerSession: 2,
        timeout: 5_000,
      });

      expect(results).toHaveLength(3);
      expect(results.map(result => result.sessionId)).toEqual([
        'session-37',
        'session-38',
        'session-39',
      ]);
      expect(results.map(result => result.matchCount)).toEqual([4, 4, 4]);
      expect(results.every(result => result.matches.length === 2)).toBe(true);
      expect(infoEvents.some(args => args.some(value => (
        typeof value === 'object'
        && value !== null
        && 'stoppedAtSessionLimit' in value
        && value.stoppedAtSessionLimit === true
      )))).toBe(true);

      // The bounded termination must leave no stale singleton process behind.
      const repeated = await searchSessions('needle', root, {
        maxSessions: 2,
        maxMatchesPerSession: 1,
        timeout: 5_000,
      });
      expect(repeated.map(result => result.sessionId)).toEqual(['session-38', 'session-39']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not spawn or retain results when maxSessions is zero', async () => {
    await expect(searchSessions('needle', 'missing-search-root', { maxSessions: 0 }))
      .resolves.toEqual([]);
  });

  it('cancels an in-flight search before starting its replacement', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'mortise-search-cancel-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'mortise-search-cancel-second-'));
    try {
      for (let index = 0; index < 100; index += 1) {
        createSessionFile(firstRoot, index, `first-${index}`, ['first-query']);
      }
      createSessionFile(secondRoot, 0, 'replacement', ['second-query']);

      const cancelledSearch = searchSessions('first-query', firstRoot, {
        maxSessions: 100,
        timeout: 5_000,
      });
      const replacementSearch = searchSessions('second-query', secondRoot, {
        maxSessions: 1,
        timeout: 5_000,
      });

      const [cancelledResults, replacementResults] = await Promise.all([
        cancelledSearch,
        replacementSearch,
      ]);
      expect(cancelledResults.length).toBeLessThanOrEqual(100);
      expect(replacementResults.map(result => result.sessionId)).toEqual(['replacement']);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
