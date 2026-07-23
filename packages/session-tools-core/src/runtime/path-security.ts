import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? resolve(homedir(), path.slice(2)) : path;
}

function normalizeForComparison(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(normalizeForComparison(base), normalizeForComparison(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(expandHome(targetPath));
  const resolvedBase = resolve(expandHome(baseDir));
  if (!isWithin(resolvedBase, resolvedTarget)) return false;
  const realBase = realpathIfExists(resolvedBase);
  if (existsSync(resolvedTarget)) return isWithin(realBase, realpathSync.native(resolvedTarget));

  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) return isWithin(realBase, realpathSync.native(current));
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function realpathIfExists(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

/**
 * Containment check for output/creation paths.
 *
 * Prevents symlink escapes by validating the nearest existing ancestor's real path.
 */
export function isPathWithinDirectoryForCreation(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);

  if (existsSync(resolvedTarget)) {
    return isPathWithinDirectory(resolvedTarget, realBase);
  }

  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
