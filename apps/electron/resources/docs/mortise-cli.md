# Mortise CLI Guide

`mortise-cli` connects over WebSocket (`ws://` or `wss://`) to a running
Mortise Agent server and provides commands for listing resources, managing
sessions, sending messages with real-time streaming, validating server health,
and managing automations through the host.

## Usage

```bash
mortise-cli <command> [args] [--flags]
```

### Connection flags
- `--url <ws|wss>` — server endpoint (defaults to the local agent server)
- `--token <token>` — server auth token
- `--workspace <id>` — target workspace for workspace-scoped commands
- `--timeout <ms>` — request timeout
- `--tls-ca <path>` — CA certificate for `wss://` self-signed servers

### Output flags
- `--json` — emit structured JSON output for the command result (default output is plain text)
- `--output-format <format>` — select an output formatter
- `--no-spinner` / `--disable-spinner` — disable progress spinners
- `--verbose` / `-v` — verbose logging

## Commands

### Info & health
- `mortise-cli ping` — verify connectivity (clientId + latency)
- `mortise-cli health` — check credential store health
- `mortise-cli versions` — show server runtime versions
- `mortise-cli --validate-server [--url <url> --token <token>]` — run the integration validation suite

### Resource listing
- `mortise-cli workspaces` — list all workspaces
- `mortise-cli sessions` — list sessions in the workspace
- `mortise-cli providers` — list AI providers

### Session operations
- `mortise-cli session create [--name <name>] <first-prompt>` — create a session with its first turn
- `mortise-cli session messages <session-id>` — print message history
- `mortise-cli session delete <session-id>` — delete a session
- `mortise-cli send <session-id> <message>` — send a message and stream the AI response in real time
- `mortise-cli cancel <session-id>` — cancel processing
- `mortise-cli operation get|wait|subscribe|cancel <operation-id>` — inspect or control a durable operation

### Power user
- `mortise-cli invoke <channel> [json-args...]` — raw RPC call for any channel
- `mortise-cli listen <channel>` — subscribe to push events (Ctrl+C to stop)
- `mortise-cli run <prompt>` — self-contained run (spawns a server automatically)
- `mortise-cli run --workspace-dir <dir> <prompt>` — run against a project directory

---

<!-- cli:automation:start -->
## Automation

Manage canonical workspace automations through a running Mortise host. The CLI
does not edit workspace files or run a separate scheduler.

### Commands
- `mortise-cli automation describe`
- `mortise-cli automation list`
- `mortise-cli automation get <id>`
- `mortise-cli automation validate <json|@file>`
- `mortise-cli automation create <json|@file> [--expected-revision <n|null>]`
- `mortise-cli automation update <json|@file> --expected-revision <n>`
- `mortise-cli automation delete <id> --expected-revision <n>`
- `mortise-cli automation set-enabled <id> <true|false> --expected-revision <n>`
- `mortise-cli automation run <id> [--trigger-id <id>]`
- `mortise-cli automation get-run <run-id>`
- `mortise-cli automation list-runs [--automation-id <id>] [--limit <n>]`
- `mortise-cli automation emit-event <json|@file>`
- `mortise-cli automation token path|rotate`

### Examples

```bash
mortise-cli --workspace ws-1 automation list
mortise-cli --workspace ws-1 automation create @automation.json --expected-revision null
mortise-cli --workspace ws-1 automation update @automation.json --expected-revision 3
mortise-cli --workspace ws-1 automation emit-event @event.json
mortise-cli --workspace ws-1 automation token path
```

### Notes
- Definition JSON uses protocol document version 3. Event, cron, once, and interval triggers share one definition format.
- Prompt and outbound webhook actions share the same run ledger and history.
- External input uses the loopback CloudEvents endpoint. `token path` exposes only the owner-only file path, not the token. The default local producer token accepts sources under `urn:mortise:external:` and event types under `mortise.`.
<!-- cli:automation:end -->

---

## Output

- Plain text by default; `--json` prints the command result data as JSON.
- Errors are printed to stderr as `Error: <message>` and exit with code `1`.
- Cancelled/interrupted streaming exits with code `130`.
