/**
 * Strip UTF-8 BOM (Byte Order Mark) from a string.
 * BOM (\uFEFF) can appear when files are written by certain editors or tools
 * and causes JSON.parse() to fail with "Unexpected token" errors.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * Extract a string message from an unknown error value.
 * Replaces the repeated `error instanceof Error ? error.message : String(error)` pattern.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse a JSON string, stripping any leading UTF-8 BOM.
 * Use this instead of raw JSON.parse() for any content that may originate from a file.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(stripBom(text));
}

/**
 * Escape special regex characters in a string so it can be used as a literal
 * pattern inside a RegExp. Shared canonical implementation.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
