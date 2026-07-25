import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveScriptRuntime } from './resolve-script-runtime.ts';
import { resolveImmutableRuntimeLayout } from './immutable-runtime.ts';

describe('resolveScriptRuntime', () => {
  it('prefers MORTISE_UV for python3', () => {
    const prev = process.env.MORTISE_UV;
    process.env.MORTISE_UV = '/tmp/custom-uv';

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-uv');
      expect(resolved.argsPrefix).toEqual(['run', '--python', '3.12']);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.MORTISE_UV;
      else process.env.MORTISE_UV = prev;
    }
  });

  it('prefers bundled uv when env is missing', () => {
    const prevUv = process.env.MORTISE_UV;
    delete process.env.MORTISE_UV;

    const base = mkdtempSync(join(tmpdir(), 'runtime-resolver-'));
    const uvPath = join(base, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
    mkdirSync(join(base, 'resources', 'bin', `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(uvPath, '');

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: true, resourcesBasePath: base });
      expect(resolved.command).toBe(uvPath);
      expect(resolved.source).toBe('bundled');
    } finally {
      if (prevUv === undefined) delete process.env.MORTISE_UV;
      else process.env.MORTISE_UV = prevUv;
    }
  });

  it('blocks PATH fallback in packaged mode', () => {
    const prevUv = process.env.MORTISE_UV;
    const prevBase = process.env.MORTISE_RESOURCES_BASE;
    const prevRoot = process.env.MORTISE_APP_ROOT;
    delete process.env.MORTISE_UV;
    delete process.env.MORTISE_RESOURCES_BASE;
    delete process.env.MORTISE_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('python3', { isPackaged: true })).toThrow(
        'packaged app'
      );
    } finally {
      if (prevUv === undefined) delete process.env.MORTISE_UV;
      else process.env.MORTISE_UV = prevUv;
      if (prevBase === undefined) delete process.env.MORTISE_RESOURCES_BASE;
      else process.env.MORTISE_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.MORTISE_APP_ROOT;
      else process.env.MORTISE_APP_ROOT = prevRoot;
    }
  });

  it('rejects bare MORTISE_NODE command in packaged mode', () => {
    const prev = process.env.MORTISE_NODE;
    process.env.MORTISE_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node', { isPackaged: true })).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prev === undefined) delete process.env.MORTISE_NODE;
      else process.env.MORTISE_NODE = prev;
    }
  });

  it('treats MORTISE_IS_PACKAGED=true as packaged mode', () => {
    const prevPackaged = process.env.MORTISE_IS_PACKAGED;
    const prevNode = process.env.MORTISE_NODE;
    process.env.MORTISE_IS_PACKAGED = 'true';
    process.env.MORTISE_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node')).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prevPackaged === undefined) delete process.env.MORTISE_IS_PACKAGED;
      else process.env.MORTISE_IS_PACKAGED = prevPackaged;
      if (prevNode === undefined) delete process.env.MORTISE_NODE;
      else process.env.MORTISE_NODE = prevNode;
    }
  });

  it('prefers MORTISE_BUN for bun in dev', () => {
    const prev = process.env.MORTISE_BUN;
    process.env.MORTISE_BUN = '/tmp/custom-bun';

    try {
      const resolved = resolveScriptRuntime('bun', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-bun');
      expect(resolved.argsPrefix).toEqual([]);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.MORTISE_BUN;
      else process.env.MORTISE_BUN = prev;
    }
  });

  it('uses only capsule-owned runtimes in immutable mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'immutable-runtime-resolver-'));
    const appRootPath = join(root, 'app');
    const resourcesBasePath = join(appRootPath, 'dist');
    const resourcesPath = join(resourcesBasePath, 'resources');
    const runtimePath = join(resourcesBasePath, 'packaging-inputs', 'runtime');
    const nodeRuntimePath = process.platform === 'win32'
      ? join(runtimePath, 'electron', 'electron.exe')
      : process.platform === 'darwin'
        ? join(runtimePath, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(runtimePath, 'electron', 'electron');
    const bunRuntimePath = join(runtimePath, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
    const uvRuntimePath = join(
      resourcesBasePath,
      'resources',
      'bin',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'uv.exe' : 'uv',
    );
    for (const path of [nodeRuntimePath, bunRuntimePath, uvRuntimePath]) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'capsule runtime');
    }
    const previous = {
      bun: process.env.MORTISE_BUN,
      node: process.env.MORTISE_NODE,
      uv: process.env.MORTISE_UV,
    };
    process.env.MORTISE_BUN = 'external-bun';
    process.env.MORTISE_NODE = 'external-node';
    process.env.MORTISE_UV = 'external-uv';
    const immutableRuntime = resolveImmutableRuntimeLayout({
      env: {
        MORTISE_RUNTIME_IMMUTABLE: '1',
        MORTISE_RUNTIME_APP_ROOT: appRootPath,
        MORTISE_RUNTIME_RESOURCES_DIR: resourcesPath,
        MORTISE_RUNTIME_RESOURCES_BASE: resourcesBasePath,
        MORTISE_RUNTIME_BUNDLE_PATH: runtimePath,
        MORTISE_RUNTIME_ELECTRON_PATH: nodeRuntimePath,
        MORTISE_RUNTIME_NODE_PATH: nodeRuntimePath,
      },
      requireAssets: false,
    });
    if (!immutableRuntime) throw new Error('Expected immutable runtime fixture.');
    const context = {
      isPackaged: false,
      immutableRuntime,
    };

    try {
      expect(resolveScriptRuntime('node', context)).toMatchObject({ command: nodeRuntimePath, source: 'bundled' });
      expect(resolveScriptRuntime('bun', context)).toMatchObject({ command: bunRuntimePath, source: 'bundled' });
      expect(resolveScriptRuntime('python3', context)).toMatchObject({ command: uvRuntimePath, source: 'bundled' });

      unlinkSync(bunRuntimePath);
    } finally {
      if (previous.bun === undefined) delete process.env.MORTISE_BUN;
      else process.env.MORTISE_BUN = previous.bun;
      if (previous.node === undefined) delete process.env.MORTISE_NODE;
      else process.env.MORTISE_NODE = previous.node;
      if (previous.uv === undefined) delete process.env.MORTISE_UV;
      else process.env.MORTISE_UV = previous.uv;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
