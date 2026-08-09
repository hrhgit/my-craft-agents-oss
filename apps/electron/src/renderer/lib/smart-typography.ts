/**
 * Smart Typography - Live text replacement for typographic symbols
 *
 * Transforms trigger when user types a space after the pattern.
 * This avoids complex partial-match handling and feels natural.
 *
 * Supported patterns:
 * - -> → (right arrow)
 * - <- → ← (left arrow)
 * - <-> → ↔ (left-right arrow)
 * - => → ⇒ (double right arrow)
 * - <=> → ⇔ (double bidirectional arrow)
 * - -- → – (en-dash)
 * - ... → … (ellipsis)
 * - != → ≠ (not equal)
 */

interface Replacement {
  /** Pattern to match (followed by space) */
  pattern: string
  /** Replacement character/string */
  replacement: string
}

/**
 * Ordered list of replacements - longer patterns first to avoid partial matches
 */
const REPLACEMENTS: Replacement[] = [
  // Longer patterns first
  { pattern: '<=>', replacement: '⇔' },
  { pattern: '<->', replacement: '↔' },
  { pattern: '...', replacement: '…' },
  // Shorter patterns
  { pattern: '->', replacement: '→' },
  { pattern: '<-', replacement: '←' },
  { pattern: '=>', replacement: '⇒' },
  { pattern: '--', replacement: '–' },
  { pattern: '!=', replacement: '≠' },
]

interface SmartTypographyResult {
  /** The transformed text */
  text: string
  /** The adjusted cursor position */
  cursor: number
  /** Whether a replacement was made */
  replaced: boolean
}

export interface SmartTypographyReplacement {
  from: number
  to: number
  text: string
  cursor: number
}

export function findSmartTypographyReplacement(
  text: string,
  cursor: number
): SmartTypographyReplacement | null {
  if (cursor === 0 || text[cursor - 1] !== ' ' || isInsideCode(text, cursor)) {
    return null
  }

  const textBeforeSpace = text.slice(0, cursor - 1)
  for (const { pattern, replacement } of REPLACEMENTS) {
    if (!textBeforeSpace.endsWith(pattern)) continue
    const from = cursor - 1 - pattern.length
    return {
      from,
      to: cursor - 1,
      text: replacement,
      cursor: cursor - (pattern.length - replacement.length),
    }
  }

  return null
}

/**
 * Check if cursor is inside a code block (backticks)
 * Simple heuristic: count backticks before cursor, odd = inside code
 */
function isInsideCode(text: string, cursor: number): boolean {
  const textBeforeCursor = text.slice(0, cursor)

  // Check for triple backticks (code blocks)
  const tripleBackticks = (textBeforeCursor.match(/```/g) || []).length
  if (tripleBackticks % 2 === 1) return true

  // Check for single backticks (inline code) - but not triple
  // Remove triple backticks first, then count singles
  const withoutTriple = textBeforeCursor.replace(/```/g, '')
  const singleBackticks = (withoutTriple.match(/`/g) || []).length
  return singleBackticks % 2 === 1
}

/**
 * Apply smart typography replacements to text
 *
 * Transforms trigger when user types a space after a pattern.
 * e.g., "hello -> " becomes "hello → "
 *
 * @param text - The current input text
 * @param cursor - The current cursor position
 * @returns Object with transformed text, adjusted cursor, and whether replacement occurred
 */
export function applySmartTypography(
  text: string,
  cursor: number
): SmartTypographyResult {
  const replacement = findSmartTypographyReplacement(text, cursor)
  if (replacement) {
    return {
      text: text.slice(0, replacement.from) + replacement.text + text.slice(replacement.to),
      cursor: replacement.cursor,
      replaced: true,
    }
  }

  // No replacement made
  return { text, cursor, replaced: false }
}
