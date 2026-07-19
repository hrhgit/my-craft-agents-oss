import { dirname, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { isWithin, isPathWithinDirectory } from '@mortise/shared/utils';

// Re-export unified isPathWithinDirectory from shared for existing consumers.
export { isPathWithinDirectory };

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
