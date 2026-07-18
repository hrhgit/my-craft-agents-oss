# YOURSELF Extension

Global Pi memory consolidation example.

On `session_start`, this extension scans all Pi sessions with `SessionManager.listAll()`, excludes the current session, summarizes historical sessions with the user-configured `mimo/mimo-v2.5-pro` model, and writes daily Markdown memory notes to:

```text
~/.pi/agent/YOURSELF/YYYY-MM-DD.md
```

State and lock files live under:

```text
~/.pi/agent/YOURSELF/.state/
```

## Behavior

- Global only: no project-local mode.
- Does not inject anything into the model prompt.
- Uses checkpointing to resume after interruption.
- Uses a PID lock with stale-lock recovery.
- Uses atomic file writes.
- Skips assistant thinking, truncates tool results, and applies basic secret redaction.
- Dedupes Markdown blocks with deterministic hash markers.
- Shows a footer status spinner via `ctx.ui.setStatus()`.
- Provides `/yourself status` and `/yourself reset`.
- `/yourself reset` moves the current `YOURSELF` directory to a timestamped backup and starts a fresh scan.

## Run

```bash
pi --extension packages/coding-agent/examples/extensions/yourself/index.ts
```

The extension first attempts a subagent-style child Pi JSON-mode summarizer invocation, following the `pi-subagents` process-isolation pattern. If that child process fails, it falls back to a direct `mimo` completion through the current `ctx.modelRegistry`.
