# Mortise

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

Mortise is an independently maintained, user-extensible desktop Agent platform. It combines a multi-session Electron client, a headless/WebUI server, the Pi agent runtime, sources, skills, automations, and extension-contributed UI.

This repository owns its release line and package identities. Mortise does not import updates from the repositories it was forked from, and it does not assume any hosted Mortise cloud service exists. Optional update, viewer, OAuth relay, and documentation MCP endpoints are deployment configuration.


## Installation

### Build from Source

```bash
git clone https://github.com/hrhgit/mortise.git
cd mortise
bun install
bun run electron:start
```

Release installers can be built with `build-package.cmd` on Windows or the platform scripts under `apps/electron/scripts/`. The existing icon is a temporary placeholder until Mortise artwork is ready.

## Features

- **Multi-Session History**: Desktop app with session management, unread tracking, search, and deletion
- **Claude Code Experience**: Streaming responses, tool visualization, real-time updates
- **Multiple LLM Connections**: Add multiple AI providers and set per-workspace defaults
- **Multi-Provider Support**: Run sessions with Google AI Studio, ChatGPT Plus, GitHub Copilot, or OpenAI API keys alongside Anthropic
- **MCP Integration**: Connect local and remote Model Context Protocol servers
- **Sources**: Connect to MCP servers, REST APIs (Google, Slack, Microsoft), and local filesystems
- **Permission Modes**: Three-level system (Explore, Ask to Edit, Auto) with customizable rules
- **Background Tasks**: Run long-running operations with progress tracking
- **Dynamic Status System**: Customizable session workflow states (Todo, In Progress, Done, etc.)
- **Theme System**: Cascading themes at app and workspace levels
- **Multi-File Diff**: VS Code-style window for viewing all file changes in a turn
- **Skills**: Specialized agent instructions stored per-workspace
- **File Attachments**: Drag-drop images, PDFs, Office documents with auto-conversion
- **Automations**: Event-driven automation — create agent sessions on label changes, schedules, tool use, and more

## Quick Start

1. **Launch the app** after installation
2. **Choose API Connection**: Use Anthropic (API key or Claude Max), Google AI Studio, ChatGPT Plus (Codex OAuth), or GitHub Copilot OAuth
3. **Create a workspace**: Set up a workspace to organize your sessions
4. **Connect sources** (optional): Add MCP servers, REST APIs, or local filesystems
5. **Start chatting**: Create sessions and interact with Claude

## Desktop App Features

### Session Management

- **Inbox/Archive**: Sessions organized by workflow status
- **Flagging**: Mark important sessions for quick access
- **Status Workflow**: Todo → In Progress → Needs Review → Done
- **Session Naming**: AI-generated titles or manual naming
- **Session Persistence**: Full conversation history saved to disk

### Sources

Connect external data sources to your workspace:

| Type | Examples |
|------|----------|
| **MCP Servers** | Mortise, Linear, GitHub, Notion, custom servers |
| **REST APIs** | Google (Gmail, Calendar, Drive, YouTube, Search Console), Slack, Microsoft |
| **Local Files** | Filesystem, Obsidian vaults, Git repos |

### Permission Modes

| Mode | Display | Behavior |
|------|---------|----------|
| `safe` | Explore | Read-only, blocks all write operations |
| `ask` | Ask to Edit | Prompts for approval (default) |
| `allow-all` | Auto | Auto-approves all commands |

Use **SHIFT+TAB** to cycle through modes in the chat interface.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New chat |
| `Cmd+1/2/3` | Focus sidebar/list/chat |
| `Cmd+/` | Keyboard shortcuts dialog |
| `SHIFT+TAB` | Cycle permission modes |
| `Enter` | Send message |
| `Shift+Enter` | New line |

## Remote Server (Headless)

Mortise can run as a headless server on a remote machine (e.g., a Linux VPS), with the desktop app connecting as a thin client. This lets you keep long-running sessions alive, access them from multiple machines, and run compute-heavy tasks on a powerful server.

### Quick Start

From the monorepo root:

```bash
# Generate a token and start the server
MORTISE_SERVER_TOKEN=$(openssl rand -hex 32) bun run packages/server/src/index.ts
```

The server prints the connection details on startup:

```
MORTISE_SERVER_URL=ws://203.0.113.5:9100
MORTISE_SERVER_TOKEN=<generated-token>
```

