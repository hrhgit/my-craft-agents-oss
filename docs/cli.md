# mortise-cli — CLI Reference

Terminal client for Mortise Agent server. Connects over WebSocket (`ws://` or `wss://`) to a running headless server.

## Prerequisites

- [Bun](https://bun.sh/) runtime installed
- For `run` and `--validate-server`: an API key via `--api-key`, `$LLM_API_KEY`, or a provider-specific env var (e.g., `$OPENAI_API_KEY`, `$GOOGLE_API_KEY`)
- For all other commands: a running Mortise Agent headless server with URL and token

## Installation

```bash
# Clone the repository
git clone https://github.com/anthropics/mortise.git
cd mortise

# Install dependencies
bun install

# Option A: Run directly
bun run apps/cli/src/index.ts <command>

# Option B: Link globally (adds mortise-cli to PATH)
cd apps/cli && bun link
mortise-cli <command>
```

### Quick Start

The fastest way to try it out — no server setup needed:

```bash
# Self-contained run (spawns a server automatically)
OPENAI_API_KEY=sk-... bun run apps/cli/src/index.ts run "Hello, world!"
```

## Connection Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--url <ws[s]://...>` | `MORTISE_SERVER_URL` | — | Server WebSocket URL |
| `--token <secret>` | `MORTISE_SERVER_TOKEN` | — | Authentication token |
| `--workspace <id>` | — | auto-detect | Workspace ID |
| `--timeout <ms>` | — | `10000` | Request timeout |
| `--tls-ca <path>` | `MORTISE_TLS_CA` | — | Custom CA cert for self-signed TLS |
| `--json` | — | `false` | Raw JSON output for scripting |
| `--send-timeout <ms>` | — | `300000` | Timeout for `send` command (5 min) |

Flags take precedence over environment variables. If `--workspace` is omitted, the CLI auto-detects the first available workspace.

## Commands

### Info & Health

```bash
mortise-cli ping              # Verify connectivity (clientId + latency)
mortise-cli health            # Check credential store health
mortise-cli versions          # Show server runtime versions
```

### Resource Listing

```bash
mortise-cli workspaces        # List all workspaces
mortise-cli sessions          # List sessions in workspace
mortise-cli providers         # List AI providers
```

### Session Operations

```bash
mortise-cli session create [--name <n>] [--mode <m>]  # Create session
mortise-cli session messages <id>                       # Print message history
mortise-cli session delete <id>                         # Delete session
mortise-cli cancel <id>                                 # Cancel processing
```

### Send Message (Streaming)

```bash
# Send a message and stream the AI response in real time
mortise-cli send <session-id> <message>

# Pipe text from stdin
echo "Summarize this file" | mortise-cli send <session-id>

# Read from stdin explicitly
cat document.txt | mortise-cli send <session-id> --stdin
```

The `send` command subscribes to session events and streams them to stdout:
- `text_delta` — text streamed inline
- `tool_start` — `[tool: name]` marker
- `tool_result` — tool output (truncated to 200 chars)
- `error` — printed to stderr, exit code 1
- `complete` — exit code 0
- `interrupted` — exit code 130

### Power User

```bash
# Raw RPC call — send any channel with JSON args
mortise-cli invoke <channel> [json-args...]

# Subscribe to push events (Ctrl+C to stop)
mortise-cli listen <channel>
```

Examples:
```bash
mortise-cli invoke system:homeDir
mortise-cli invoke sessions:get '"workspace-123"'
mortise-cli listen session:event
```

### Run (Self-Contained)

```bash
mortise-cli run <prompt>
mortise-cli run --workspace-dir ./project "Summarize this repository"
```

The `run` command is fully self-contained — it spawns a headless server, creates a session, sends the prompt, streams the response, and exits. No separate server setup needed. An API key is resolved from `--api-key`, `$LLM_API_KEY`, or a provider-specific env var (e.g., `$OPENAI_API_KEY`, `$GOOGLE_API_KEY`).

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace-dir <path>` | — | Register a workspace directory before running |
| `--output-format <fmt>` | `text` | Output format: `text` or `stream-json` |
| `--mode <mode>` | `allow-all` | Permission mode for the session |
| `--no-cleanup` | `false` | Skip session deletion on exit |
| `--server-entry <path>` | — | Custom server entry point |
| `--interactive` | `false` | Render versioned extension interactions and legacy RemoteUI dialogs (auto-cancels when omitted) |

**LLM Configuration:**

| Flag | Env Fallback | Default | Description |
|------|-------------|---------|-------------|
| `--provider <name>` | `LLM_PROVIDER` | `anthropic` | Provider: `anthropic`, `openai`, `google`, `openrouter`, `groq`, `mistral`, `xai`, etc. |
| `--model <id>` | `LLM_MODEL` | (provider default) | Model ID (e.g., `claude-sonnet-4-5-20250929`, `gpt-4o`, `gemini-2.0-flash`) |
| `--api-key <key>` | `LLM_API_KEY` | (provider env) | API key — also checks provider-specific vars like `$OPENAI_API_KEY` |
| `--base-url <url>` | `LLM_BASE_URL` | — | Custom endpoint for proxies, OpenRouter, or self-hosted models |

```bash
# Multi-provider examples
mortise-cli run --provider openai --model gpt-4o "Summarize this repo"
GOOGLE_API_KEY=... mortise-cli run --provider google --model gemini-2.0-flash "Hello"
mortise-cli run --provider anthropic --base-url https://openrouter.ai/api/v1 --api-key $OR_KEY "Hello"
```

Prompt can also be piped via stdin:
```bash
echo "Summarize this file" | mortise-cli run
cat error.log | mortise-cli run "What's causing these errors?"
```

### GUI-dependent tools unavailable in `run`

The `run` command drives a headless server process with no access to the Electron
renderer / Chromium window infrastructure. The following tools are therefore
**unavailable** when running sessions through the CLI:

| Tool | Reason |
|------|--------|
| `browser_tool` | Depends on the Electron app's built-in Chromium windows (`browser-pane:*` channels). The CLI cannot create, navigate, or snapshot browser panes. See `docs/browser-tools.md`. |
| Other renderer-only tools | Any tool relying on the Electron renderer process (rich previews, in-app notification surfaces) is not functional over the CLI. |

Pi extensions that use interaction V1 or legacy RemoteUI work with
`--interactive`, and degrade gracefully (auto-cancel) in the default
non-interactive mode.

### Automations

Automations use the host-owned `automation.workspace/v1` protocol. The CLI
never edits automation files or owns a scheduler.

```bash
mortise-cli --workspace <id> automation describe
mortise-cli --workspace <id> automation list
mortise-cli --workspace <id> automation get <automation-id>
mortise-cli --workspace <id> automation validate @definition.json
mortise-cli --workspace <id> automation create @definition.json --expected-revision null
mortise-cli --workspace <id> automation update @definition.json --expected-revision 4
mortise-cli --workspace <id> automation delete <automation-id> --expected-revision 4
mortise-cli --workspace <id> automation set-enabled <automation-id> false --expected-revision 4
mortise-cli --workspace <id> automation run <automation-id>
mortise-cli --workspace <id> automation get-run <run-id>
mortise-cli --workspace <id> automation list-runs --automation-id <automation-id> --limit 20
mortise-cli --workspace <id> automation emit-event @event.json
```

Mutating commands accept `--operation-id`; otherwise the CLI generates one.
Updates require the current revision. `run` and `emit-event` return after
durable acceptance; use `get-run` to query completion.

External programs use the loopback structured CloudEvents route:

```text
POST /api/automations/workspaces/<workspace-id>/events
Content-Type: application/cloudevents+json
Authorization: Bearer <workspace-capability-token>
```

`automation token path` discovers the owner-only token file and `automation
token rotate` replaces it. The token is absent from endpoint metadata and CLI
output. Events are limited to 1 MiB, and `202` is returned only after durable
acceptance. The default local producer credential is bound to CloudEvent
sources beginning with `urn:mortise:external:` and event types beginning with
`mortise.`; events outside those namespaces are rejected before persistence.

### Validate Server

```bash
# Against a running server
mortise-cli --validate-server --url ws://127.0.0.1:9100 --token <token>

# Self-contained (auto-spawns a server)
mortise-cli --validate-server
```

When no `--url` is provided, `--validate-server` automatically spawns a local headless server (same as the `run` command), runs the validation, and shuts it down.

Runs an integration test covering the full server lifecycle, including session, skill, branching, and automation workflows:

1. Connect + handshake
2. `credentials:healthCheck`
3. `system:versions`
4. `system:homeDir`
5. `workspaces:get`
6. `sessions:get`
7. `LLM_Connection:list`
8. `sessions:create` (temporary `__cli-validate-*` session)
9. `sessions:getMessages`
10. Send message + stream (text response)
11. Send message + tool use (Bash tool)
12. Exercise session self-management tools
13. Create and verify a branch
14. Send + skill create (writes SKILL.md via Bash)
15. `skills:get` and skill invocation
16. Exercise automation validation
17. Delete temporary skills, branches, sessions, and workspaces
18. Disconnect

**Note:** This test mutates workspace state by creating temporary sessions, skills, and automations. It cleans them up on completion, continues on failure, and reports a summary. Use `--json` for machine-readable output.

## Scripting Patterns

```bash
# Get workspace IDs
WORKSPACES=$(mortise-cli --json workspaces | jq -r '.[].id')

# Count sessions per workspace
for ws in $WORKSPACES; do
  COUNT=$(mortise-cli --json --workspace "$ws" sessions | jq length)
  echo "$ws: $COUNT sessions"
done

# Create a session and capture its ID
SESSION_ID=$(mortise-cli --json session create --name "CI Run" | jq -r '.id')

# Send a message and wait for completion
mortise-cli send "$SESSION_ID" "Run the test suite and report results"

# Clean up
mortise-cli session delete "$SESSION_ID"
```

## TLS / wss://

For remote servers with TLS:

```bash
# Trusted certificate (Let's Encrypt, etc.)
mortise-cli --url wss://server.example.com:9100 ping

# Self-signed certificate
mortise-cli --url wss://server.example.com:9100 --tls-ca /path/to/ca.pem ping
```

The `--tls-ca` flag sets `NODE_EXTRA_CA_CERTS` before connecting. You can also set `MORTISE_TLS_CA` in your environment.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Connection timeout` | Server not running or unreachable | Check server is started, verify URL |
| `AUTH_FAILED` | Wrong token | Check `MORTISE_SERVER_TOKEN` matches server |
| `PROTOCOL_VERSION_UNSUPPORTED` | Version mismatch | Update CLI and server to same version |
| `WebSocket connection error` | Network issue or TLS problem | For self-signed certs, use `--tls-ca` |
| `No workspace available` | Workspace not yet created | Create one via desktop app or API |
