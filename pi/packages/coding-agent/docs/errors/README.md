# Pi Errors and Troubleshooting

This directory collects common user-facing errors that can appear in pi, grouped by subsystem.

Use this directory as an index first, then open the category file that matches the error message.

## How to use this directory

1. Match the error text to the closest example below.
2. Open the linked category document.
3. Check the listed causes, settings, and relevant file paths.
4. If the message is provider-specific, also check `../providers.md` and `../settings.md`.

## Categories

- [Transient and provider errors](transient-and-provider.md)
  - Examples: `terminated`, `timeout`, `fetch failed`, `429`, `500`, `service unavailable`
  - Usually means a network, transport, quota, or upstream provider problem.

- [Compaction and context errors](compaction-and-context.md)
  - Examples: `Context overflow recovery failed`, `Summarization failed`, `Auto-compacting...`
  - Usually means the active conversation is too large or compaction failed.

- [Tools and filesystem errors](tools-and-filesystem.md)
  - Examples: `Command timed out after ... seconds`, `Command exited with code ...`, `Invalid URL`, `Offset ... is beyond end of file`
  - Usually means a tool input, environment, path, or command problem.

- [Sessions, themes, and extensions](sessions-themes-extensions.md)
  - Examples: `Entry ... not found`, `Cannot fork: ...`, `Theme not found`, `Invalid hex color`, `Extension runtime not initialized`
  - Usually means session state, theme config, or extension lifecycle issues.

- [Current environment installed extension errors](current-environment-installed-extensions.md)
  - Examples: `Ask tool failed: ...`, `No active pi session`, `MiMo model unavailable`, `Failed to toggle plan mode`
  - Environment-specific errors from installed extensions, not pi core.

## Quick lookup table

| Error text pattern | Likely meaning | Start here |
|---|---|---|
| `terminated` | Streaming request was interrupted | [Transient and provider errors](transient-and-provider.md) |
| `too many requests`, `429` | Rate limit or quota pressure | [Transient and provider errors](transient-and-provider.md) |
| `500`, `502`, `503`, `504`, `service unavailable` | Provider or upstream service failure | [Transient and provider errors](transient-and-provider.md) |
| `Context overflow` | Conversation exceeded model context | [Compaction and context errors](compaction-and-context.md) |
| `Summarization failed` | Compaction summarizer failed | [Compaction and context errors](compaction-and-context.md) |
| `Command timed out` | Shell command exceeded timeout | [Tools and filesystem errors](tools-and-filesystem.md) |
| `Command exited with code` | Shell command failed | [Tools and filesystem errors](tools-and-filesystem.md) |
| `Invalid URL` | `web_fetch` input is malformed | [Tools and filesystem errors](tools-and-filesystem.md) |
| `Offset ... is beyond end of file` | `read` offset is larger than file length | [Tools and filesystem errors](tools-and-filesystem.md) |
| `Entry ... not found` | Session branch/tree target no longer exists | [Sessions, themes, and extensions](sessions-themes-extensions.md) |
| `Theme not found` | Requested theme is missing | [Sessions, themes, and extensions](sessions-themes-extensions.md) |
| `Invalid hex color` | Theme file contains an invalid color value | [Sessions, themes, and extensions](sessions-themes-extensions.md) |
| `Extension runtime not initialized` | Extension used ctx too early during loading | [Sessions, themes, and extensions](sessions-themes-extensions.md) |
| `Ask tool failed` | Installed `ask_user` extension failed | [Current environment installed extension errors](current-environment-installed-extensions.md) |
| `No active pi session` | Installed `pi-remote` extension was used without an active session | [Current environment installed extension errors](current-environment-installed-extensions.md) |
| `MiMo model unavailable` | Installed `yourself` extension could not access its configured summarizer model | [Current environment installed extension errors](current-environment-installed-extensions.md) |

## Related documentation

- [Settings](../settings.md)
- [Providers](../providers.md)
- [Sessions](../sessions.md)
- [Themes](../themes.md)
- [Extensions](../extensions.md)
- [Compaction](../compaction.md)
- [Current environment installed extension errors](current-environment-installed-extensions.md)
