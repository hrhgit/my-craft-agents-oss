/**
 * Session Content Search Service
 *
 * Uses ripgrep to search session content (JSONL files).
 * Returns matches with session IDs and context snippets.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolveBackendHostTooling } from '@craft-agent/shared/agent/backend';
import { escapeRegExp as escapeRegex } from '@craft-agent/shared/utils/files';
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '../runtime/platform';

/**
 * Thrown when the search service cannot run (e.g. ripgrep binary not found).
 * Clients should catch this and show an "unavailable" state instead of "0 results".
 */
export class SearchUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SearchUnavailableError';
  }
}

// Track current search process to cancel on new search.
//
// DESIGN: Single-search-at-a-time policy. This is a module-level singleton,
// which means concurrent searches from multiple clients will interfere — a
// later search kills the previous search's ripgrep process. For the current
// single-client UX (user types in a search box), this is the intended
// "new query cancels old query" behavior. The cancelled search's Promise
// resolves via its 'close' handler with whatever partial results (or [])
// were collected, so callers never hang.
let currentSearchProcess: ChildProcess | null = null;

// Module-level platform ref — set once during init via setSearchPlatform()
let _platform: PlatformServices | null = null;

// Scoped loggers — upgraded from console fallback when setSearchPlatform() is called
let handlerLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'handler');
let searchLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'search');

export function setSearchPlatform(platform: PlatformServices): void {
  _platform = platform;
  handlerLog = createScopedLogger(platform.logger, 'handler');
  searchLog = createScopedLogger(platform.logger, 'search');
}

/**
 * Search result for a single match
 */
export interface SearchMatch {
  /** Session ID (extracted from file path) */
  sessionId: string;
  /** Line number in the JSONL file */
  lineNumber: number;
  /** The matched text snippet with context */
  snippet: string;
  /** The raw matched text (without context) */
  matchText: string;
}

/**
 * Aggregated search results for a session
 */
export interface SessionSearchResult {
  sessionId: string;
  /** Number of matches found in this session */
  matchCount: number;
  /** First few matches with context */
  matches: SearchMatch[];
}

/**
 * Options for session search
 */
export interface SearchOptions {
  /** Maximum time to wait for search (ms). Default: 5000 */
  timeout?: number;
  /** Maximum matches per session. Default: 3 */
  maxMatchesPerSession?: number;
  /** Maximum total sessions to return. Default: 50 */
  maxSessions?: number;
  /** Case insensitive search. Default: true */
  ignoreCase?: boolean;
  /** Search ID for correlating logs across stages */
  searchId?: string;
}

/** Extract a Craft session id from a flat Pi session JSONL filename. */
export function extractPiSessionIdFromPath(filePath: string): string | null {
  const fileName = filePath.split(/[/\\]/).pop();
  if (!fileName?.endsWith('.jsonl') || fileName === 'session.jsonl') return null;

  const withoutExt = fileName.slice(0, -'.jsonl'.length);
  const firstUnderscore = withoutExt.indexOf('_');
  const sessionId = firstUnderscore >= 0 ? withoutExt.slice(firstUnderscore + 1) : withoutExt;
  return sessionId || null;
}

/** Build the ripgrep pattern for Pi tree message entries. */
export function buildPiMessageSearchPattern(query: string): string {
  const escapedQuery = escapeRegex(query);
  return `"type"\\s*:\\s*"message".*"role"\\s*:\\s*"(user|assistant)".*${escapedQuery}`;
}

/**
 * Get the path to the ripgrep binary.
 * Path discovery is delegated to backend runtime tooling resolvers.
 */
function getRipgrepPath(): string | undefined {
  if (!_platform) throw new Error('setSearchPlatform() must be called before search');
  const { ripgrepPath } = resolveBackendHostTooling({
    hostRuntime: {
      appRootPath: _platform.appRootPath,
      resourcesPath: _platform.resourcesPath,
      isPackaged: _platform.isPackaged,
    },
  });
  return ripgrepPath;
}

