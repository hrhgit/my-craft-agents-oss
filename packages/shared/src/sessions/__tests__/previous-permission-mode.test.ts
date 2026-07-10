import { describe, expect, it } from 'bun:test';
import { CRAFT_SESSION_METADATA_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: previousPermissionMode', () => {
  it('includes previousPermissionMode in Craft session metadata fields', () => {
    expect(CRAFT_SESSION_METADATA_FIELDS).toContain('previousPermissionMode');
  });

  it('pickSessionFields preserves previousPermissionMode when present', () => {
    const source = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      permissionMode: 'allow-all',
      previousPermissionMode: 'safe',
      createdAt: 1,
      lastUsedAt: 2,
      ignoredRuntimeField: 'nope',
    } as const;

    const picked = pickSessionFields(source);
    expect(picked.permissionMode).toBe('allow-all');
    expect(picked.previousPermissionMode).toBe('safe');
    expect((picked as Record<string, unknown>).ignoredRuntimeField).toBeUndefined();
  });
});