Copy these values and use them to connect the desktop app.

### Connecting the Desktop App

Launch the Electron app in thin-client mode by passing the server URL and token:

```bash
MORTISE_SERVER_URL=wss://203.0.113.5:9100 MORTISE_SERVER_TOKEN=<token> bun run electron:start
```

In thin-client mode, the desktop app renders the UI but all session logic, tool execution, and LLM calls run on the remote server.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MORTISE_SERVER_TOKEN` | Yes | — | Bearer token for client authentication |
| `MORTISE_RPC_HOST` | No | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `MORTISE_RPC_PORT` | No | `9100` | Bind port |
| `MORTISE_RPC_TLS_CERT` | No | — | Path to PEM certificate file (enables `wss://`) |
| `MORTISE_RPC_TLS_KEY` | No | — | Path to PEM private key file (required with cert) |
| `MORTISE_RPC_TLS_CA` | No | — | Path to PEM CA chain file (optional, for client cert verification) |
| `MORTISE_DEBUG` | No | `false` | Enable debug logging |

### TLS (Recommended for Remote Access)

When exposing the server over the network, TLS encrypts the WebSocket connection (`wss://` instead of `ws://`).

**Generate a self-signed certificate (development/testing):**

```bash
./scripts/generate-dev-cert.sh
# Creates certs/cert.pem and certs/key.pem (valid 365 days)
```

**Start the server with TLS:**

```bash
MORTISE_SERVER_TOKEN=<token> \
MORTISE_RPC_HOST=0.0.0.0 \
MORTISE_RPC_TLS_CERT=certs/cert.pem \
MORTISE_RPC_TLS_KEY=certs/key.pem \
bun run packages/server/src/index.ts
```

The server will print `MORTISE_SERVER_URL=wss://<your-public-ip>:9100`.

