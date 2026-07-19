# Automations Configuration Guide

This guide explains how to configure automations in Mortise Agent to automate workflows based on events.

> **CLI-first workflow (recommended):** Use `mortise automation ...` commands instead of editing JSON directly.
> - `mortise automation --help`
> - Canonical command reference: [mortise-cli.md](./mortise-cli.md)

## What Are Automations?

Automations allow you to trigger actions automatically when specific events occur in Mortise Agent. You can:
- Send prompts to create agent sessions based on events
- Send webhook HTTP requests to external services (Slack, Discord, custom APIs, etc.)
- Execute actions on a schedule using cron expressions
- Automate workflows based on permission mode changes, flags, or session status changes

## automations.json Location

Automations are configured in `automations.json` at the root of your workspace:

```
~/.mortise/workspaces/{workspaceId}/automations.json
```

## Recommended CLI Commands

```bash
mortise automation list
mortise automation get <id>
mortise automation create --event UserPromptSubmit --prompt "..."
mortise automation update <id> --json '{...}'
mortise automation enable <id>
mortise automation disable <id>
mortise automation duplicate <id>
mortise automation history [<id>] --limit 20
mortise automation last-executed <id>
mortise automation test <id> --match "..."
mortise automation lint
mortise automation validate
```

## Basic Structure

```json
{
  "version": 2,
  "automations": {
    "EventName": [
      {
        "name": "Optional display name",
        "matcher": "regex-pattern",
        "actions": [
          { "type": "prompt", "prompt": "Check for updates and report status" }
        ]
      }
    ]
  }
}
```

## Supported Events

### App Events (triggered by Mortise Agent)

| Event | Trigger | Match Value |
|-------|---------|-------------|
| `PermissionModeChange` | Permission mode changed | New mode name |
| `SchedulerTick` | Runs every minute | Uses cron matching |

### Agent Events

| Event | Trigger | Match Value |
|-------|---------|-------------|
| `PreToolUse` | Before a tool executes | Tool name |
| `PostToolUse` | After a tool executes successfully | Tool name |
| `PostToolUseFailure` | After a tool execution fails | Tool name |
| `Notification` | Notification received | - |
| `UserPromptSubmit` | User submits a prompt | - |
| `SessionStart` | Session starts | - |
| `SessionEnd` | Session ends | - |
| `Stop` | Agent stops | - |
| `SubagentStart` | Subagent spawned | - |
| `SubagentStop` | Subagent completes | - |
| `PreCompact` | Before context compaction | - |
| `PermissionRequest` | Permission requested | - |
| `Setup` | Initial setup | - |

## Action Types

### Prompt Actions

Send a prompt to Mortise Agent (creates a new session for scheduled prompts).

```json
{
  "type": "prompt",
  "prompt": "Run the @weather skill and summarize the forecast"
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"prompt"` | Required | Action type |
| `prompt` | string | Required | Prompt text to send |
| `provider` | string | Workspace default | Pi provider key (configured in AI Settings) |
| `model` | string | Workspace default | Model ID for the created session |

**Features:**
- Use `@mentions` to reference sources or skills
- Environment variables are expanded (e.g., `$MORTISE_LABEL`)

**Provider & Model:** Optionally specify which AI provider and model to use for the created session. If omitted, the global defaults are used.

```json
{
  "type": "prompt",
  "prompt": "Quick code review of recent changes",
  "provider": "github-copilot",
  "model": "gemini-2.5-flash"
}
```

The `provider` value is a Pi provider key configured in AI Settings. The `model` value is a model ID supported by that provider. If either is invalid or unavailable, Mortise falls back to the global default. Both can be used independently or together.

#### Pi Prompt Automation 委托

默认情况下，prompt action 由 mortise 的 `AutomationSystem` 自行处理（创建新的 agent 会话）。

