/**
 * Removes the volatile context Craft prepends to Pi user messages.
 *
 * Pi persists the complete model input, while transcript consumers must show
 * only the text the person actually sent.
 */
const LEADING_USER_DATE_CONTEXT_RE =
  /^\s*\*\*USER'S DATE AND TIME:[\s\S]*?\*\*\s*-\s*ALWAYS use this as the authoritative current date\/time\. Ignore any\s+other date information\.\s*/i;

const LEADING_CRAFT_CONTEXT_BLOCK_RE =
  /^\s*<(session_state|sources|source_issue)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i;

export function stripLeadingCraftInjectedUserContext(content: string): string {
  let stripped = false;
  let next = content;

  for (;;) {
    const before = next;
    next = next.replace(LEADING_USER_DATE_CONTEXT_RE, () => {
      stripped = true;
      return '';
    });
    next = next.replace(LEADING_CRAFT_CONTEXT_BLOCK_RE, () => {
      stripped = true;
      return '';
    });
    if (next === before) break;
  }

  return stripped ? next.trimStart() : content;
}
