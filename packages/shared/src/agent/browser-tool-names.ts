/**
 * Return the canonical browser tool name only for the exact runtime identity.
 */
export function normalizeCanonicalBrowserToolName(toolName: string): 'browser_tool' | null {
  return toolName === 'browser_tool' ? 'browser_tool' : null;
}

/**
 * True when a tool name is the canonical browser tool (with optional namespace prefix).
 */
export function isCanonicalBrowserToolName(toolName: string): boolean {
  return normalizeCanonicalBrowserToolName(toolName) === 'browser_tool';
}