启用配置项 `piExtensions.delegatePromptAutomation`（默认 `false`）后，prompt action 的执行会委托给 [pi prompt-automation 扩展](https://github.com/hrhgit/mortise) 处理，而不是由 mortise 创建会话。启用后：

- `PromptHandler` 收集到待执行的 prompts 时，会通过 `extension_command_invoke` RPC 触发 pi prompt-automation 扩展的命令（如 `/schedule-prompt`），由扩展负责实际执行。
- mortise 的 `AutomationSystem` 仍保留为 workspace 级 UI/RPC/配置层（automations.json 配置、历史、测试、调度），仅 prompt 执行路径发生切换。
- 该选项默认关闭，不影响现有行为。回滚时将其设回 `false` 即可恢复 mortise 自行处理。

> **Note:** 该委托路径依赖 pi 扩展加载与桥接层。若 pi 扩展未加载或桥接层未就绪，启用该选项后 prompts 将不会被执行。详见 [Pi 扩展集成](./pi-extensions.md)（若存在）。

### Webhook Actions

Send an HTTP request to an external endpoint when an event fires. Useful for notifications (Slack, Discord), logging to external services, or triggering external workflows.

```json
{
  "type": "webhook",
  "url": "https://hooks.slack.com/services/${MORTISE_WH_SLACK_PATH}",
  "method": "POST",
  "body": {
    "text": "Session ${MORTISE_SESSION_NAME} status changed to ${MORTISE_NEW_STATE}"
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"webhook"` | Required | Action type |
| `url` | string | Required | Target URL (http or https) |
| `method` | `"GET"` \| `"POST"` \| `"PUT"` \| `"PATCH"` \| `"DELETE"` | `"POST"` | HTTP method |
| `headers` | `Record<string, string>` | `{}` | HTTP headers as key-value pairs |
| `bodyFormat` | `"json"` \| `"form"` \| `"raw"` | `"json"` | Body serialization format |
| `body` | object or string | - | Request body (omitted for GET requests) |
| `auth` | object | - | Authentication shorthand (see below) |
| `captureResponse` | boolean | `false` | Capture response body in result (truncated to 4KB) |

> **URL validation:** Literal URLs are validated at config load time. Templated URLs (containing `$VAR`) are validated at runtime after variable expansion. Both must resolve to `http://` or `https://` — other protocols are rejected.

**Body format:**
- `json` (default) — Body is serialized as JSON. `Content-Type: application/json` is set automatically unless you override it in `headers`.
- `form` — Body object keys are URL-encoded as `application/x-www-form-urlencoded`. Useful for OAuth token endpoints, Stripe, and legacy APIs. Each value supports `$VAR` expansion.
- `raw` — Body is sent as a plain string. Set `Content-Type` in `headers` yourself.

**Authentication:**

Instead of manually constructing `Authorization` headers, you can use the `auth` shorthand:

**Bearer token:**
```json
{
  "type": "webhook",
  "url": "https://api.example.com/events",
  "auth": {
    "type": "bearer",
    "token": "${MORTISE_WH_API_TOKEN}"
  },
  "body": { "event": "$MORTISE_EVENT" }
}
```

**Basic auth (username/password):**
```json
{
  "type": "webhook",
  "url": "https://legacy.example.com/webhook",
  "auth": {
    "type": "basic",
    "username": "${MORTISE_WH_USER}",
    "password": "${MORTISE_WH_PASS}"
  }
}
```

The `auth` field is applied before custom `headers`, so you can override the generated `Authorization` header if needed. All auth field values support `$VAR` expansion.

**Response capture:** By default, webhook response bodies are discarded after reading (to release connections). Set `captureResponse: true` to capture the response body (truncated to 4KB). The captured body is included in the execution result and recorded in automation history (truncated to 500 chars).

```json
{
  "type": "webhook",
  "url": "https://api.example.com/status",
  "method": "GET",
  "captureResponse": true
}
```

> **Note:** Response capture adds memory overhead proportional to the response size. Only enable it for endpoints where you need to inspect the response.

**Variable expansion:** The `url`, `headers` values, `body`, and `auth` fields all support `$VAR` and `${VAR}` syntax for environment variable expansion. See [Environment Variables](#environment-variables) below.

**Security:** Webhook actions only have access to `MORTISE_*` system variables and `MORTISE_WH_*` user-defined secrets. They do **not** have access to your full system environment (e.g., `$HOME`, `$PATH`, or other process variables).

## Environment Variables

Both prompt and webhook actions support variable expansion using `$VAR` or `${VAR}` syntax.

### System Variables (MORTISE_*)

These are automatically set by the automation system based on the triggering event:

| Variable | Description | Available For |
|----------|-------------|---------------|
| `$MORTISE_EVENT` | Event name (e.g., `PreToolUse`) | All events |
| `$MORTISE_EVENT_DATA` | Full event payload as JSON | All events |
| `$MORTISE_SESSION_ID` | Session ID | Events with session context |
| `$MORTISE_SESSION_NAME` | Session name | Events with session context |
| `$MORTISE_WORKSPACE_ID` | Workspace ID | All events |

**Per-event variables:**

| Event | Variable | Description |
|-------|----------|-------------|
| `PermissionModeChange` | `$MORTISE_OLD_MODE`, `$MORTISE_NEW_MODE` | Previous and new permission mode |
| `SchedulerTick` | `$MORTISE_LOCAL_TIME`, `$MORTISE_LOCAL_DATE` | Current time (`14:30`) and date (`2026-03-09`) |

### User-Defined Webhook Secrets (MORTISE_WH_*)

For webhook actions, you can define your own secrets by setting environment variables with the `MORTISE_WH_` prefix in your shell profile (e.g., `~/.zshrc`, `~/.bashrc`):

```bash
# In your shell profile
export MORTISE_WH_SLACK_URL="https://hooks.slack.com/services/T.../B.../xxx"
export MORTISE_WH_DISCORD_URL="https://discord.com/api/webhooks/123/abc"
export MORTISE_WH_API_TOKEN="your-secret-token"
```

Then reference them in `automations.json`:

```json
{
  "type": "webhook",
  "url": "${MORTISE_WH_SLACK_URL}",
  "method": "POST",
  "body": { "text": "Hello from Mortise Agent!" }
}
```

```json
{
  "type": "webhook",
  "url": "https://api.example.com/events",
  "headers": { "Authorization": "Bearer ${MORTISE_WH_API_TOKEN}" },
  "body": { "event": "${MORTISE_EVENT}", "session": "${MORTISE_SESSION_NAME}" }
}
```

This keeps secrets out of `automations.json` (which may be shared or committed to version control).

> **Note:** Only variables prefixed with `MORTISE_WH_` are injected into webhook actions. Other environment variables (like `$HOME` or `$DATABASE_URL`) are not accessible to webhooks.

> **Note:** Environment variables are not expanded during test runs (the "Test" button in the UI). Tests send the raw URL/body as configured.

## Matcher Configuration

### Display Name

Use the optional `name` field to give an automation a human-readable display name. If omitted, the name is automatically derived from the first action.

```json
{
  "name": "Morning Weather Report",
  "cron": "0 8 * * *",
  "actions": [
    { "type": "prompt", "prompt": "Run the @weather skill" }
  ]
}
```

### Regex Matching (for most events)

Use the `matcher` field to filter which events trigger your automations:

```json
{
  "matcher": "^urgent$",
  "actions": [
    { "type": "prompt", "prompt": "An urgent label was added. Review the session and summarise the issue." }
  ]
}
```

If `matcher` is omitted, the automation triggers for all events of that type.

### Cron Matching (for SchedulerTick)

For `SchedulerTick` events, use cron expressions instead of regex:

```json
{
  "cron": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "actions": [
    { "type": "prompt", "prompt": "Give me a morning briefing" }
  ]
}
```

**Cron format:** `minute hour day-of-month month day-of-week`

| Field | Values |
|-------|--------|
| Minute | 0-59 |
| Hour | 0-23 |
| Day of month | 1-31 |
| Month | 1-12 |
| Day of week | 0-6 (0 = Sunday) |

**Examples:**
- `*/15 * * * *` - Every 15 minutes
- `0 9 * * *` - Daily at 9:00 AM
- `0 9 * * 1-5` - Weekdays at 9:00 AM
- `30 14 1 * *` - 1st of each month at 2:30 PM

**Timezone:** Use IANA timezone names (e.g., `Europe/Budapest`, `America/New_York`). Defaults to system timezone if not specified.

## Conditions

Conditions are optional filters that run **after** the matcher/cron matches but **before** actions fire. All conditions in the array must pass (implicit AND). If the array is empty or omitted, actions fire unconditionally.

```json
{
  "cron": "0 9 * * *",
  "timezone": "Europe/Budapest",
  "conditions": [
    {
      "condition": "time",
      "weekday": ["mon", "tue", "wed", "thu", "fri"]
    }
  ],
  "actions": [
    { "type": "prompt", "prompt": "Good morning! Here's your daily briefing." }
  ]
}
```

### Time Conditions

Check time-of-day and day-of-week in a given timezone.

```json
{
  "condition": "time",
  "after": "09:00",
  "before": "17:00",
  "weekday": ["mon", "tue", "wed", "thu", "fri"],
  "timezone": "Europe/Budapest"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `after` | `"HH:MM"` | Start of time window (inclusive) |
| `before` | `"HH:MM"` | End of time window (exclusive) |
| `weekday` | `string[]` | Allowed days: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` |
| `timezone` | string | IANA timezone. Falls back to matcher timezone, then system local |

**Overnight ranges:** If `after` is later than `before` (e.g., `"after": "22:00", "before": "06:00"`), the range wraps across midnight.

### State Conditions

Check fields from the event payload. Useful for filtering on specific transitions or values.

```json
{
  "condition": "state",
  "field": "permissionMode",
  "from": "safe",
  "to": "allow-all"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `field` | string | Payload field name (for example, `permissionMode` or `sessionName`) |
| `value` | any | Exact match |
| `from` | any | Previous value (for transition events) |
| `to` | any | New value (for transition events) |
| `contains` | string | Array or string membership check |
| `not_value` | any | Matches anything except this value |

**Transition fields:** For `permissionMode`, `from`/`to` automatically resolve to `oldMode`/`newMode`.

### Logical Composition

Combine conditions with `and`, `or`, and `not`:

```json
{
  "condition": "and",
  "conditions": [
    { "condition": "time", "weekday": ["mon", "tue", "wed", "thu", "fri"] },
    { "condition": "time", "after": "09:00", "before": "17:00" }
  ]
}
```

```json
{
  "condition": "or",
  "conditions": [
    { "condition": "state", "field": "permissionMode", "value": "allow-all" },
    { "condition": "time", "after": "09:00", "before": "17:00" }
  ]
}
```

```json
{
  "condition": "not",
  "conditions": [
    { "condition": "time", "weekday": ["sat", "sun"] }
  ]
}
```

| Type | Behaviour |
|------|-----------|
| `and` | All sub-conditions must pass |
| `or` | At least one sub-condition must pass |
| `not` | None of the sub-conditions may pass |

**Nesting depth:** Conditions can be nested up to 8 levels deep. A simplification warning is emitted at depth 4. Unknown condition types fail closed (evaluate to false).

## Permission Mode

The `permissionMode` field controls the permission level of sessions created by prompt actions.

```json
{
  "cron": "*/10 * * * *",
  "permissionMode": "allow-all",
  "actions": [
    { "type": "prompt", "prompt": "Check system health and log the results" }
  ]
}
```

**Permission modes:**
- `safe` - Session runs in Explore mode (default)
- `ask` - Session prompts for approval before write operations
- `allow-all` - Session auto-approves all operations

## Telegram Topic Routing

When a Telegram supergroup is paired in **Settings → Messaging → Telegram**, set
`telegramTopic` on a matcher to route its spawned sessions into a dedicated
forum topic. The topic is created on first use and reused thereafter.

```json
{
  "telegramTopic": "Urgent Alerts",
  "actions": [
    { "type": "prompt", "prompt": "Review the latest alert and summarize it." }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `telegramTopic` | string (1–128 chars) | Topic name. Created on first use, reused thereafter. Multiple matchers using the same value share one topic. |

**Activation requirements** (all must hold; otherwise the field is silently ignored):

- A Telegram supergroup is paired in Settings → Messaging → Telegram
- The Telegram bot is connected
- The bot has the **Manage Topics** admin permission

Names are case-sensitive: `"Reports"` and `"reports"` create separate topics.

### Setting up the Telegram supergroup

If you haven't paired a supergroup yet:

1. **Create / convert a supergroup with Topics enabled.** In Telegram, open the group → tap the group name → Edit (pencil icon) → toggle **Topics** on → Save. The group must be a forum supergroup; regular groups can't host topics.
2. **Add the bot to the supergroup.** Group name → Add members → search for your bot's username → add.
3. **Promote the bot to admin with "Manage Topics".** Group name → Edit → Administrators → Add Administrator → pick the bot → toggle on **Manage Topics** → Save. This is the step most people miss; without it, topic creation fails with `400: not enough rights to create a topic`.
4. **Pair the supergroup.** In Mortise Agent: Settings → Messaging → Telegram → **Pair Supergroup**. Copy the 6-digit code, then in any topic of the supergroup type `/pair <code>`. The bot confirms and the Settings row updates with the group's title.

Verify by checking the supergroup row in Settings shows the group title. If automation runs fail later, `~/.mortise/logs/messaging-gateway.log` will show `automation_topic_bind_failed` with the underlying Telegram error.

## Complete Examples

### Daily Weather Report

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Daily Weather Report",
        "cron": "0 8 * * *",
        "timezone": "Europe/Budapest",
        "actions": [
          { "type": "prompt", "prompt": "Run the @weather skill and give me today's forecast" }
        ]
      }
    ]
  }
}
```

### Weekday-Only AI News (with Conditions)

Use a `time` condition to restrict a daily schedule to weekdays only:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Morning AI news",
        "cron": "0 9 * * *",
        "timezone": "Europe/Budapest",
        "conditions": [
          {
            "condition": "time",
            "weekday": ["mon", "tue", "wed", "thu", "fri"],
            "timezone": "Europe/Budapest"
          }
        ],
        "actions": [
          { "type": "prompt", "prompt": "Run the @ai-news skill and summarize today's AI developments" }
        ]
      }
    ]
  }
}
```

