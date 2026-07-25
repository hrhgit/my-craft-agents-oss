import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('interceptor bundle contract', () => {
  it('keeps request-context resolution in the bundled interceptor dependency graph', () => {
    const interceptor = readRepoFile('packages/shared/src/unified-network-interceptor.ts');
    expect(interceptor).toContain("from './interceptor-request-utils.ts'");
  });
});
