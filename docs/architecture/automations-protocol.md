# Mortise Automations Architecture And Protocol

Status: Accepted architecture contract

Canonical document version: `3`

Runtime event envelope: CloudEvents `1.0` structured content mode

Last updated: 2026-07-20

This document is the normative architecture and protocol specification for
Mortise Automations. The terms MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT,
and MAY are to be interpreted as described by RFC 2119.

## 1. Decision And Scope

Mortise owns one automation system. It owns the canonical definitions,
scheduler, event ingress, run coordination, execution history, management RPC,
and management UI. The former Mortise-target `prompt-automation` extension is
not a second automation product, scheduler, store, or execution authority.

The unified system supports:

- time triggers: cron, once, and interval;
- event triggers from Mortise, the Agent runtime, and authenticated external
  programs;
- prompt actions targeting a new Session, an existing Session by follow-up or
  steer delivery, or an isolated Agent;
- outbound webhook actions;
- one durable run history correlated from trigger occurrence through every
  action attempt.

External program input is event ingress. It is not a separate trigger family.
Outbound webhook delivery is an action. It is not event ingress.

This version is intentionally an automation protocol rather than a general
workflow language. It does not add branches, arbitrary graph edges, loops,
user-defined executors, or a portable workflow DSL.

## 2. Reuse Decision

Research evidence is recorded in
`docs/architecture/automations-protocol-candidates.json` and was scored with the
repository's reuse-first candidate process.