### Permission Mode Gate (with Conditions)

Only notify when permission mode changes specifically from `safe` to `allow-all`:

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "conditions": [
          {
            "condition": "state",
            "field": "permissionMode",
            "from": "safe",
            "to": "allow-all"
          }
        ],
        "actions": [
          {
            "type": "webhook",
            "url": "${MORTISE_WH_SLACK_URL}",
            "method": "POST",
            "body": { "text": ":warning: Permission escalated from safe to allow-all in *${MORTISE_SESSION_NAME}*" }
          }
        ]
      }
    ]
  }
}
```

### Permission Mode Change Notification

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "matcher": "allow-all",
        "actions": [
          { "type": "prompt", "prompt": "The permission mode was changed to allow-all. Log the change and note any security implications." }
        ]
      }
    ]
  }
}
```

### Mixed Actions (Prompt + Webhook)

A single automation can have both prompt and webhook actions. They execute in order.

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "name": "Permission Escalation: Notify and Review",
        "matcher": "^allow-all$",
        "actions": [
          {
            "type": "webhook",
            "url": "${MORTISE_WH_SLACK_URL}",
            "method": "POST",
            "body": { "text": ":warning: Permission mode escalated for *${MORTISE_SESSION_NAME}*" }
          },
          {
            "type": "prompt",
            "prompt": "Review the permission escalation and summarize any security implications."
          }
        ]
      }
    ]
  }
}
```

### Form-Encoded Request (OAuth / Stripe)

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Refresh API Token",
        "cron": "0 */6 * * *",
        "actions": [
          {
            "type": "webhook",
            "url": "https://auth.example.com/oauth/token",
            "method": "POST",
            "bodyFormat": "form",
            "body": {
              "grant_type": "client_credentials",
              "client_id": "${MORTISE_WH_CLIENT_ID}",
              "client_secret": "${MORTISE_WH_CLIENT_SECRET}"
            }
          }
        ]
      }
    ]
  }
}
```

