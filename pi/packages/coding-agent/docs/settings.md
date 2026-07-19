# Settings

Pi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `webSearch` | boolean | `true` | Enable provider built-in web search when the active model supports it |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://pi.dev/api/report-install`. Opting out of telemetry does not disable update checks; Pi can still fetch `https://pi.dev/api/latest-version` to look for the latest version.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Pi version update check. Package update checks are disabled by default and only run when `PI_CHECK_PACKAGE_UPDATES=1`/`true`/`yes` is set; `PI_SKIP_PACKAGE_UPDATE_CHECK=1` force-disables them. Set `PI_SKIP_TMUX_CHECK=1` to skip the tmux keyboard setup check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Pi sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |

Pi no longer exposes a user-selectable WebSocket transport mode. Streaming model HTTP/SSE requests use Pi's bundled sidecar when it is available. Use `network.mode: "proxy"` when sidecar/proxy egress is required; it fails closed if the sidecar is unavailable.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `network.mode` | string | `"auto"` | Route provider requests with `"auto"`, `"proxy"` (sidecar/proxy required), or `"direct"` |
| `network.proxy.enabled` | boolean | `true` | Enable configured proxy candidates for sidecar requests |
| `network.proxy.candidates` | string[] | `["http://127.0.0.1:7890", "http://127.0.0.1:7897", "http://127.0.0.1:7899"]` | Proxy URLs the sidecar can use for proxied egress |
| `network.proxy.probeTimeoutMs` | number | `500` | Reserved proxy health probe timeout |
| `network.proxy.statusCacheMs` | number | `15000` | Reserved proxy health cache duration |
| `network.sidecar.enabled` | boolean | `true` | Enable the bundled sidecar transport |
| `network.sidecar.binaryPath` | string | `""` | Override the sidecar executable path |
| `network.sidecar.restartBackoffMs` | number | `2000` | Delay before restarting a crashed sidecar |
| `network.sidecar.healthCheckIntervalMs` | number | `15000` | Sidecar health polling interval |
| `network.bypass.hosts` | string[] | `["localhost", "127.0.0.1", "::1", "*.local"]` | Hosts that route direct in `auto` mode unless a route rule or strict proxy mode overrides them |
| `network.bypass.cidrs` | string[] | `["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]` | CIDR ranges that route direct in `auto` mode unless a route rule or strict proxy mode overrides them |
| `network.routeRules` | array | `[]` | Per-host policy overrides: `"direct"`, `"proxy"` (required), `"direct-preferred"`, `"proxy-preferred"` |
| `network.timeouts.connectMs` | number | `15000` | TCP connect timeout for sidecar requests |
| `network.timeouts.tlsMs` | number | `15000` | TLS handshake timeout for sidecar requests |
| `network.timeouts.responseHeaderTimeoutMs` | number | `60000` | Time to wait for upstream response headers |
| `network.timeouts.idleStreamMs` | number | `90000` | Idle timeout once a response body starts streaming |
| `network.timeouts.totalMs` | number | `300000` | Total per-request timeout enforced by the sidecar |
| `network.retry.maxAttempts` | number | `2` | Sidecar transport retry attempts before surfacing a failure |
| `network.retry.baseDelayMs` | number | `500` | Base backoff delay between sidecar transport retries |
| `network.retry.maxDelayMs` | number | `3000` | Maximum backoff delay between sidecar transport retries |
| `network.retry.jitter` | boolean | `true` | Add jitter to sidecar transport retry backoff |
| `network.circuitBreaker.failureThreshold` | number | `3` | Consecutive failures before a route is marked open |
| `network.circuitBreaker.cooldownMs` | number | `60000` | Cooldown before retrying an open route |

`network.mode: "proxy"` and route rules with `policy: "proxy"` are hard egress boundaries: they do not fall back to direct connections. Use `proxy-preferred` when direct fallback is acceptable. Explicit route rules take precedence over default bypasses; use `policy: "direct"` for intentional direct exceptions.

Use `/network-reset` in interactive mode to clear in-process route circuit breaker state, pending retry routes, stale active request records, and restart the sidecar without starting a new session.

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell executable path or PATH command name (e.g., `"pwsh"` or `C:\\cygwin64\\bin\\bash.exe`) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pi/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | array | `[]` | Local extension objects with stable `id`, `path`, explicit `targets`, and optional activation/Manifest V1 metadata |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Extension entries may use object form to control activation and host targets:

```json
{
  "extensions": [
    { "id": "editor-ui", "path": "./extensions/editor-ui.ts", "activation": "startup", "targets": ["pi"] },
    { "id": "model-tools", "path": "./extensions/model-tools.ts", "activation": "beforeFirstRequest", "targets": ["pi"] },
    { "id": "mortise-ui", "path": "./extensions/mortise-ui.ts", "targets": ["mortise"] },
    { "id": "shared", "path": "./extensions/shared.ts", "targets": ["pi", "mortise"] }
  ]
}
```

`activation` can be `startup`, `beforeFirstRequest`, or `lazy`. Unspecified extension entries default to `beforeFirstRequest`, so they do not delay the first screen. `beforeFirstRequest` extensions still finish loading before Pi sends the first model request.

`targets` can contain `pi`, `mortise`, or both and must be explicit on declared entries. Mortise hosts pass `extensionTarget: "mortise"` to load only Mortise-compatible entries. Published extensions should also declare Manifest V1 metadata with version, author, and matching engine ranges.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

#### extensionConfig

Per-extension namespace configuration keyed by extension name. Allows overriding the model, toggling enable/disable, and setting concurrency limits for individual extensions.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `extensionConfig.<name>.model` | string | - | Model override for this extension |
| `extensionConfig.<name>.enabled` | boolean | `true` | When `false`, the extension is skipped during loading |
| `extensionConfig.<name>.concurrency` | number | - | Concurrency limit for this extension's operations |

```json
{
  "extensionConfig": {
    "repo-memory": {
      "model": "gpt-5.5",
      "enabled": true,
      "concurrency": 4
    },
    "trace-audit": {
      "enabled": false
    }
  }
}
```

Extensions with `enabled: false` are filtered out during resource loading — their tools, commands, and flags are not registered. When `enabled` is absent, the extension defaults to enabled.

**Compatibility note:** Mortise Agent historically writes these values under the `extensions` field as a namespace object (e.g., `extensions.repo-memory.model`). The Pi SDK reads from both `extensionConfig.<name>` (preferred) and `extensions.<name>` (legacy/mortise) for the `model`, `enabled`, and `concurrency` keys. The `extensions` field as a path array (for loading local extension files) remains unchanged.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pi/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
