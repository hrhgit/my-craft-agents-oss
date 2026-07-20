import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverDeveloperKit,
  formatDeveloperKitSystemPrompt,
  validateDeveloperKit,
} from '../developer-kit.ts';

const roots: string[] = [];
const runtime = { platform: 'win32' as const, arch: 'x64', productVersion: '0.1.0' };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Mortise Developer Kit configuration', () => {
  it('validates a complete version-matched kit', () => {
    const root = createKit();
    const installation = validateDeveloperKit(root, runtime);

    expect(installation.rootPath).toBe(root);
    expect(installation.cliPath).toBe(join(root, 'bin', 'mortise-ui.exe'));
    expect(installation.manifest.version).toBe('0.1.0');
  });

  it('rejects an incomplete kit without persisting it', () => {
    const root = createKit({ includeCli: false });
    expect(() => validateDeveloperKit(root, runtime))
      .toThrow('Missing Developer Kit CLI');
  });

  it('rejects a Developer Host built for a different Mortise version', () => {
    const root = createKit({ hostVersion: '9.9.9' });

    expect(() => validateDeveloperKit(root, runtime))
      .toThrow('Developer Kit Host version 9.9.9 does not match Mortise 0.1.0');
  });

  it('discovers the kit through the stable source-build latest pointer', () => {
    const repoRoot = makeTempRoot();
    const kitRoot = createKit();
    mkdirSync(join(repoRoot, 'output'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'output', 'developer-kit-latest.json'),
      JSON.stringify({ artifactDirectory: kitRoot }),
    );

    const installation = discoverDeveloperKit({
      cwd: join(repoRoot, 'nested', 'project'),
      env: { PATH: '' },
      platform: 'win32',
      arch: 'x64',
      productVersion: '0.1.0',
    });

    expect(installation?.rootPath).toBe(kitRoot);
  });

  it('discovers a Developer Kit embedded in the packaged resources directory', () => {
    const resourcesRoot = makeTempRoot();
    const kitRoot = join(resourcesRoot, 'developer-kit');
    createKitAt(kitRoot);

    const installation = discoverDeveloperKit({
      env: { PATH: '', MORTISE_RESOURCES_PATH: resourcesRoot },
      platform: 'win32',
      arch: 'x64',
      productVersion: '0.1.0',
    });

    expect(installation?.rootPath).toBe(kitRoot);
  });

  it('formats only validated decision-relevant system prompt context', () => {
    const root = createKit();
    const installation = validateDeveloperKit(root, runtime);
    const prompt = formatDeveloperKitSystemPrompt({
      state: 'ready',
      source: 'manual',
      configuredPath: root,
      installation,
    });

    expect(prompt).toContain('<mortise_developer_kit>');
    expect(prompt).toContain(JSON.stringify(installation.cliPath));
    expect(prompt).toContain('--extension <directory>');
    expect(formatDeveloperKitSystemPrompt({ state: 'not-configured' })).toBeUndefined();
  });
});

function createKit(options: { includeCli?: boolean; hostVersion?: string } = {}): string {
  const root = makeTempRoot();
  createKitAt(root, options);
  return root;
}

function createKitAt(root: string, options: { includeCli?: boolean; hostVersion?: string } = {}): void {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'dev-host'), { recursive: true });
  if (options.includeCli !== false) writeFileSync(join(root, 'bin', 'mortise-ui.exe'), 'fixture');
  writeFileSync(join(root, 'dev-host', 'Mortise Developer Host.exe'), 'fixture');
  writeFileSync(join(root, 'developer-kit.json'), JSON.stringify({
    schemaVersion: 1,
    name: '@mortise/developer-kit',
    version: '0.1.0',
    hostVersion: options.hostVersion ?? '0.1.0',
    uiValidationProtocolVersion: 1,
    platform: 'win32',
    arch: 'x64',
    appId: 'io.github.hrhgit.mortise.devhost',
  }));
}

function makeTempRoot(): string {
  const root = join(tmpdir(), `mortise-developer-kit-test-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}
