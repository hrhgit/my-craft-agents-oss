import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getLastApiError,
  setStoredError,
  toolMetadataStore,
} from '../interceptor-common.ts';

describe('interceptor-common', () => {
  let sessionDirA: string;
  let sessionDirB: string;

  beforeEach(() => {
    sessionDirA = mkdtempSync(join(tmpdir(), 'interceptor-a-'));
    sessionDirB = mkdtempSync(join(tmpdir(), 'interceptor-b-'));
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDirA, { recursive: true, force: true });
    rmSync(sessionDirB, { recursive: true, force: true });
  });

  it('keeps API errors session-scoped when session dir is switched', () => {
    toolMetadataStore.setSessionDir(sessionDirA);
    setStoredError({
      status: 401,
      statusText: 'Unauthorized',
      message: 'Session A auth failed',
      timestamp: Date.now(),
    });

    toolMetadataStore.setSessionDir(sessionDirB);
    setStoredError({
      status: 429,
      statusText: 'Too Many Requests',
      message: 'Session B rate limit',
      timestamp: Date.now(),
    });

    toolMetadataStore.setSessionDir(sessionDirA);
    const errA = getLastApiError();
    expect(errA?.status).toBe(401);

    toolMetadataStore.setSessionDir(sessionDirB);
    const errB = getLastApiError();
    expect(errB?.status).toBe(429);
  });

  it('keeps tool metadata in memory without writing a cross-process file', () => {
    toolMetadataStore.setSessionDir(sessionDirA);

    toolMetadataStore.set('newTool', {
      intent: 'New intent',
      displayName: 'New Tool',
      timestamp: Date.now(),
    });

    expect(toolMetadataStore.get('newTool', sessionDirA)?.intent).toBe('New intent');
    expect(existsSync(join(sessionDirA, 'tool-metadata.json'))).toBe(false);
  });

  it('drops stale in-memory tool metadata', () => {
    toolMetadataStore.set('oldTool', {
      intent: 'Old intent',
      displayName: 'Old Tool',
      timestamp: Date.now() - 11 * 60 * 1000,
    });

    expect(toolMetadataStore.get('oldTool', sessionDirA)).toBeUndefined();
    expect(toolMetadataStore.size).toBe(0);
  });
});
