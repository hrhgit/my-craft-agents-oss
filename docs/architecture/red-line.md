# The Red Line: bottom layer vs scaffolding

Mortise embeds the Pi agent backend. Pi owns agent-runtime semantics and the
typed storage implementations; Mortise owns its product data root, host UI,
and workflow scaffolding. Independent Pi and Mortise use distinct user roots.

This document defines the boundary that keeps "Pi as the base, Mortise as the
shell" honest. It is enforced by ESLint (see the `no-restricted-syntax` and
`mortise-shared/no-raw-pi-file-io` rules in each package's `eslint.config.mjs`)
and by code review.

## Bottom layer — owned by Pi, unified into Pi

These concerns live in the monorepo's `pi/` subtree (`@mortise/pi-*`). Mortise
binds the runtime to `~/.mortise/agent/`; independent Pi keeps `~/.pi/agent/`. Mortise
must not reimplement them, must not monkey-patch their internals, and must not
import them outside the sanctioned seam (see below).

- Agent runtime mechanics: `AgentSession`, the Session command queue, Attempt
  and Turn lifecycle, the model/tool loop, and the semantics of prompt, steer,
  follow-up, compaction, abort, retry, and branch/fork/clone.
- Session storage: JSONL tree format, `~/.mortise/agent/sessions/{encoded-cwd}/`,
  the cwd→bucket encoding.
- Credential storage: `~/.mortise/agent/auth.json` (plaintext, 0600).
- Config storage: `~/.mortise/agent/models.json`, `settings.json`
  (`shellGui.*`, `extensionConfig.*`, `mortise.agent.*` namespaces).
- Provider/model registry and discovery.
- Tool definitions and execution (built-in tools, custom tools, proxy tools).
- Network layer: fetch, SSE, the network sidecar, request/response shaping.
- System prompt construction and per-turn override.
- Extension system: `ExtensionContext`, `ExtensionUIContext`, `EventBus`,
  `createHeadlessUIContext`, skills, widgets, commands.

When Mortise needs a new Session or engine capability in any of these, the
behavior is implemented **in Pi** and exposed through a typed Session command or
event contract. Every command that changes Session runtime state must enter the
same Pi Session state machine, regardless of whether it originated from the UI,
Automation, Messaging, an Agent tool, or an Extension. Mortise routes product
requests to the canonical Pi runtime; it does not create a parallel Attempt
state machine or authorize individual Pi lifecycle transitions.

## Scaffolding — owned by Mortise, must not touch the bottom layer

These are host-side concerns. Pi does not know they exist. Mortise is free to
add, change, and extend them without touching Pi.