**For production**, use certificates from a trusted CA (e.g., Let's Encrypt) or place the server behind a reverse proxy (nginx, Caddy) that terminates TLS.

### Docker

```bash
docker run -d \
  -p 9100:9100 \
  -e MORTISE_SERVER_TOKEN=<token> \
  -e MORTISE_RPC_HOST=0.0.0.0 \
  -v mortise-data:/root/.mortise \
  mortise-server
```

To enable TLS in Docker, mount your certificates and set the env vars:

```bash
docker run -d \
  -p 9100:9100 \
  -e MORTISE_SERVER_TOKEN=<token> \
  -e MORTISE_RPC_HOST=0.0.0.0 \
  -e MORTISE_RPC_TLS_CERT=/certs/cert.pem \
  -e MORTISE_RPC_TLS_KEY=/certs/key.pem \
  -v ./certs:/certs:ro \
  -v mortise-data:/root/.mortise \
  mortise-server
```

## CLI Client

A terminal client that connects to a running Mortise Agent server over WebSocket (`ws://` or `wss://`). Use it for scripting, CI/CD pipelines, server validation, or when you prefer the command line.

### Installation

```bash
# From the monorepo (requires Bun)
bun run apps/cli/src/index.ts --help

# Or add to your PATH
alias mortise-cli="bun run $(pwd)/apps/cli/src/index.ts"
```

### Connection

The CLI reads connection details from flags or environment variables:

```bash
# Via environment (set once)
export MORTISE_SERVER_URL=ws://127.0.0.1:9100
export MORTISE_SERVER_TOKEN=<your-token>

# Or via flags
mortise-cli --url ws://127.0.0.1:9100 --token <token> ping
```

For TLS connections (`wss://`), use `--tls-ca <path>` for self-signed certificates.

### Commands

| Command | Description |
|---------|-------------|
| `ping` | Verify connectivity (clientId + latency) |
| `health` | Check credential store health |
| `versions` | Show server runtime versions |
| `workspaces` | List workspaces |
| `sessions` | List sessions in workspace |
| `connections` | List LLM connections |
| `sources` | List configured sources |
| `session create` | Create a session (`--name`, `--mode`) |
| `session messages <id>` | Print session message history |
| `session delete <id>` | Delete a session |
| `send <id> <message>` | Send message and stream AI response |
| `cancel <id>` | Cancel in-progress processing |
| `invoke <channel> [args]` | Raw RPC call with JSON args |
| `listen <channel>` | Subscribe to push events (Ctrl+C to stop) |
| `run <prompt>` | Self-contained: spawn server, run prompt, stream response, exit |
| `--validate-server` | 21-step integration test (auto-spawns server if no `--url`) |

#### Run Command Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace-dir <path>` | — | Register a workspace directory before running |
| `--source <slug>` | — | Enable a source (repeatable) |
| `--output-format <fmt>` | `text` | Output format: `text` or `stream-json` |
| `--mode <mode>` | `allow-all` | Permission mode for the session |
| `--no-cleanup` | `false` | Skip session deletion on exit |
| `--server-entry <path>` | — | Custom server entry point |
| `--provider <name>` | `anthropic` | LLM provider (`anthropic`, `openai`, `google`, `openrouter`, `groq`, `mistral`, `xai`, etc.) |
| `--model <id>` | (provider default) | Model ID (e.g., `claude-sonnet-4-5-20250929`, `gpt-4o`, `gemini-2.0-flash`) |
| `--api-key <key>` | — | API key (or `$LLM_API_KEY`, or provider-specific env var) |
| `--base-url <url>` | — | Custom API endpoint for proxies or self-hosted models |

The `run` command is fully self-contained — it spawns a headless server, creates a session, sends the prompt, streams the response, and exits. No separate server setup needed. An API key is resolved from `--api-key`, `$LLM_API_KEY`, or a provider-specific env var (e.g., `$OPENAI_API_KEY`, `$GOOGLE_API_KEY`).

### Examples

```bash
# Quick connectivity check
mortise-cli ping

# List sessions (human-readable)
mortise-cli sessions

# Send a message and stream the AI response
mortise-cli send abc-123 "What files are in the current directory?"

# Pipe input
echo "Summarize this" | mortise-cli send abc-123

# JSON output for scripting
mortise-cli --json workspaces | jq '.[].name'

# Self-contained run (spawns its own server)
mortise-cli run "Summarize the README"
mortise-cli run --workspace-dir ./my-project --source github "List open PRs"

# Multi-provider support
mortise-cli run --provider openai --model gpt-4o "Summarize this repo"
GOOGLE_API_KEY=... mortise-cli run --provider google --model gemini-2.0-flash "Hello"
mortise-cli run --provider anthropic --base-url https://openrouter.ai/api/v1 --api-key $OR_KEY "Hello"

# Validate the server (auto-spawns if no --url)
mortise-cli --validate-server
mortise-cli --validate-server --url ws://127.0.0.1:9100 --token <token>
```

## Architecture

```
mortise/
├── apps/
│   ├── cli/                   # Terminal client (CLI)
│   └── electron/              # Desktop GUI (primary)
│       └── src/
│           ├── main/          # Electron main process
│           ├── preload/       # Context bridge
│           └── renderer/      # React UI (Vite + shadcn)
└── packages/
    ├── core/                  # Shared types
    └── shared/                # Business logic
        └── src/
            ├── agent/         # MortiseAgent, permissions
            ├── auth/          # OAuth, tokens
            ├── config/        # Storage, preferences, themes
            ├── credentials/   # pi auth.json thin wrapper (plaintext, 0600)
            ├── sessions/      # Session persistence
            ├── sources/       # MCP, API, local sources
            └── statuses/      # Dynamic status system
```

## Development

```bash
# Hot reload development (portmux-managed)
bun run electron:dev

# Build and run
bun run electron:start

# Type checking
bun run typecheck:all

# Debug logging (writes to ~/Library/Logs/@mortise/electron/)
# Logs are automatically enabled in development
```

On Windows, you can also double-click [`start-quick-test.cmd`](./start-quick-test.cmd) from the repo root to launch the portmux-managed Electron hot-reload development build. To switch modes from a terminal, run `start-quick-test.cmd start`, `start-quick-test.cmd server-dev`, or `start-quick-test.cmd webui-dev`.

To launch the complete browser UI development environment on Windows, double-click [`start-webui.cmd`](./start-webui.cmd) or run `portmux start`. It starts the authenticated headless server and Vite WebUI, automatically signs the local browser in, and opens the URL assigned by portmux. The RPC server uses the following port (`WebUI + 1`) and the shared `~/.mortise` configuration. Double-click `start-webui.cmd` again to open another browser client connected to the same running WebUI; it does not start another backend or create an isolated configuration directory. Double-click [`stop-webui.cmd`](./stop-webui.cmd) to stop every portmux-managed WebUI project for this repository and clean up legacy untracked WebUI process trees.

Electron, standalone WebUI, RPC development server, and the component playground have separate portmux identities. Start them with `bun run electron:dev`, `bun run webui:dev`, `bun run server:dev`, and `bun run playground:dev`; each listens directly on its own assigned port. Electron, the WebUI headless server, and standalone server modes all use `~/.mortise` by default. Set `MORTISE_CONFIG_DIR` when an isolated profile is needed.

### Environment Variables

OAuth integrations (Slack, Microsoft) require credentials baked into the build. Create a `.env` file:

```bash
MICROSOFT_OAUTH_CLIENT_ID=your-client-id
SLACK_OAUTH_CLIENT_ID=your-slack-client-id
SLACK_OAUTH_CLIENT_SECRET=your-slack-client-secret
```

**Note:** Google OAuth credentials are NOT baked into the build. Users provide their own credentials via source configuration. See the [Google OAuth Setup](#google-oauth-setup-gmail-calendar-drive) section below.

### Google OAuth Setup (Gmail, Calendar, Drive, YouTube, Search Console)

Google integrations require you to create your own OAuth credentials. This is a one-time setup.

#### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Note your Project ID

#### 2. Enable Required APIs

Go to **APIs & Services → Library** and enable the APIs you need:
- **Gmail API** - for email integration
- **Google Calendar API** - for calendar integration
- **Google Drive API** - for file storage integration

#### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** user type (unless you have Google Workspace)
3. Fill in required fields:
   - App name: e.g., "My Mortise Agent"
   - User support email: your email
   - Developer contact: your email
4. Add scopes (optional - can leave default)
5. Add yourself as a test user (required for External apps in testing mode)
6. Complete the wizard

#### 4. Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth Client ID**
3. Application type: **Desktop app**
4. Name: e.g., "Mortise Agent Desktop"
5. Click **Create**
6. Note the **Client ID** and **Client Secret**

#### 5. Configure in Mortise Agent

When setting up a Google source (Gmail, Calendar, Drive, YouTube, Search Console, etc.), add these fields to your source's `config.json`:

```json
{
  "api": {
    "googleService": "gmail",
    "googleOAuthClientId": "your-client-id.apps.googleusercontent.com",
    "googleOAuthClientSecret": "your-client-secret"
  }
}
```

Or simply tell the agent you want to connect Gmail/Calendar/Drive - it will guide you through entering your credentials.

#### Security Notes

- Credentials are stored in `~/.pi/agent/auth.json` under Mortise's `mortise.*` namespace. This file follows Pi CLI behavior: plaintext JSON with restrictive file permissions.
- Never commit credentials to version control
- For production use, consider getting your OAuth consent screen verified by Google

## Supported LLM Providers

Mortise supports multiple ways to connect to LLM providers:

### Direct Connections

| Provider | Auth | Notes |
|----------|------|-------|
| **Anthropic** | API key or Claude Max/Pro OAuth | Claude connection through the Pi provider runtime |
| **Google AI Studio** | API key | Gemini models with native Google Search grounding built in |
| **ChatGPT Plus / Pro** | Codex OAuth | Sign in with your ChatGPT subscription — uses OpenAI's Codex models |
| **GitHub Copilot** | OAuth (device code) | One-click authentication with your Copilot subscription |

### Third-Party & Self-Hosted Providers

Additional providers are supported through compatible provider connections by choosing a custom endpoint:

| Provider | Endpoint | Notes |
|----------|----------|-------|
| **OpenRouter** | `https://openrouter.ai/api` | Access Claude, GPT, Llama, Gemini, and hundreds of other models through a single API key. Use `provider/model-name` format (e.g. `anthropic/claude-opus-4.7`). |
| **Vercel AI Gateway** | `https://ai-gateway.vercel.sh` | Route requests through Vercel's AI Gateway with built-in observability and caching. |
| **Ollama** | `http://localhost:11434` | Run open-source models locally. No API key required. |
| **Custom** | Any URL | Any OpenAI-compatible or Anthropic-compatible endpoint. |

### Architecture

Mortise uses a single agent backend:

- **Pi** — powered by the Pi SDK, which handles Anthropic-compatible Claude connections, Google AI Studio, ChatGPT Plus (Codex OAuth), GitHub Copilot OAuth, OpenAI API key connections, and custom provider endpoints. Legacy `anthropic` provider identifiers are kept as compatibility aliases and route through this backend.

## Configuration

Configuration is stored at `~/.mortise/`:

```
~/.mortise/
├── config.json              # Main config (workspaces, LLM connections)
├── preferences.json         # User preferences
├── theme.json               # App-level theme
└── workspaces/
    └── {id}/
        ├── config.json      # Workspace settings
        ├── theme.json       # Workspace theme override
        ├── automations.json  # Event-driven automations
        ├── sources/         # Connected sources
        └── statuses/        # Status configuration
```

Credentials are stored at `~/.pi/agent/auth.json`. Session data (JSONL) is stored at `~/.pi/agent/sessions/`.
Project skills are stored at `<workspace>/.pi/skills/`; global skills are stored at `~/.pi/agent/skills/`.

Legacy `~/.mortise/credentials.enc` files are not silently imported into `auth.json`; upgrade migration backs up and clears the old path. Re-enter API keys or re-authenticate OAuth connections after upgrading from a pre-unification build.

### Automations

Automations let you automate workflows by triggering actions when events happen — labels change, sessions start, tools run, or on a cron schedule.

**Just ask the agent:**
- "Set up a daily standup briefing every weekday at 9am"
- "Notify me when a session is labelled urgent"
- "Track permission mode changes and summarise them"
- "Every Friday at 5pm, summarise this week's completed tasks"

Or configure manually in `~/.mortise/workspaces/{id}/automations.json`:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "America/New_York",
        "actions": [
          { "type": "prompt", "prompt": "Check @github for new issues assigned to me" }
        ]
      }
    ]
  }
}
```

**Prompt actions** create a new agent session with a prompt. They support `@mentions` for sources and skills, and environment variables like `$MORTISE_EVENT` and `$MORTISE_SESSION_ID` are expanded automatically.

**Supported events:** `PermissionModeChange`, `SchedulerTick`, `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, and more.

