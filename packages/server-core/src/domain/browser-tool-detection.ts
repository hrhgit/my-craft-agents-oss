/**
 * Browser tool detection helpers.
 *
 * Browser overlay activation is now driven by the unified `browser_tool` only.
 * Runtime calls use `browser_tool`; legacy namespaced calls remain readable
 * when replaying stored sessions.
 */

import { normalizeCanonicalBrowserToolName } from '@mortise/shared/agent'

const BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS = new Set([
  '--help',
  '-h',
  'help',
  'open',
  'release',
  'close',
  'hide',
])

export function normalizeBrowserToolName(toolName: string): string | null {
  return normalizeCanonicalBrowserToolName(toolName)
}

export function getBrowserToolCommandVerb(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return ''

  const command = (toolInput as { command?: unknown }).command
  if (typeof command !== 'string') return ''

  return command.trim().toLowerCase().split(/\s+/)[0] || ''
}

export function shouldActivateBrowserOverlay(toolName: string, toolInput: unknown): boolean {
  const normalizedToolName = normalizeBrowserToolName(toolName)
  if (normalizedToolName !== 'browser_tool') return false

  const verb = getBrowserToolCommandVerb(toolInput)
  if (!verb) return false

  return !BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS.has(verb)
}