- UI rendering (React, shadcn, Tailwind, the GUI OKLCH theme — distinct from
  Pi's TUI theme).
- Workspace registry, switching, and bounded create/edit dialogs.
- Multi-session history, unread tracking, session naming.
- Automations engine (SchedulerTick, PreToolUse triggers, etc.) —
  Mortise listens to its own events and routes Session commands to the
  canonical Pi runtime.
- Messaging gateway (Telegram, WhatsApp), pairing, bindings.
- Browser pane manager (local and remote-bridged).
- File attachments, rich-output block rendering, deep linking, updater,
  i18n, settings UI.

Scaffolding code talks to Pi through exactly two channels:

1. **Internal `RpcClient`** — typed Session commands and a long-lived event
   stream over the RPC protocol. Pi accepts, queues, or rejects commands through
   its Session state machine and assigns `attemptId` when a new Attempt starts.
2. **Pi host facade** — typed public helpers exported by
   `@mortise/pi-coding-agent` for global config, credentials, session
   projection/fork, skills, and extensions. Mortise must not reimplement Pi file
   locking or raw `~/.mortise/agent/*.json` read-modify-write logic.

## The sanctioned seam

`packages/shared/src/agent/backend/**` is the only place in `packages/shared`
that may import Pi event/runtime internals for adapter work. It holds the typed
event adapter and host driver that route commands to Pi and translate Pi's typed
Session events into Mortise projections while preserving Pi-issued `attemptId`
values. This seam is expected to **shrink** over time as the internal RPC
contract becomes more direct.

A small number of files outside `agent/backend/**` may import PUBLIC Pi APIs
(`RpcClient`, `AuthStorage`, `SettingsManager`, static provider catalogs) or
raw Pi path constants; they are listed in the ratchet allowlist below.

`packages/pi-agent-server` was the legacy bridge that re-implemented a JSONL
protocol parallel to Pi's native RPC mode. It has been deleted; Mortise's Pi
backend now talks to Pi through Pi's public `RpcClient`.

## Red lines

**Red line 1 — host/shared code must not import Pi internals.**
`apps/electron/**`, `packages/ui/**`, and `packages/shared/src/**` (except
`agent/backend/**`) must not `import` from `@mortise/pi-*`. Enforced by
`no-restricted-syntax` in each package's eslint config.

**Red line 2 — no monkey-patching Pi private state.**
No code outside Pi may assign to `agent.state.systemPrompt`,
`_baseSystemPrompt`, `_rebuildSystemPrompt`, patch `globalThis.fetch` to
intercept Pi's requests, or reach into any field prefixed with `_` on a Pi
class. Capabilities in this category must go through typed public APIs in Pi.
Mortise passes host hooks through Pi `RpcClient({ hostHooksModule })` →
`createAgentSession({ fetchInterceptor, toolMetadataResolver })`; tool display
metadata is carried by Pi tool events, not by a cross-process metadata file.

**Red line 3 — one Session state machine and one runtime owner.**
Pi is the sole runtime authority for Session history, command acceptance,
Attempt, Turn, and Agent Loop state. Every prompt, continue, steer, follow-up,
compact, and abort command must enter the canonical Pi Session state machine;
no caller may mutate Agent runtime state through a parallel queue or lifecycle
path. Mortise owns Workspace routing and must resolve one canonical Pi runtime
for each persistent Session, but it must not maintain a competing Attempt state
machine. Extensions may submit commands to their current Pi Session and observe
events, but must not bypass the Session state machine or launch a second runtime
for the same persistent Session.

## Ratchet allowlist

The following files outside `agent/backend/**` are sanctioned seam extensions,
not violations. Each must consume a typed PUBLIC Pi API where one exists; raw
file access is allowed only where Pi does not yet expose the required setter or
where Mortise is preserving its own opaque metadata.

### Public Pi API imports

- `packages/shared/src/credentials/backends/secure-storage.ts` — thin wrapper
  over Pi host facade's `mortise.<slug>` credential API. It must not import Pi
  path constants or reimplement `auth.json` I/O/file locking.
- `packages/shared/src/config/models-pi.ts` — static model/provider catalog
  (`getModels`/`getProviders`) used for pre-auth provider listing in connection
  setup. `RpcClient.getAvailableModels()` requires a live authenticated session
  and cannot serve this path.
- `packages/shared/src/config/agent-settings.ts` — consumes Pi's public
  compaction default and frontmatter parser while Mortise owns the surrounding
  settings UI and subagent definitions. Agent-root resolution goes through the
  typed host facade.
- `packages/shared/src/config/pi-global-config.ts` — compatibility shell around
  Pi host facade for global providers/defaults,
  `mortise.agent.*`, `shellGui.*`, and `extensionConfig.*`. It resolves the Agent
  root and subscribes to configuration changes through typed Pi facade APIs; it
  must not import Pi storage-path constants.
- `packages/shared/src/pi/pi-skill-resolver.ts` and
  `packages/shared/src/skills/storage.ts` — synchronous UI/server seams over
  Pi's skill listing facade. Mortise may validate slugs and render metadata, but
  skill discovery/parsing stays in Pi.
- `packages/shared/src/sessions/storage.ts` — workspace-scoped session sidecar
  helpers plus Pi projection creation/lookup facade calls. It may import
  `MORTISE_SESSIONS_DIR` only to compute the current workspace bucket.
- `packages/shared/src/sessions/tree-jsonl.ts` — uses Pi `SessionManager` for
  JSONL entry projection and Pi's typed Session UI metadata sidecar facade for
  Mortise UI projection. It may keep lightweight first-line/projection readers
  but must not own Pi transcript locking or rewrite Pi entry bodies.
- `packages/shared/src/ui-validation/session-validation-backend.ts` and
  `packages/shared/src/sessions/__tests__/tree-jsonl.test.ts` — isolated
  contract probes over Pi's public `SessionManager`; neither is a general host
  persistence API.
- `packages/shared/src/agent/pi-agent.ts` — Mortise's backend adapter over Pi's
  public `RpcClient`, preserving host-side workflow scaffolding without
  re-implementing Pi's agent runtime.

### Raw Pi path constants

`mortise-shared/no-raw-pi-file-io` blocks new imports of Mortise Agent storage path constants
outside this list:

- `packages/shared/src/config/paths.ts` — defines the path constants.
- `packages/shared/src/sessions/storage.ts` — `MORTISE_SESSIONS_DIR` only, to compute
  workspace bucket paths and delegate creation/lookup to Pi projection facades.
- `packages/shared/src/workspaces/storage.ts` — read-only session bucket
  projection for workspace/session routing.

The allowlists are recorded in `packages/shared/eslint.config.mjs` and
`packages/shared/eslint-rules/no-raw-pi-file-io.cjs`. Any NEW file that wants a
Pi import or Pi path constant must either go through `agent/backend/**`, or make
the case here for why it is a seam extension.

## Ratchet removal route

- `secure-storage.ts` has left the raw path allowlist; it now calls Pi's
  credential facade only.
- `pi-global-config.ts` now resolves the Agent root and watches global config
  through Pi's typed facade subscription; its raw path allowlist entry is gone.
- `sessions/storage.ts` delegates Pi-owned reads to projection APIs and
  `sessions/tree-jsonl.ts` uses Pi's typed UI metadata sidecar/projection
  contract. Mortise-only Session overlay files and their merge path are gone.
- The legacy Mortise storage migration window is closed. Mortise no longer imports
  or reads legacy session, skill, credential, or messaging storage, and no
  longer migrates legacy workspace cwd or Pi provider configuration at
  startup.