| Candidate | Score | Decision | Role |
|---|---:|---|---|
| [AsyncAPI](https://github.com/asyncapi/spec) | 88.0 | Use for generated descriptions only | Describe channels and messages derived from the normative Mortise contract |
| [CloudEvents](https://github.com/cloudevents/spec) | 84.0 | Adopt at runtime | Standard event identity and structured ingress envelope |
| [Open Workflow Specification](https://github.com/open-workflow-specification/specification) | 69.5 | Do not adopt | Its workflow DSL is broader than the bounded Mortise automation model |

AsyncAPI documents MUST be generated from Mortise protocol schemas. They MUST
NOT become a second source of truth, runtime engine, or persisted automation
format. CloudEvents standardizes event transport but does not define Mortise
scheduling, matching, actions, state, or persistence. Those remain Mortise
contracts.
The shared `createAutomationAsyncApiDocumentV1()` generator emits the current
description directly from `CloudEventV1Schema`.

## 3. Ownership And Data Flow

The canonical flow is:

```text
time scheduler | Mortise adapter | Agent adapter | external ingress
                              |
                      durable event/occurrence
                              |
                    trigger and condition match
                              |
                         durable run claim
                              |
                      ordered action executor
                              |
            Session delivery | isolated Agent | webhook
                              |
                    canonical run history
```

The host MUST persist an accepted event or time occurrence before dispatching
actions. All adapters feed the same matcher and runner. No adapter may inject a
prompt directly into a Session while bypassing definition matching, run claims,
and history.

Automations owns orchestration state. Session creation and prompt/steer/follow-
up behavior remain owned by `session-lifecycle` and the current repository Pi
runtime. Webhook transport uses host networking policy. Shared-data concurrency
uses `workspace-state` storage primitives.

## 4. Versioning And Capabilities

Three version domains are independent:

1. `AutomationsDocument.schemaVersion` versions the persisted definition
   document. This specification defines version `3`.
2. CloudEvents `specversion` versions the event envelope. Ingress uses `1.0`.
3. Mortise capability versions negotiate definitions, event ingress, run state,
   and history writes between concurrent backends.

The host MUST advertise at least these automation capabilities:

```json
{
  "automations.definitions": { "minRead": 3, "maxRead": 3, "minWrite": 3, "maxWrite": 3 },
  "automations.ingress": { "minRead": 1, "maxRead": 1, "minWrite": 1, "maxWrite": 1 },
  "automations.runs": { "minRead": 1, "maxRead": 1, "minWrite": 1, "maxWrite": 1 },
  "automations.history": { "minRead": 1, "maxRead": 1, "minWrite": 1, "maxWrite": 1 }
}
```

A backend MUST NOT write a capability outside the shared data store's
negotiated write range. An incompatible backend remains readable where its read
range permits and MUST fence incompatible mutations, scheduler claims, and
action dispatch as read-only. A global backend lock is prohibited.

Unknown major document, trigger, action, target, or transition versions fail
closed. Writers MUST preserve data they understand and MUST NOT silently drop
unknown definitions while rewriting the document.

### 4.1 Host Capability Contract

Extensions, the CLI, Agent tools, Electron, and WebUI use the same host-owned
`automation.workspace` capability with domain `schemaVersion: 1`. Supported
operations are:

```ts
type AutomationOperationV1 =
  | 'describe'
  | 'list'
  | 'get'
  | 'validate'
  | 'simulate'
  | 'create'
  | 'update'
  | 'delete'
  | 'set-enabled'
  | 'run'
  | 'get-run'
  | 'list-runs'
  | 'emit-event'
```

`describe` returns negotiated schema ranges, supported trigger/action/target
kinds, limits, and permission scopes. `validate` normalizes without side
effects. `simulate` returns matching triggers, conditions, and the planned
actions without creating a run. `run` accepts durably and returns a `runId`;
callers query completion instead of holding the capability request open.

Every side-effecting request requires `operationId`. Definition mutations also
require `expectedRevision`; `update` carries one complete definition and does
not accept arbitrary JSON Patch. Results use a common envelope:

```ts
interface AutomationCapabilityResultV1<T> {
  schemaVersion: 1
  operationId?: string
  status:
    | 'ok'
    | 'accepted'
    | 'duplicate'
    | 'conflict'
    | 'invalid'
    | 'denied'
    | 'unsupported'
  revision?: number
  data?: T
  error?: { code: string; message: string; retryable: boolean }
}
```

`duplicate` returns the original durable result. `conflict` returns the current
revision or existing operation identity without applying a partial mutation.
The protocol MUST distinguish transport acknowledgement from business
acceptance; a command handler returning normally is never sufficient evidence
that an automation event or action was handled.

Permission scopes are:

```text
automations.read
automations.history.read
automations.write
automations.run
automations.events.emit
```

Declarations do not grant permissions. Host policy remains fail closed, binds
grants to extension/runtime identity, redacts prompt and header content from
read responses when the caller lacks its scope, and audits every mutating
operation.

## 5. Canonical Document V3

The host document contains one ordered `definitions` array. Grouping
definitions by event name is a version 2 storage detail and is not retained.

```ts
interface AutomationsDocumentV3 {
  schemaVersion: 3
  revision: number
  definitions: AutomationDefinitionV3[]
}

interface AutomationDefinitionV3 {
  id: string
  name: string
  description?: string
  enabled: boolean
  triggers: AutomationTriggerV3[]
  conditions?: AutomationConditionV3[]
  actions: AutomationActionV3[]
  runPolicy?: {
    overlap?: 'skip' | 'queue-one'
    actionFailure?: 'continue' | 'stop'
  }
  createdAt: string
  updatedAt: string
}
```

`revision` is a positive monotonically increasing compare-and-swap revision for
the complete workspace definition document. It is distinct from
`schemaVersion`.

Automation, trigger, and action IDs are immutable opaque collision-safe
identities. They MUST NOT be array indexes, names, event names, or six-character
display IDs. Names are mutable semantic labels and MUST NOT be used for
ownership or deduplication.

Each definition MUST contain at least one trigger and one action. Triggers use
OR semantics: any one matching trigger can create a run. Conditions use AND
semantics after one trigger matches. Actions are ordered and execute in array
order.

Defaults are:

```json
{
  "runPolicy": {
    "overlap": "skip",
    "actionFailure": "continue"
  }
}
```

With `actionFailure: "continue"`, later actions still execute after a failed or
blocked action. A run with both successful and unsuccessful actions terminates
as `partial`.

### 5.1 Event Triggers

```ts
interface EventTriggerV3 {
  id: string
  type: 'event'
  source: 'mortise' | 'agent' | 'extension' | 'external'
  eventType: string
  matcher?: string
}
```

`eventType` matches the CloudEvents `type` attribute or the equivalent
normalized internal event type. `source` is assigned by the trusted adapter;
external input cannot impersonate `mortise` or `agent`.

`matcher`, when present, is a bounded regular expression evaluated against the
adapter-defined `matchValue`. Existing Mortise/Agent adapters MUST preserve
their documented match values during version 2 migration. External event
triggers SHOULD match structured payload fields through conditions rather than
stringifying arbitrary payloads into `matchValue`.

Conditions retain the current time, state, and logical `and`/`or`/`not`
families. They evaluate against a normalized context containing CloudEvents
attributes, `data`, trusted workspace/session identity, and adapter-provided
transition fields. Unknown condition kinds fail closed. The maximum supported
condition nesting depth remains eight.

### 5.2 Time Triggers

```ts
type TimeTriggerV3 =
  | {
      id: string
      type: 'time'
      schedule: {
        kind: 'cron'
        expression: string
        timezone?: string
        misfire?: 'skip' | 'run-once'
      }
    }
  | {
      id: string
      type: 'time'
      schedule: {
        kind: 'once'
        at: string
        expiresAt?: string
        misfire?: 'skip' | 'run-once'
      }
    }
  | {
      id: string
      type: 'time'
      schedule: {
        kind: 'interval'
        everyMs: number
        anchorAt: string
        misfire?: 'skip' | 'run-once'
      }
    }
```

Cron accepts either five fields (`minute hour day-of-month month day-of-week`)
or six fields (`second minute hour day-of-month month day-of-week`). A timezone,
when present, MUST be an IANA timezone. The scheduler computes exact future
occurrences; it MUST NOT model time by publishing a public `SchedulerTick`
event every minute.

Default misfire behavior is:

- cron: `skip`; missed occurrences are not replayed;
- once: `run-once`; the host runs one missed occurrence after recovery unless
  `expiresAt` has passed, then records it as expired and completes the trigger;
- interval: coalesce at most one missed occurrence and preserve `anchorAt`.

For interval schedules, the next future occurrence is always calculated from
`anchorAt + n * everyMs`. Restart time and prior execution duration MUST NOT
become a new implicit anchor. Multiple missed intervals produce no more than
one recovery run. The scheduler then advances to the first future anchored
boundary.

Once triggers become completed after their one occurrence is durably claimed,
whether the run succeeds or fails. Re-enabling a completed once trigger
requires an explicit new `at` value and definition revision.

### 5.3 Prompt Actions

```ts
interface PromptActionV3 {
  id: string
  type: 'prompt'
  prompt: string
  target:
    | {
        kind: 'new-session'
        provider?: string
        model?: string
        thinkingLevel?: string
        permissionMode?: 'safe' | 'ask' | 'allow-all'
        telegramTopic?: string
      }
    | {
        kind: 'session'
        session: 'event-session' | { id: string }
        delivery: 'followUp' | 'steer'
      }
    | {
        kind: 'isolated-agent'
        provider?: string
        model?: string
        thinkingLevel?: string
        permissionMode?: 'safe' | 'ask' | 'allow-all'
        notify?: {
          session: 'event-session' | { id: string }
          delivery: 'followUp' | 'steer'
        }
      }
}
```

`new-session` uses the server-owned first-turn transaction. The action succeeds
only when the Session crosses the repository's assistant-backed durable
publication boundary. A failure before that boundary leaves no stored Session
and fails the action.

`session` targets an existing Session. `event-session` resolves only from a
trusted event context. Validation MUST reject `event-session` when any trigger
in the definition is a time trigger, because a time occurrence has no trusted
event Session. A fixed Session ID that no longer exists blocks the action and
produces a diagnostic; the host MUST NOT substitute the active UI Session or
create a new Session.

`followUp` and `steer` inherit Pi's current Agent Loop behavior. A steer that
cannot be delivered before the turn ends follows Pi's normal undelivered-steer
requeue behavior. Automations MUST NOT redefine turn ordering, interrupt,
retry, or queue semantics.

An `isolated-agent` target runs in an isolated in-memory Agent context and does
not create a normal sidebar Session. Its action remains running until the
isolated Agent terminates. `notify`, when present, delivers the bounded result
to its explicit Session target. Failure to notify is recorded separately from
the isolated Agent result and can make the action partial.

Environment and event-data expansion occurs exactly once before dispatch. The
rendered prompt and a redacted reference to its input event are recorded for
diagnostics; secrets MUST NOT be copied into history.

### 5.4 Outbound Webhook Actions

```ts
interface WebhookActionV3 {
  id: string
  type: 'webhook'
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  bodyFormat?: 'json' | 'form' | 'raw'
  body?: unknown
  captureResponse?: boolean
  auth?:
    | { type: 'basic'; username: string; password: SecretReferenceV1 }
    | { type: 'bearer'; token: SecretReferenceV1 }
}

interface SecretReferenceV1 {
  provider: 'mortise-secrets'
  id: string
}

type AutomationActionV3 = PromptActionV3 | WebhookActionV3
```

Webhook means Mortise sends an HTTP request to an external service. It never
means external input to Mortise. A 2xx response succeeds; other terminal
responses fail. Existing bounded immediate and deferred retry policy remains a
host policy until a later schema version explicitly makes it configurable.

Each attempt has a stable attempt identity. The host SHOULD send that identity
in an `Idempotency-Key` header unless the definition explicitly supplies one.
Mortise guarantees idempotent internal attempt transitions, but cannot promise
exactly-once side effects when the remote service ignores idempotency.
Webhook credentials are resolved by the host at dispatch time. Protocol
clients and extensions receive only secret references and never raw values.

## 6. CloudEvents Event Envelope

All runtime events normalize to CloudEvents 1.0. External ingress uses
structured content mode with content type `application/cloudevents+json`.

```json
{
  "specversion": "1.0",
  "id": "evt_01K0EXAMPLE",
  "source": "urn:mortise:external:local-script:ci",
  "type": "tests.failed",
  "subject": "workspace/ws_01K0EXAMPLE",
  "time": "2026-07-20T10:15:30.000Z",
  "datacontenttype": "application/json",
  "dataschema": "urn:mortise:automations:event-data:v1",
  "mortiseworkspaceid": "ws_01K0EXAMPLE",
  "mortisesessionid": "session_01K0EXAMPLE",
  "data": {
    "logPath": "E:\\logs\\tests.txt",
    "exitCode": 1
  }
}
```

CloudEvents required attributes `specversion`, `id`, `source`, and `type` are
also required by Mortise. Mortise additionally requires `time`, JSON data, and
a workspace-scoped authenticated ingress route. `mortisesessionid` is optional.

The authenticated route owns workspace identity. It MUST reject or overwrite a
conflicting `mortiseworkspaceid`; callers cannot route events into another
workspace by changing the envelope. A supplied Session ID MUST belong to the
route workspace. The ingress adapter assigns trusted source kind `external`
regardless of caller data.

The pair `(source, id)` is the idempotent event identity. The host stores a
canonical `eventId` derived from that pair so two producers may independently
use the same CloudEvents `id` without colliding:

- first valid delivery for a source/id pair: durably append, then return HTTP
  `202`;
- same source/id and canonical payload: return `202` with `duplicate: true`,
  without a second run;
- same source/id with different canonical payload: return HTTP `409` with
  `identity_conflict`;
- validation, authentication, or capacity rejection: do not return `202`.

Example response:

```json
{
  "accepted": true,
  "eventId": "evt_01K0EXAMPLE",
  "duplicate": false,
  "persisted": true
}
```

`202` means accepted durably for matching and execution. It does not mean that
an automation matched or that any action completed.

Internal Mortise, Agent, and extension adapters create the same logical
envelope but use trusted source kinds `mortise`, `agent`, and `extension`.
Transport-specific fields MUST NOT
enter matcher semantics unless normalized into the event data contract.

## 7. Identities, Claims, And State Machines

Every time occurrence has a deterministic occurrence key:

- cron: canonical scheduled UTC instant;
- once: canonical `at` UTC instant;
- interval: `anchorAt` plus interval index;
- event: canonical `(source, CloudEvents id)` pair;
- manual test or replay: the mutation `operationId` in an explicit manual
  namespace.

The host derives:

```text
occurrenceId = hash(workspaceId, automationId, triggerId, occurrenceKey)
runId        = hash(occurrenceId, runOrdinal)
actionRunId  = hash(runId, actionId)
attemptId    = hash(actionRunId, attemptNumber)
```

Normal trigger delivery uses `runOrdinal = 0`. An explicit replay creates a new
manual occurrence instead of mutating or duplicating the original run.

Before executing, a backend atomically claims the occurrence in the canonical
store. Repeated claims return the existing result. Concurrent source and
installed backends therefore cannot create two normal runs for one occurrence.

Run states are:

```text
queued -> running -> succeeded | partial | failed | cancelled
queued -> skipped
```

Action states are:

```text
queued -> running -> succeeded | failed | blocked | cancelled
queued -> skipped
```

Transitions are append-only, operation-identified, and monotonic. Reapplying
the same transition is idempotent. Reusing an operation identity with different
content is an identity conflict. A terminal state cannot transition back to a
non-terminal state.

Prompt action terminal meaning is target-specific:

- new Session: the first-turn transaction crossed durable publication;
- existing Session: follow-up was durably queued or steer was accepted by Pi;
- isolated Agent: the Agent completed or failed;
- webhook: the outbound request reached its terminal retry result.

Run aggregation is deterministic:

- `succeeded` means every declared action succeeded;
- `partial` means at least one action succeeded and at least one action failed,
  was blocked, was cancelled, or was skipped;
- `failed` means no action succeeded and at least one action failed or was
  blocked;
- `cancelled` means explicit run cancellation prevented normal aggregation;
- `skipped` means the run never began action execution.

With action failure policy `stop`, the first failed or blocked action marks all
later actions `skipped` with reason `prior-action-failure`; the rules above then
derive the run terminal state.

With overlap policy `skip`, a new occurrence observed while an earlier run for
the same automation is non-terminal becomes a `skipped` run with reason
`overlap`. `queue-one` keeps at most one newest pending occurrence and never
bypasses occurrence deduplication. V3 does not expose unbounded concurrent
runs.

## 8. Canonical Storage And Mutations

Definitions, ingress events, run transitions, action transitions, and history
are one host-owned logical store even if retention uses multiple physical
tables or streams. `automations.json`, `.pi/schedule-prompts.json`, legacy
trigger config, and extension runtime registries MUST NOT remain co-authoritative.

Definition mutations use compare-and-swap and operation identity:

```ts
interface AutomationDocumentMutationV1 {
  operationId: string
  expectedRevision: number | null
  document: AutomationsDocumentV3
}
```

Rules:

- a successful mutation increments revision exactly once;
- retrying the same operation and canonical payload returns the original result
  with `replayed: true`;
- reusing an operation ID with different content fails identity conflict;
- a stale expected revision returns the current revision and document without
  applying a partial write;
- all RPC and CLI writes address immutable IDs, never event-array indexes;
- atomic file replacement alone is insufficient without revision and operation
  semantics.

History is a materialized view over durable ingress, run, action, and attempt
records. Retention may compact old detail, but it MUST preserve terminal run
summary, automation ID, trigger ID, occurrence ID, timestamps, action outcomes,
and linked Session IDs for the configured retention period.

## 9. Scheduling And Recovery Invariants

The scheduler MUST satisfy all of these invariants:

1. A recognized occurrence has one durable occurrence ID across processes and
   restarts.
2. A clock rollback cannot reclaim an already committed occurrence.
3. Daylight-saving transitions follow the chosen IANA timezone and scheduler
   library semantics, while deduplication remains based on scheduled UTC
   instant.
4. Cron skips missed occurrences by default.
5. Once recovers one missed, unexpired occurrence and then completes.
6. Interval coalesces any number of missed boundaries into at most one recovery
   run without changing its anchor.
7. Disabling a definition prevents new claims but does not erase history.
8. Updating a schedule produces future occurrence keys from the new revision;
   it does not reinterpret already claimed occurrences.
9. Shutdown stops new claims, aborts or hands off owned work using durable
   leases, and never reports an in-flight action as successful without its
   terminal transition.

Leases, if used for crash recovery, identify the claiming backend and expire.
Lease takeover may resume an internally idempotent transition. It MUST NOT
blindly repeat an outbound side effect whose terminal result is unknown; such a
case becomes `blocked` or follows the action's documented idempotency policy.

## 10. Security And Resource Limits

External ingress is a local development and automation surface, not an
unauthenticated public webhook receiver.

- It MUST bind to loopback by default.
- Every endpoint MUST require an opaque, workspace-scoped, rotatable capability
  token with constant-time verification.
- Runtime discovery files MUST expose only the minimum endpoint metadata and
  MUST protect tokens with user-only filesystem permissions.
- Request bodies are limited to 1 MiB before parsing.
- Implementations MUST bound JSON nesting, string lengths, event type length,
  regex length/complexity, per-source rate, and total queued events.
- Events cannot execute commands, choose an action, alter a definition, select
  another workspace, or impersonate an internal source.
- Rejections and rate limits produce structured diagnostics. They MUST NOT be
  silently dropped.
- Event payloads, rendered prompts, headers, authentication, and webhook
  responses are redacted before logging or history persistence.
- Webhook URLs permit only supported HTTP schemes and remain subject to host
  outbound-network and secret-expansion policy.

A future remotely reachable event receiver requires a separate threat model,
authentication design, replay window, and product decision. It is not implied
by this version.

## 11. Migration

Migration is per workspace, atomic, idempotent, and auditable. The migration
operation ID is deterministic from workspace identity, source format, and
source content hash. The host builds and validates a complete version 3
candidate before committing it. Failure leaves the old source untouched and
does not start the version 3 scheduler.

### 11.1 Automations Document V2

- Each event-map matcher becomes one version 3 definition.
- The matcher ID is retained as the automation ID when collision-safe and
  unique; missing, short, or colliding IDs receive opaque IDs with a migration
  alias recorded for history lookup.
- The event-map key becomes an event trigger `eventType` and trusted source.
- `SchedulerTick` plus `cron` becomes a time/cron trigger. `SchedulerTick` is
  not retained as a public event.
- Matcher, conditions, permission mode, provider, model, thinking level,
  Telegram topic, and actions are preserved in their version 3 locations.
- Literal webhook credentials are moved atomically into the host secret store
  and replaced by `SecretReferenceV1`; a credential that cannot be secured
  blocks that definition instead of remaining inline.
- Existing history is correlated through retained IDs or migration aliases.

### 11.2 Legacy Scheduled Prompts

`.pi/schedule-prompts.json` jobs map as follows:

- cron, once, and interval become matching time triggers;
- a job with a model becomes an isolated-Agent prompt action;
- a job bound to an existing Session becomes a fixed Session follow-up action;
- an unbound scheduled job becomes a new-Session prompt action;
- a job bound to a missing Session is imported disabled with a migration
  diagnostic and is never silently redirected;
- legacy run count, last result, and next-run display data are imported only as
  historical metadata, not scheduler truth.

### 11.3 Legacy External Triggers

Project `.pi/prompt-automation.json` triggers are imported into that workspace
as `source: "external"` event definitions. Their follow-up/steer delivery is
preserved when a valid event Session is available.

Global prompt-automation triggers are copied idempotently into every workspace
registered at migration time. During a bounded migration window, the first
open of a previously unvisited registered workspace performs the same
idempotent import. After that window, legacy global ownership ends; subsequent
global-file changes are ignored and never dual-written.

The migration report lists source path, imported definition IDs, disabled
definitions, conflicts, and diagnostics. Legacy files are archived only after
the canonical commit and report are durable.

### 11.4 Runtime Cutover

After a workspace commits version 3:

- the host stops the old scheduler before enabling version 3 claims;
- the Mortise `delegatePromptAutomation` setting and fallback path have no
  authority and are removed;
- the Mortise-target `prompt-automation` runtime is removed;
- Mortise exposes only the unified UI, RPC, CLI, and ingress;
- standalone Pi may retain a compatibility client that submits to Mortise event
  ingress, but it cannot retain a second Mortise scheduler or store.

There is no supported dual-scheduler or dual-write steady state.

## 12. Validation And Acceptance

Contract acceptance requires automated coverage for:

- document v3 schema, stable ID uniqueness, OR triggers, AND conditions,
  ordered actions, defaults, and unknown-version failure;
- operation replay, operation identity conflict, stale revision conflict, and
  concurrent mutation;
- CloudEvents structured validation, workspace/session trust replacement,
  authentication, same-ID replay, different-payload conflict, persistence
  before `202`, request limits, and rate diagnostics;
- five- and six-field cron, IANA timezones, DST gaps/overlaps, clock rollback,
  once recovery/expiry, interval anchoring/coalescing, disable/update, and
  process restart;
- two concurrent compatible backends observing one occurrence and producing
  exactly one claimed normal run;
- overlap `skip` and `queue-one` behavior;
- action ordering, continue/stop failure policy, and overall partial status;
- new Session publication boundary, fixed and event Session validation,
  follow-up, steer, undelivered-steer requeue, Session deletion, isolated-Agent
  completion/abort/notify, and model/provider fallback diagnostics;
- webhook success, terminal failure, immediate/deferred retry, stable attempt
  identities, response truncation, secret redaction, and unknown-outcome crash
  recovery;
- v2, scheduled-prompt, project-trigger, global-trigger, repeated migration,
  missing Session, ID collision, corrupt source, and interrupted migration
  fixtures;
- history correlation and retention from event/occurrence through run, action,
  attempt, and linked Session.

Module regression remains:

```text
bun test packages/shared/src/automations packages/shared/src/scheduler apps/electron/src/renderer/components/automations
```

Cross-module contract changes additionally require shared protocol typecheck,
workspace multi-writer tests, Session lifecycle regressions, and Pi Agent Loop
contract tests. UI acceptance must exercise the real Automations workflow and
semantic history through the supported Electron/WebUI surfaces in proportion
to their platform capabilities.

## 13. Phased Rollout And Rollback

### Phase 0: Contract

Land versioned schemas, capability declarations, deterministic identity helpers,
and migration fixtures without enabling version 3 execution.

### Phase 1: Canonical Store

Add revisioned definition storage and append-only run records. Read and validate
legacy sources in shadow mode. Do not write legacy sources or run a second
scheduler.

### Phase 2: Per-Workspace Migration

Atomically migrate one workspace, stop its legacy scheduler, and enable version
3 claims behind a product feature gate. Compare scheduled occurrence and
matcher diagnostics before widening rollout.

### Phase 3: Unified Ingress And Actions

Enable authenticated CloudEvents ingress, all prompt targets, and canonical
webhook execution/history. Convert `pi-trigger` to a thin compatibility client.

### Phase 4: Remove Separate Runtime

Remove the Mortise-target `prompt-automation` extension, delegation setting,
legacy runtime registry, duplicate UI, and old scheduler/store ownership.

### Phase 5: Close Migration Window

Stop global legacy import-on-first-open, retain read-only migration reports and
archives for the documented retention period, and make version 3 the only
writable Mortise format.

Before a workspace cutover, rollback may disable version 3 and leave legacy
execution unchanged. After a workspace has produced version 3 occurrence or
run records, rollback MUST first fence all version 3 dispatch and inspect the
run ledger. It MUST NOT simply restart the legacy scheduler, because that can
repeat already claimed time occurrences and external side effects. Recovery
uses the canonical store and migration report rather than reverse dual-write.

## 14. Documentation Follow-Up

Implementation rollout must later replace the current user guide sections that
describe `SchedulerTick`, five-field-only cron, prompt actions that always
create Sessions, and Pi prompt-automation delegation. CLI, external ingress,
generated AsyncAPI, extension compatibility, and migration guidance must be
derived from this contract rather than maintained as competing protocol text.