### Webhook with Custom Headers

```json
{
  "version": 2,
  "automations": {
    "PostToolUse": [
      {
        "name": "Log to External API",
        "actions": [
          {
            "type": "webhook",
            "url": "https://api.example.com/mortise-events",
            "method": "POST",
            "headers": {
              "Authorization": "Bearer ${MORTISE_WH_API_TOKEN}",
              "X-Source": "mortise"
            },
            "body": {
              "event": "${MORTISE_EVENT}",
              "session_id": "${MORTISE_SESSION_ID}",
              "payload": "${MORTISE_EVENT_DATA}"
            }
          }
        ]
      }
    ]
  }
}
```

## Validation

Automations are validated when:
1. The workspace is loaded
2. You edit automations.json (via PreToolUse hook)
3. You run `config_validate` with target `automations` or `all`

**Using config_validate:**

Ask Mortise Agent to validate your automations configuration:

```
Validate my automations configuration
```

Or use the `config_validate` tool directly with `target: "automations"`.

**Common validation errors:**
- Invalid JSON syntax
- Unknown event names
- Empty actions array
- Invalid cron expression
- Invalid timezone
- Invalid regex pattern
- Potentially unsafe regex patterns (nested quantifiers)

**To validate manually:**

```bash
# Check automations.json syntax
cat automations.json | jq .
```

