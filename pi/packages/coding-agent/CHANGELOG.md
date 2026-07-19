# Changelog

## [Unreleased]

### Added

- Added a dedicated `app.message.steer` shortcut for queuing steering messages without changing editor submit behavior.
- Added `ctrl+y` redo support for the interactive editor.
- Added the local `web_fetch` built-in tool and a persisted `webSearch` setting for supported provider built-in web search.
- Added built-in active session/workspace tracking for `/switch`, with workspace-first selection and path browsing.
- Added `/network-reset` to clear in-process network routing state and restart the sidecar without starting a new session.
- Added extension activation stages so extensions can load at startup, before the first model request, or lazily.
- Added extension target declarations so Pi and Mortise hosts can load only compatible extensions.
- Added the development-only `ctx.ui.validation` contract for extensions to publish host-validated UI readiness, actions, scenarios, and semantic state over RPC.

### Changed

- Changed `/compact` and auto compaction to use the cache-friendly append summarizer directly, removed the experimental `/compact-ori` and `/compact-cache` commands, and stopped writing compaction comparison debug artifacts.
- Changed coding-agent HTTP/SSE model requests to prefer the bundled Go sidecar transport path when it is available, and removed user-visible WebSocket transport selection from interactive settings.
- Changed coding-agent build and release artifacts to include prebuilt Go sidecar binaries for supported platforms.
- Changed the default system prompt to include concise tool-use discipline for reducing redundant exploration, repeated failures, and path-guessing.
- Changed large-file `read` preflight to use file metadata before reading content.
- Changed interactive startup to defer skills, prompt templates, context files, themes, and non-startup extensions until the first request preparation step.
- Changed startup package update checks to stay disabled unless `PI_CHECK_PACKAGE_UPDATES=1` is set.

### Fixed

- Fixed Mortise extension target validation to reject legacy or unknown targets instead of loading them as current Mortise extensions.
- Fixed Windows clipboard image paste to fall back to the Windows Clipboard API via PowerShell when the native clipboard addon does not expose copied screenshot or browser image data.
- Fixed sidecar-backed HTTP fetches to stream `text/event-stream` responses incrementally instead of buffering until the upstream response completes.
- Fixed extension access to the shared session activity registry so background agents use the active runtime `agentDir` instead of falling back to the global config directory, and updated the subagent example to publish logical agent activity while delegated tasks run.
- Fixed `/switch` workspace tracking to prune removed temp workspaces and immediately record switched sessions under the selected workspace.
- Fixed the Node CLI bundle startup crash when Markdown rendering lazily loads `marked` from the published `pi-coding-agent` package.
- Fixed opening and listing very large JSONL session files by reading session entries line-by-line instead of materializing the full file as one string ([#5231](https://github.com/hrhgit/mortise/issues/5231)).
- Fixed edit path recovery to auto-recover only from successful read history while leaving observed search/list paths available for read recovery.

### Removed

- Removed the experimental `pi mux` terminal multiplexer mode.
- Removed the experimental built-in tool result deduplication short-circuiting.
