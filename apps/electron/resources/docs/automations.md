# Mortise Automations

Mortise Automations is the host-owned system for time and event triggers. Definitions, scheduling, occurrence claims, run history, retries, idempotency, and restart recovery all use one versioned V3 store.

Do not create `automations.json`, prompt-automation files, a second scheduler, or a separate run-history store. Extensions, the CLI, and Agent tools are typed clients of the same `automation.workspace/v1` capability.

## Quick Start

Open **Automations** in Mortise, create an automation, choose a trigger and action, then save it. The GUI writes through the same versioned command API used below.

To inspect the current workspace from the CLI:

```powershell
mortise-cli --workspace <workspace-id> automation list
mortise-cli --workspace <workspace-id> automation describe
```

To create a definition, save this current V3 document fragment as `automation.json`:

```json
{
  "id": "automation_daily_summary_01",
  "name": "Daily summary",
  "enabled": true,
  "triggers": [
    {
      "id": "trigger_daily_summary_01",
      "type": "time",
      "schedule": {
        "kind": "cron",
        "expression": "0 9 * * 1-5",
        "timezone": "Asia/Shanghai",
        "misfire": "run-once"
      }
    }
  ],
  "actions": [
    {
      "id": "action_daily_summary_01",
      "type": "prompt",
      "prompt": "Summarize the current workspace activity.",
      "target": { "kind": "new-session" }
    }
  ],
  "runPolicy": {
    "overlap": "queue-one",
    "actionFailure": "stop"
  },
  "createdAt": "2026-07-21T00:00:00.000Z",
  "updatedAt": "2026-07-21T00:00:00.000Z"
}
```

Validate and create it:

```powershell
mortise-cli --workspace <workspace-id> automation validate @automation.json
mortise-cli --workspace <workspace-id> automation create @automation.json --expected-revision <revision>
```

Use the revision returned by `automation list`. A stale revision returns a conflict; reload and apply the change again instead of overwriting concurrent work.

## Commands

```text
automation describe
automation list
automation get <id>
automation validate <json|@file>
automation create <json|@file> --expected-revision <n|null>
automation update <json|@file> --expected-revision <n>
automation delete <id> --expected-revision <n>
automation set-enabled <id> <true|false> --expected-revision <n>
automation run <id> [--trigger-id <id>]
automation get-run <run-id>
automation list-runs
automation emit-event <json|@file>
automation token path
automation token rotate
```

Mutating commands require a stable operation identity internally and compare-and-swap revision checks. Replaying the same operation is idempotent; reusing an operation identity with different content is rejected.

## Triggers

### Cron

Use a five- or six-field cron expression and an optional IANA timezone:

```json
{
  "id": "trigger_weekday_report_01",
  "type": "time",
  "schedule": {
    "kind": "cron",
    "expression": "0 18 * * 1-5",
    "timezone": "Europe/Berlin",
    "misfire": "skip"
  }
}
```

### Once

```json
{
  "id": "trigger_release_reminder_01",
  "type": "time",
  "schedule": {
    "kind": "once",
    "at": "2026-08-01T09:00:00.000Z",
    "expiresAt": "2026-08-01T12:00:00.000Z",
    "misfire": "run-once"
  }
}
```

### Interval

```json
{
  "id": "trigger_health_check_01",
  "type": "time",
  "schedule": {
    "kind": "interval",
    "everyMs": 900000,
    "anchorAt": "2026-07-21T00:00:00.000Z",
    "misfire": "skip"
  }
}
```

### Event

```json
{
  "id": "trigger_agent_failure_01",
  "type": "event",
  "source": "agent",
  "eventType": "PostToolUseFailure",
  "matcher": "build|test"
}
```

Event sources are `mortise`, `agent`, `extension`, or `external`. The host assigns the trusted source kind; callers cannot self-promote an external event to a trusted Agent or Mortise event.

External producers send CloudEvents 1.0 through the workspace ingress. Rotate the workspace token with `automation token rotate` and keep it out of prompts, logs, and definition bodies.

## Prompt Actions

Prompt delivery is explicit:

- `new-session` creates a normal assistant-backed Session.
- `session` targets `event-session` or a fixed Session and chooses `followUp` or `steer`.

Example fixed Session delivery:

```json
{
  "id": "action_follow_up_01",
  "type": "prompt",
  "prompt": "Review the event payload and report the regression.",
  "eventData": "append-json",
  "target": {
    "kind": "session",
    "session": { "id": "session_01HXEXAMPLE" },
    "delivery": "followUp"
  }
}
```

Definitions containing a time trigger cannot use `event-session`, because no triggering Session is guaranteed to exist.

## Webhook Actions

```json
{
  "id": "action_webhook_01",
  "type": "webhook",
  "url": "https://example.com/hooks/mortise",
  "method": "POST",
  "bodyFormat": "json",
  "body": { "kind": "daily-summary" },
  "captureResponse": true,
  "auth": {
    "type": "bearer",
    "token": {
      "provider": "mortise-secrets",
      "id": "secret_webhook_token_01"
    }
  }
}
```

Secrets are references to Mortise secret storage, never literal passwords or tokens in a definition. Resource bundle export removes sensitive literal headers while retaining safe secret references.

## Conditions

Definitions may use `time`, `state`, and nested `and` / `or` / `not` conditions. Condition nesting is bounded. Invalid time values, unsafe regular expressions, unknown fields, and excessive nesting are rejected by the V3 schema.

## Concurrency And Recovery

- `overlap: "skip"` records and skips an occurrence while a run is active.
- `overlap: "queue-one"` retains only the newest queued occurrence.
- Restart recovery coalesces stale `queue-one` claims before execution.
- `actionFailure: "stop"` stops at the first failed action.
- `actionFailure: "continue"` runs remaining actions and records a partial result.

Run claims and history are durable before background execution begins. Supported Mortise versions negotiate store capabilities; an incompatible writer becomes read-only instead of rewriting the store.

## Extensions

Extensions may declare event producers or invoke `automation.workspace/v1`. They do not own schedulers, definition stores, retry queues, histories, or fallback runtimes. Extension events enter through the host capability router and receive the same validation, identity, and workspace checks as built-in producers.

## Troubleshooting

```powershell
mortise-cli --workspace <workspace-id> automation list
mortise-cli --workspace <workspace-id> automation get <automation-id>
mortise-cli --workspace <workspace-id> automation list-runs
mortise-cli --workspace <workspace-id> automation get-run <run-id>
```

For a revision conflict, reload the definition and revision before retrying. For an unsupported or read-only result, inspect the returned capability version and upgrade the incompatible runtime rather than copying or editing the SQLite store.