See the [bundled Automations documentation](apps/electron/resources/docs/automations.md) for the full reference.

## Advanced Features

### Large Response Handling

Tool responses exceeding ~60KB are automatically summarized using Claude Haiku with intent-aware context. The `_intent` field is injected into MCP tool schemas to preserve summarization focus.

### Deep Linking

External apps can navigate using `mortise://` URLs:

```
mortise://allSessions                      # All sessions view
mortise://allSessions/session/session123   # Specific session
mortise://settings                         # Settings
mortise://sources/source/github            # Source info
mortise://action/new-chat                  # Create new session
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Bun](https://bun.sh/) |
| AI | Pi SDK agent server and provider runtime |
| Desktop | [Electron](https://www.electronjs.org/) + React |
| UI | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4 |
| Build | esbuild (main) + Vite (renderer) |
| Credentials | pi auth.json (~/.pi/agent/auth.json, plaintext JSON, 0600 permissions) |

## Troubleshooting

### Debug Mode

To launch the packaged app with verbose logging enabled, use `-- --debug` (note the double dash separator):

**macOS:**
```bash
/Applications/Mortise\ Agents.app/Contents/MacOS/Mortise\ Agents -- --debug
```

**Windows (PowerShell):**
```powershell
& "$env:LOCALAPPDATA\Programs\@mortiseelectron\Mortise.exe" -- --debug
```

**Linux:**
```bash
./mortise -- --debug
```

Logs are written to:
- **macOS:** `~/Library/Logs/@mortise/electron/main.log`
- **Windows:** `%APPDATA%\@mortise\electron\logs\main.log`
- **Linux:** `~/.config/@mortise/electron/logs/main.log`

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

The former upstream trademark policy is retained only for legal provenance in [UPSTREAM-TRADEMARK.md](UPSTREAM-TRADEMARK.md). It is not Mortise branding policy.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

### Local MCP Server Isolation

When spawning local MCP servers (stdio transport), sensitive environment variables are filtered out to prevent credential leakage to subprocesses. Blocked variables include:

- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (app auth)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `STRIPE_SECRET_KEY`, `NPM_TOKEN`

To explicitly pass an env var to a specific MCP server, use the `env` field in the source config.

To report security vulnerabilities, please see [SECURITY.md](SECURITY.md).
