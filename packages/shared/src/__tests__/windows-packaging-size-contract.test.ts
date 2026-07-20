import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

describe('Windows packaging size contract', () => {
  it('uses an allowlist and stages the Pi runtime only once', () => {
    const config = parse(readFileSync(join(repoRoot, 'apps/electron/electron-builder.yml'), 'utf-8')) as {
      files: string[];
      win: { files: string[]; extraResources: Array<{ from: string; to: string; filter?: string[] }> };
    };

    expect(config.files[0]).toBe('dist/**/*');
    expect(config.files).toContain('!dist/installer-developer-kit/**/*');
    expect(config.files).toContain('!dist/resources/pi-runtime/**/*');
    expect(config.files).toContain('!dist/resources/bin/**/*');
    expect(config.files).toContain('!dist/resources/session-mcp-server/**/*');
    expect(config.files).not.toContain('resources/bridge-mcp-server/**/*');
    expect(config.win.extraResources.filter(resource => resource.from === 'dist/resources/pi-runtime')).toEqual([
      { from: 'dist/resources/pi-runtime', to: 'pi-runtime', filter: ['**/*'] },
    ]);

    const buildSource = readFileSync(join(repoRoot, 'scripts/build/common.ts'), 'utf-8');
    expect(buildSource).toContain("config.platform === 'win32' && process.env.MORTISE_PI_BINARY_RUNTIME !== '0'");
  });
});
