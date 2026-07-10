/**
 * Browser-safe path string helpers.
 *
 * These functions intentionally do not touch the filesystem, call path.resolve(),
 * or depend on process.platform. Use utils/paths.ts for Node filesystem paths.
 */

/**
 * Normalize a path to use forward slashes for consistent cross-platform comparison.
 * Use this before comparing paths or using regex patterns on paths.
 *
 * @example
 * normalizePath('C:\\Users\\foo\\bar') // 'C:/Users/foo/bar'
 * normalizePath('/Users/foo/bar')      // '/Users/foo/bar' (unchanged)
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function stripTrailingSlashes(path: string): string {
  if (path === '/' || /^[A-Za-z]:\/$/.test(path)) {
    return path;
  }
  return path.length > 1 ? path.replace(/\/+$/g, '') : path;
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

/**
 * Normalize a path for string-only cross-platform comparison.
 * Windows paths are compared case-insensitively; POSIX-looking paths keep case.
 */
export function normalizePathForComparison(path: string): string {
  const normalized = stripTrailingSlashes(normalizePath(path));
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Check if a file path starts with a directory path (cross-platform).
 * Handles both Windows backslashes and Unix forward slashes.
 *
 * @example
 * pathStartsWith('C:\\Users\\foo\\file.txt', 'C:\\Users\\foo') // true
 * pathStartsWith('/home/user/file.txt', '/home/user')          // true
 * pathStartsWith('/home/user2/file.txt', '/home/user')         // false
 */
export function pathStartsWith(filePath: string, dirPath: string): boolean {
  const normalizedFile = normalizePathForComparison(filePath);
  const normalizedDir = normalizePathForComparison(dirPath);
  const dirWithSeparator = normalizedDir.endsWith('/') ? normalizedDir : `${normalizedDir}/`;
  return normalizedFile.startsWith(dirWithSeparator) || normalizedFile === normalizedDir;
}

/**
 * Strip a directory prefix from a path (cross-platform).
 * Returns the relative path portion after the prefix.
 *
 * @example
 * stripPathPrefix('/home/user/docs/file.txt', '/home/user') // 'docs/file.txt'
 * stripPathPrefix('C:\\foo\\bar\\baz.txt', 'C:\\foo')       // 'bar/baz.txt'
 */
export function stripPathPrefix(filePath: string, prefix: string): string {
  const normalizedFile = normalizePath(filePath);
  const normalizedPrefix = stripTrailingSlashes(normalizePath(prefix));
  const comparisonFile = normalizePathForComparison(filePath);
  const comparisonPrefix = normalizePathForComparison(prefix);
  const comparisonPrefixWithSeparator = comparisonPrefix.endsWith('/') ? comparisonPrefix : `${comparisonPrefix}/`;

  if (comparisonFile === comparisonPrefix) {
    return '';
  }

  if (comparisonFile.startsWith(comparisonPrefixWithSeparator)) {
    const prefixLength = normalizedPrefix.endsWith('/') ? normalizedPrefix.length : normalizedPrefix.length + 1;
    return normalizedFile.slice(prefixLength);
  }
  return filePath;
}