/**
 * Extract a snippet from raw JSON line without full parsing.
 * Uses regex to extract content field and a window around the match.
 * This avoids expensive JSON.parse() on large message lines.
 */
function extractSnippetFast(rawLine: string, matchText: string, maxLength = 150): string {
  try {
    // Extract the "content" field value using regex
    // Handles both string content and the start of array content
    const contentMatch = rawLine.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    if (contentMatch) {
      // Simple string content - unescape and extract window around match
      const content = contentMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      const lowerContent = content.toLowerCase();
      const lowerMatch = matchText.toLowerCase();
      const matchPos = lowerContent.indexOf(lowerMatch);

      if (matchPos >= 0) {
        const halfLength = Math.floor(maxLength / 2);
        const start = Math.max(0, matchPos - halfLength);
        const end = Math.min(content.length, start + maxLength);

        let snippet = content.slice(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';
        return snippet;
      }

      // Match not in content field, return start of content
      if (content.length > maxLength) {
        return content.slice(0, maxLength) + '...';
      }
      return content;
    }

    // Content might be an array (Claude format) - extract first text block
    const textBlockMatch = rawLine.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (textBlockMatch) {
      const text = textBlockMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      if (text.length > maxLength) {
        return text.slice(0, maxLength) + '...';
      }
      return text;
    }

    // Fallback: extract a window around the match from raw line
    const lowerLine = rawLine.toLowerCase();
    const lowerMatch = matchText.toLowerCase();
    const matchPos = lowerLine.indexOf(lowerMatch);

    if (matchPos >= 0) {
      const halfLength = Math.floor(maxLength / 2);
      const start = Math.max(0, matchPos - halfLength);
      const end = Math.min(rawLine.length, start + maxLength);
      let snippet = rawLine.slice(start, end).replace(/\\n/g, ' ');
      if (start > 0) snippet = '...' + snippet;
      if (end < rawLine.length) snippet = snippet + '...';
      return snippet;
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * Search session content using ripgrep.
 *
 * @param query - Search query (plain text, will be escaped)
 * @param sessionsDir - Path to the sessions directory
 * @param options - Search options
 * @returns Promise resolving to array of session search results
 */
export async function searchSessions(
  query: string,
  sessionRoots: string | string[],
  options: SearchOptions = {}
): Promise<SessionSearchResult[]> {
  const {
    timeout = 5000,
    maxMatchesPerSession = 3,
    maxSessions = 50,
    ignoreCase = true,
    searchId = Date.now().toString(36),
  } = options;

  if (!query.trim()) {
    return [];
  }

  const startTime = Date.now();
  searchLog.info('ripgrep:start', { searchId, query });

  const rgPath = getRipgrepPath();
  handlerLog.debug('[search] Ripgrep path:', rgPath);
  if (!rgPath || !existsSync(rgPath)) {
    handlerLog.error('[search] ripgrep binary not found:', rgPath);
    throw new SearchUnavailableError(`ripgrep binary not found: ${rgPath ?? 'undefined'}`);
  }

  const searchTargets = Array.isArray(sessionRoots) ? sessionRoots : [sessionRoots];
  const existingTargets = searchTargets.filter(target => existsSync(target));
  handlerLog.debug('[search] Sessions targets:', existingTargets);
  if (existingTargets.length === 0) {
    handlerLog.warn('[search] No searchable session targets found');
    return [];
  }

  return new Promise((resolve) => {
    const results = new Map<string, SessionSearchResult>();
    let buffer = '';

    // Build ripgrep arguments
    const args = [
      '--json',           // JSON output format (NDJSON)
      '--max-count', '10', // Limit matches per file to prevent huge results
      '--max-depth', '1', // Pi sessions are flat files directly under the cwd bucket
      '-g', '*.jsonl',    // Match Pi flat {timestamp}_{sessionId}.jsonl files only
    ];

    if (ignoreCase) {
      args.push('-i');
    }

    // Pi flat JSONL stores transcript entries as type="message" with the role
    // nested inside `message`. Entry serialization places content after role,
    // so ripgrep can discard toolResult/custom lines before they reach Node.
    args.push('-e', buildPiMessageSearchPattern(query));
    args.push(...existingTargets);

    // Cancel previous search if still running. Per the single-search-at-a-time
    // policy (see currentSearchProcess declaration), the previous search's
    // Promise resolves with partial results via its 'close' handler — that
    // is the accepted cancellation signal, not a silent failure.
    if (currentSearchProcess) {
      // Platform-aware termination (SIGTERM doesn't exist on Windows)
      if (process.platform === 'win32') {
        currentSearchProcess.kill();
      } else {
        currentSearchProcess.kill('SIGTERM');
      }
      currentSearchProcess = null;
    }

    const rg = spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    currentSearchProcess = rg;

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      // Platform-aware termination (SIGTERM doesn't exist on Windows)
      if (process.platform === 'win32') {
        rg.kill();
      } else {
        rg.kill('SIGTERM');
      }
      handlerLog.warn('[search] Search timed out after', timeout, 'ms');
    }, timeout);

    rg.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const result = JSON.parse(line);

          // We only care about 'match' type results
          if (result.type !== 'match') continue;

          const data = result.data;
          const filePath = data.path?.text;
          if (!filePath) continue;

          const sessionId = extractPiSessionIdFromPath(filePath);
          if (!sessionId) continue;

          // Skip header line (line 1)
          const lineNumber = data.line_number;
          if (lineNumber === 1) continue;

          // Get the raw line content
          const rawLine = data.lines?.text || '';

          // Skip intermediate messages using fast string search (no JSON.parse needed)
          // This is much faster than parsing the entire message JSON
          if (rawLine.includes('"isIntermediate":true')) continue;

          // Skip messages with base64-encoded content (images, attachments)
          // The query can match inside base64 noise, producing false positives.
          // Covers both content blocks ("type":"base64") and attachment thumbnails.
          if (rawLine.includes('base64')) continue;

          // Get or create session result
          let sessionResult = results.get(sessionId);
          if (!sessionResult) {
            sessionResult = {
              sessionId,
              matchCount: 0,
              matches: [],
            };
            results.set(sessionId, sessionResult);
          }

          sessionResult.matchCount += data.submatches?.length || 1;

          // Only extract snippets for first maxSessions (skip expensive work for the rest)
          // ripgrep continues to count total sessions for "showing X of Y" display
          if (results.size <= maxSessions && sessionResult.matches.length < maxMatchesPerSession) {
            const matchText = data.submatches?.[0]?.match?.text || query;

            // Use fast snippet extraction (no JSON.parse)
            sessionResult.matches.push({
              sessionId,
              lineNumber,
              snippet: extractSnippetFast(rawLine, matchText),
              matchText,
            });
          }
        } catch (e) {
          // Skip malformed JSON lines
          handlerLog.debug('[search] Failed to parse ripgrep output:', e);
        }
      }
    });

    rg.stderr.on('data', (data: Buffer) => {
      handlerLog.warn('[search] ripgrep stderr:', data.toString());
    });

    // Log the command being executed
    handlerLog.debug('[search] Running ripgrep:', rgPath, args.join(' '));

    rg.on('close', (code) => {
      clearTimeout(timeoutHandle);
      // Clear reference if this is still the current search
      if (currentSearchProcess === rg) {
        currentSearchProcess = null;
      }

      if (code !== 0 && code !== 1) {
        // Exit code 1 means no matches found (not an error)
        handlerLog.debug('[search] ripgrep exited with code:', code);
      }

      // Convert map to array, sorted by match count (descending)
      const resultArray = Array.from(results.values());
      resultArray.sort((a, b) => b.matchCount - a.matchCount);

      searchLog.info('ripgrep:complete', {
        searchId,
        durationMs: Date.now() - startTime,
        totalSessions: results.size,
        returnedSessions: Math.min(resultArray.length, maxSessions),
      });

      resolve(resultArray);
    });

    rg.on('error', (error) => {
      clearTimeout(timeoutHandle);
      handlerLog.error('[search] ripgrep error:', error);
      resolve([]);
    });
  });
}
