# Current Environment Installed Extension Errors

This file is environment-specific.

It documents error messages that may come from extensions installed in the current pi environment, not from pi core itself.

Do not treat this file as official cross-installation pi behavior. It only applies to the extensions currently found in these locations:

- Global extensions: `C:\Users\32858\.pi\agent\extensions\`
- Project extensions: `E:\_workSpace\_Agents\pi\.pi\extensions\`

## Installed extensions discovered

### Global extensions

- `ask_user`
- `pi-remote`
- `plan-mode`
- `yourself`
- `ambiguity-dictionary.ts`
- `notify.ts`
- `web-search-footer.ts`

### Project extensions

- `pi-remote`
- `prompt-url-widget.ts`
- `redraws.ts`
- `tps.ts`
- `web-search-footer.ts`

## Extension-specific errors

## `ask_user`

Primary path:
- `C:\Users\32858\.pi\agent\extensions\ask_user\`

Observed user-facing/custom error text:
- `Ask tool failed: ...`
- `User cancelled the question`

What it usually means:
- custom UI failed and the tool returned an error wrapper
- remote UI or fallback dialog path raised an exception
- the user cancelled or the prompt timed out and returned `null`

What to check:
- whether the environment supports the expected UI mode
- whether the tool was called with valid options
- whether timeout or cancellation was expected behavior

## `pi-remote`

Primary paths:
- `C:\Users\32858\.pi\agent\extensions\pi-remote\`
- `E:\_workSpace\_Agents\pi\.pi\extensions\pi-remote\`

Observed custom error text:
- `WebSocket frame too large`
- `Missing prompt text`
- `No active pi session`
- `Agent is busy; specify delivery as steer or followUp`
- `Missing provider or id`
- `Model not found: <provider>/<id>`
- `No API key available for model: <provider>/<id>`
- `Invalid thinking level`
- `Remote UI bridge unavailable`
- `Failed to toggle plan mode`

What it usually means:
- malformed remote API request body
- remote action sent before pi had an active session
- attempted direct prompt delivery while the agent was already busy
- requested model does not exist or is not authenticated
- plan mode bridge is not registered or not ready
- incoming websocket payload exceeded expected limits

What to check:
- remote request JSON shape
- active session state
- delivery mode (`steer` / `followUp`) when the agent is not idle
- model id and provider spelling
- API key availability for the selected model
- whether the remote UI bridge extension path is loaded and connected

## `yourself`

Primary path:
- `C:\Users\32858\.pi\agent\extensions\yourself\`

Observed custom/status error text:
- `Model not found: <provider>/<id>`
- `MiMo model unavailable`
- `YOURSELF scan failed`
- `Failed to start YOURSELF scan`
- `Summarization aborted`
- `Summary request error`
- `Summary request aborted`
- `Subagent-style Pi process exited with code ...`
- `Subagent-style Pi process finished with error`
- `Subagent-style Pi process returned no summary text`
- `Direct MiMo summary was empty`
- `YOURSELF scan aborted`
- `Missing YOURSELF summary task at index ...`
- `No API key or request headers for <provider>/<id>`
- `<label> contains Unicode replacement characters`

What it usually means:
- configured summarizer model is unavailable or unauthenticated
- the background scan worker failed or was aborted
- the subagent-style pi subprocess failed to produce valid summary output
- source material or intermediate output was malformed

What to check:
- summarizer model configuration and credentials
- whether another YOURSELF scan is already running
- worker lock state and prior scan status
- session history quality and whether source content is malformed

## `plan-mode`

Primary path:
- `C:\Users\32858\.pi\agent\extensions\plan-mode\`

Observed custom error text:
- no strong dedicated custom `throw new Error(...)` user-facing messages were found in the inspected code path

Possible operational failures still relevant:
- remote UI unavailable / disconnected fallback paths
- cancellation during raced TUI vs remote UI selection

What to check:
- whether remote UI is connected if the workflow expects it
- whether fallback to local editor/select UI is acceptable in the current mode

## `ambiguity-dictionary.ts`

Primary path:
- `C:\Users\32858\.pi\agent\extensions\ambiguity-dictionary.ts`

Observed user-facing/custom error text:
- `读取歧义词典失败：...`
- `用法：/ambiguity add <触发关键词> <含义描述>`

What it usually means:
- dictionary JSON file could not be read or parsed
- command arguments were incomplete

What to check:
- dictionary file path: `C:\Users\32858\.pi\agent\extensions\ambiguity-dictionary.json`
- JSON validity
- slash-command argument format

## `notify.ts`

Primary path:
- `C:\Users\32858\.pi\agent\extensions\notify.ts`

Observed custom error text:
- no explicit custom user-facing error strings were found in the extension source

Possible operational failures still relevant:
- notification command may fail silently if terminal or Windows toast environment is unavailable

## `web-search-footer.ts`

Primary paths:
- `C:\Users\32858\.pi\agent\extensions\web-search-footer.ts`
- `E:\_workSpace\_Agents\pi\.pi\extensions\web-search-footer.ts`

Observed custom error text:
- no explicit custom user-facing error strings were found in the extension source

Possible operational failures still relevant:
- footer rendering may omit or degrade status if expected session/model state is unavailable

## `prompt-url-widget.ts`, `redraws.ts`, `tps.ts`

Primary paths:
- `E:\_workSpace\_Agents\pi\.pi\extensions\prompt-url-widget.ts`
- `E:\_workSpace\_Agents\pi\.pi\extensions\redraws.ts`
- `E:\_workSpace\_Agents\pi\.pi\extensions\tps.ts`

Observed custom error text:
- not yet cataloged in this file

These project-level extensions were discovered, but no explicit error extraction was completed yet.

## How to use this file

1. First determine whether the error came from pi core or from an installed extension.
2. If the extension name appears in the UI, logs, or code path, check the matching section above.
3. If the extension is environment-specific, prefer these notes over generic pi documentation.
4. If needed, then inspect the extension source directly under its installed path.