## Retry Behavior

Webhook actions have two levels of automatic retry:

### Immediate retry (transient failures)

When a webhook fails with a server error (5xx), timeout, or connection error, it is automatically retried up to **2 times** with exponential backoff (1s → 2s → 4s). Client errors (4xx) are not retried — they indicate a configuration problem.

### Deferred retry (extended outages)

If all immediate retries fail, the webhook is added to a **persistent retry queue**. The queue retries at increasing intervals:

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1st deferred | 5 minutes | 5 min |
| 2nd deferred | 30 minutes | 35 min |
| 3rd deferred | 1 hour | ~1.5 hours |

After the final deferred attempt fails, the webhook is marked as permanently failed in the history. Deferred retries survive app restarts.

> **Note:** Only transient failures (5xx, timeouts, connection errors) are retried. Client errors (4xx) indicate a configuration problem and should be fixed in `automations.json`.

> **Retry and rate limiting:** Retried webhook requests count toward the per-endpoint rate limit (30/min per origin). If a retry would exceed the limit, it is deferred to the next retry window.

## Rate Limits

To protect against runaway automations (e.g., an automation that indirectly triggers itself in a loop), the event bus enforces per-event-type rate limits:

| Event | Max fires / minute |
|-------|--------------------|
| `SchedulerTick` | 60 (1/sec) |
| All others (`PermissionModeChange`, `PreToolUse`, etc.) | 10 |

