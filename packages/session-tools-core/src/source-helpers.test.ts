import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  getSourcePath,
  loadSourceConfig,
  sourceExists,
} from './source-helpers.ts';

describe('source slug path safety', () => {
  it('rejects dot segments that basename() would otherwise accept', () => {
    const workspaceRoot = join('tmp', 'workspace');

    expect(() => getSourcePath(workspaceRoot, '..')).toThrow('Invalid source slug');
    expect(() => getSourcePath(workspaceRoot, '.')).toThrow('Invalid source slug');
    expect(sourceExists(workspaceRoot, '..')).toBe(false);
    expect(loadSourceConfig(workspaceRoot, '..')).toBeNull();
  });
});
