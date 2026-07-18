# Sessions, Themes, and Extensions

These errors usually come from session state, theme configuration, or extension lifecycle mistakes.

## Session errors

Common messages:
- `Entry ... not found`
- `Cannot fork: source session file is empty or invalid: ...`
- `Cannot fork: source session has no header: ...`
- `Cannot export in-memory session to HTML`
- `Nothing to export yet - start a conversation first`

Typical causes:
- branch or tree target no longer exists
- corrupted or partial session file
- exporting before there is persisted session content

What to do:
- use `/session` to inspect the active session
- use `/resume` to open a valid saved session
- avoid manual edits to JSONL session files unless you know the format
- check `../sessions.md` and `../session-format.md`

## Theme errors

Common messages:
- `Theme not found: ...`
- `Invalid hex color: ...`
- `Invalid color value: ...`
- `Unknown theme color: ...`
- `Unknown theme background color: ...`

Typical causes:
- wrong theme name
- malformed color literal
- unsupported color token in theme config
- bad variable reference in theme data

What to do:
- verify the theme file path and selected theme name
- use valid hex values like `#RRGGBB`
- compare with built-in themes and `../themes.md`

## Extension errors

Common messages:
- `Extension runtime not initialized`
- `This extension ctx is stale after session replacement or reload ...`
- extension shortcut conflict warnings

Typical causes:
- calling action methods during extension load
- using a captured ctx after `newSession`, `fork`, `switchSession`, or `reload`
- shortcut key collisions between extensions and built-ins

What to do:
- do not call runtime-dependent actions during extension loading
- after session replacement, use the fresh ctx provided by the runtime
- inspect shortcut conflicts and adjust keybindings
- check `../extensions.md` and `../keybindings.md`

## Relevant files

- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/export-html/index.ts`
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