When a limit is hit, further events of that type are **silently dropped** for the remainder of the 60-second window. A warning is logged. The window resets automatically.

**Example:** If an event automation indirectly triggers itself, it will fire at most 10 times before being rate-limited.

## Troubleshooting

### Automation not firing

1. **Check event name** - Must be exact (e.g., `PreToolUse` not `pretooluse`)
2. **Check matcher** - Regex must match the event value
3. **Check cron** - For SchedulerTick, verify cron expression with an online tool
4. **Check logs** - Look for `[automations]` or `[Scheduler]` in the logs

### Prompt not creating session

1. Check that the prompt is not empty
2. Verify @mentions reference valid sources/skills

### Webhook not working

1. **Check URL** — Must be a valid `http://` or `https://` URL. Other protocols (ftp, ws, etc.) are rejected at runtime with a clear error.
2. **Check env vars** — Ensure `MORTISE_WH_*` variables are set in your shell profile and Mortise Agent was restarted after adding them. URLs using `$VAR` templates are validated after variable expansion — if the variable is empty or unset, the URL will be invalid.
3. **Use the Test button** — Tests connectivity to the URL (note: env vars are not expanded during test)
4. **Check method** — Some endpoints require specific HTTP methods (POST, PUT, etc.)
5. **Check response** — The automation history shows HTTP status codes for webhook executions

### Retrying failed webhooks

When a webhook execution fails (shown with a red indicator in the timeline), you can retry it:

1. Open the automation's detail page
2. In the "Recent Activity" timeline, failed webhook entries show a **Retry** button
3. Click "Retry" to re-execute the webhook actions immediately
4. The retry result is recorded as a new history entry

> **Note:** Retries execute the webhook actions as currently configured. If you've changed the URL or headers since the original failure, the retry uses the updated configuration. Environment variables are not expanded during replay (same as the Test button).

## Best Practices

1. **Start simple** - Test with a basic prompt before building complex workflows
2. **Use labels** - Tag scheduled sessions for easy filtering
3. **Be specific** - Use matchers to avoid triggering on every event
4. **Test cron** - Use [crontab.guru](https://crontab.guru/) to verify expressions
5. **Keep secrets out of config** - Use `MORTISE_WH_*` env vars for webhook URLs and tokens instead of hardcoding them in automations.json
6. **Combine actions** - Use both webhook and prompt actions in a single automation for notification + AI response workflows
