import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

describe('Windows packaging size contract', () => {
  it('uses an allowlist and stages the Pi runtime only once', () => {
    const config = parse(readFileSync(join(repoRoot, 'apps/electron/electron-builder.yml'), 'utf-8')) as {
      files: string[];
      mac: { extraResources: Array<{ from: string; to: string; filter?: string[] }> };
      win: { files: string[]; extraResources: Array<{ from: string; to: string; filter?: string[] }> };
      linux: { extraResources: Array<{ from: string; to: string; filter?: string[] }> };
    };

    expect(config.files[0]).toBe('dist/**/*');
    // The installer Developer Kit is injected at packaging time from the immutable
    // kit artifact directory (see package-electron.ts); it is never staged into
    // resources/app/dist as a second copy.
    expect(config.files).not.toContain('!dist/installer-developer-kit/**/*');
    expect(config.win.extraResources.map(resource => resource.to)).not.toContain('developer-kit');
    expect(config.win.extraResources).toContainEqual({
      from: 'dist/packaging-inputs/hooks/link-dev-host.ps1',
      to: 'developer-kit/link-dev-host.ps1',
    });
    expect(config.files).toContain('!dist/packaging-inputs/**/*');
    expect(config.files).toContain('!**/*.d.ts');
    expect(config.files).toContain('!dist/resources/pi-runtime/**/*');
    expect(config.files).toContain('!dist/resources/bin/**/*');
    expect(config.files).toContain('!dist/resources/session-mcp-server/**/*');
    expect(config.files).not.toContain('resources/bridge-mcp-server/**/*');
    expect(config.win.extraResources.filter(resource => resource.from === 'dist/resources/pi-runtime')).toEqual([
      { from: 'dist/resources/pi-runtime', to: 'pi-runtime', filter: ['**/*'] },
    ]);
    expect(config.win.extraResources
      .filter(resource => resource.to !== 'developer-kit')
      .every(resource => resource.from.startsWith('dist/'))).toBe(true);
    expect(config.win.extraResources.map(resource => resource.from)).toContain('dist/packaging-inputs/runtime/bun/bun.exe');
    expect(config.win.extraResources.map(resource => resource.from)).toContain('dist/packaging-inputs/runtime/ripgrep');
    for (const platform of [config.mac, config.win, config.linux]) {
      expect(platform.extraResources.find(resource => resource.from === 'dist/packaging-inputs/runtime/ripgrep'))
        .toEqual({
          from: 'dist/packaging-inputs/runtime/ripgrep',
          to: 'app/node_modules/@vscode/ripgrep',
          filter: ['**/*', '!**/*.d.ts'],
        });
    }

    const buildSource = readFileSync(join(repoRoot, 'scripts/build/common.ts'), 'utf-8');
    expect(buildSource).toContain('export function stageCompiledPiRuntime(');
    expect(buildSource).not.toContain('stagePiRuntime(config, runtimeRoot)');
    expect(buildSource).not.toContain('MORTISE_PI_BINARY_RUNTIME');

    const assetValidationSource = readFileSync(join(repoRoot, 'apps/electron/scripts/validate-assets.ts'), 'utf-8');
    expect(assetValidationSource).toContain('Electron production staging requires the compiled Pi runtime');
    expect(assetValidationSource).toContain('Electron production staging contains a legacy Pi runtime candidate');
    expect(assetValidationSource).not.toContain('Pi CLI bundle smoke test');
  });
});
