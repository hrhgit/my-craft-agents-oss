# mortise-cli

Terminal client for Mortise Agent server. Connects over WebSocket to a running
Mortise Agent server (or spawns one locally for the `run` command) and provides
commands for listing resources, managing sessions, sending messages with
real-time streaming, and validating server health.

> **Not to be confused** with the `mortise` CLI documented in
> [`apps/electron/resources/docs/mortise-cli.md`](../../apps/electron/resources/docs/mortise-cli.md),
> which manages workspace config domains (labels / sources / skills / automations).
> This `mortise-cli` is the WebSocket client that drives a running server.

## Quick start

```bash
bun run src/index.ts run "What files are in the current directory?"
bun run src/index.ts ping
bun run src/index.ts --validate-server
```

## The `run` command

Spawns a local server, creates a session, streams the response, then exits.

```bash
mortise-cli run <message> [options]
```

| Flag | Description |
|------|-------------|
| `--workspace-dir <path>` | Use directory as workspace (creates if needed) |
| `--source <slug>` | Enable source (repeatable) |
| `--mode <mode>` | Permission mode (default: `allow-all`) |
| `--output-format` | `text` or `stream-json` (default: `text`) |
| `--no-cleanup` | Keep session after completion |
| `--server-entry` | Path to server/index.ts |
| `--interactive` | Render versioned extension interactions and legacy RemoteUI dialogs in the terminal |

## Pi extension interaction

The `run` command subscribes to the `extensions:EVENT` channel and forwards
versioned `extension_interaction_request` events and legacy `remoteui:request`
events from pi extensions to a terminal interaction handler.
Two modes are supported:

### Non-interactive mode (default)

When a pi extension requests interaction, the CLI **automatically responds
with a cancellation**. Versioned interactions receive a structured
`host-disconnected` response; legacy RemoteUI receives `payload=null`.
The extension is expected to degrade gracefully (e.g. skip the question, use
a default, or abort the operation). A one-line notice is written to stderr so
the user can see that an extension request was auto-cancelled (useful for
debugging).

This keeps non-interactive / CI runs unblocked — no request ever hangs waiting
for terminal input that will never come.

### Interactive mode (`--interactive`)

When `--interactive` is passed, the CLI renders a terminal dialog for each
interaction request and waits for the user to respond via stdin. Versioned
interactions support choice, text, multiline editor, and confirmation fields;
legacy requests retain the following adapters:

- **`select`** — Lists the options with numeric indices. The user enters a
  number (or comma-separated numbers when `allowMultiple` is set). If the
  request allows freeform input or an additional comment, follow-up prompts
  are shown.
- **`editor`** — Prompts the user to type multi-line text. An empty line
  finishes input. If the request ships a `prefill`, the user is asked whether
  to accept it as-is.

Interaction details:

- **Ctrl+C** cancels the *current* request only (responds with `null` +
  `reason="cancelled"`). The session keeps running; press Ctrl+C again (when no
  dialog is on screen) to cancel the whole session.
- If stdin is **not a TTY** (e.g. piped input), interactive mode automatically
  falls back to the non-interactive auto-cancel behaviour.
- No timeout is enforced by default — the dialog waits indefinitely for input.

## GUI-dependent tools unavailable in the CLI

The CLI drives a headless server process and has no access to the Electron
renderer / Chromium window infrastructure. The following tools are therefore
**unavailable** when running sessions through the CLI:

| Tool | Reason |
|------|--------|
| `browser_tool` | Strongly depends on the Electron app's built-in Chromium windows (`browser-pane:*` channels). The CLI cannot create, navigate, or snapshot browser panes. See [`docs/browser-tools.md`](../../apps/electron/resources/docs/browser-tools.md). |
| Other renderer-only tools | Any tool that relies on the Electron renderer process (e.g. rich previews, in-app notification surfaces) is not functional over the CLI. |

Pi extensions that use versioned interaction V1 or legacy RemoteUI work in
`--interactive` mode, and degrade gracefully in the default non-interactive
mode.

### Independent child-session windows (desktop-only)

The mortise desktop app can open pi session tree child sessions (branches
spawned via `spawn_session`) in independent UI windows — see the
SubagentPanel's "在独立窗口打开" button. This is a **desktop-only** feature:

- The CLI has no windowing infrastructure and does not expose the
  `window:openChildSessionWindow` IPC channel.
- Under the CLI, child sessions spawned via `spawn_session` run in the pi
  session tree but are not surfaced in a separate UI. Their output is
  captured in the pi session JSONL logs and can be inspected via
  `session messages <id>` or `listChildSessions` on the parent session.
- The `openChildSessionWindow` method on `ElectronAPI` is absent in CLI
  contexts; renderer code gates the button on
  `typeof window.electronAPI?.openChildSessionWindow === 'function'`.

## Other commands

```
ping                   Verify connectivity (clientId + latency)
health                 Check credential store health
versions               Show server runtime versions
workspaces             List workspaces
sessions               List sessions in workspace
providers              List AI providers
sources                List configured sources
session create         Create a session (--name, --mode)
session messages <id>  Print session message history
session delete <id>    Delete a session
send <id> <message>    Send message and stream AI response
cancel <id>            Cancel in-progress processing
invoke <channel> [...] Raw RPC call with JSON args
listen <channel>       Subscribe to push events (Ctrl+C to stop)
--validate-server      Multi-step server integration test
```

Run `mortise-cli --help` for the full, up-to-date flag listing.
