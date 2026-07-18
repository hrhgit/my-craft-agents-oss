# The Red Line: bottom layer vs scaffolding

Craft Agents is a shell around the Pi agent backend. The goal is a single
unified base — Pi owns the agent runtime, session/credential/config storage,
provider/model registry, tool execution, network layer, system prompt, and
extension system. Craft owns the host UI and workflow scaffolding on top.

This document defines the boundary that keeps "Pi as the base, Craft as the
shell" honest. It is enforced by ESLint (see the `no-restricted-syntax` and
`craft-shared/no-raw-pi-file-io` rules in each package's `eslint.config.mjs`)
and by code review.

## Bottom layer — owned by Pi, unified into Pi

These concerns live in the monorepo's `pi/` subtree (`@earendil-works/pi-*`)
and their source of truth is `~/.pi/agent/`. Craft
must not reimplement them, must not monkey-patch their internals, and must not
import them outside the sanctioned seam (see below).

- Agent runtime: `AgentSession`, prompt/steer/follow-up, thinking levels,
  compaction, branch/fork/clone, abort, retry.
- Session storage: JSONL tree format, `~/.pi/agent/sessions/{encoded-cwd}/`,
  the cwd→bucket encoding.
- Credential storage: `~/.pi/agent/auth.json` (plaintext, 0600).
- Config storage: `~/.pi/agent/models.json`, `settings.json`
  (`shellGui.*`, `extensionConfig.*`, `craft.agent.*` namespaces).
- Provider/model registry and discovery.
- Tool definitions and execution (built-in tools, custom tools, proxy tools).
- Network layer: fetch, SSE, the network sidecar, request/response shaping.
- System prompt construction and per-turn override.
- Extension system: `ExtensionContext`, `ExtensionUIContext`, `EventBus`,
  `createHeadlessUIContext`, skills, widgets, commands.

When Craft needs a new capability in any of these, the change is made **in Pi**
and exposed as a typed public API (an RPC command, an `AgentSession` method, a
`PromptOptions` field, an `ExtensionContext` facet). Craft then consumes that
API.

## Scaffolding — owned by Craft, must not touch the bottom layer

These are host-side concerns. Pi does not know they exist. Craft is free to
add, change, and extend them without touching Pi.

- UI rendering (React, shadcn, Tailwind, the GUI OKLCH theme — distinct from
  Pi's TUI theme).
- Workspace registry, switching, and per-workspace configuration UI.
- Multi-session history, unread tracking, session naming.
- Automations engine (SchedulerTick, PreToolUse triggers, etc.) —
  Craft listens to its own events and drives Pi via `RpcClient`.
- Messaging gateway (Telegram, WhatsApp), pairing, bindings.
- Browser pane manager (local and remote-bridged).
- File attachments, rich-output block rendering, deep linking, updater,
  i18n, settings UI.

Scaffolding code talks to Pi through exactly two channels:

1. **`RpcClient`** — typed commands and events over the RPC protocol.
2. **Pi host facade** — typed public helpers exported by
   `@earendil-works/pi-coding-agent` for global config, credentials, session
   projection/fork, skills, and extensions. Craft must not reimplement Pi file
   locking or raw `~/.pi/agent/*.json` read-modify-write logic.

## The sanctioned seam

`packages/shared/src/agent/backend/**` is the only place in `packages/shared`
that may import Pi event/runtime internals for adapter work. It holds the typed
event adapter and thinking-level constants that translate Pi's typed events into
Craft's UI events. This seam is expected to **shrink** over time as Pi's
`RpcClient` exposes typed events directly and the translation layer thins.

A small number of files outside `agent/backend/**` may import PUBLIC Pi APIs
(`RpcClient`, `AuthStorage`, `SettingsManager`, static provider catalogs) or
raw Pi path constants; they are listed in the ratchet allowlist below.

`packages/pi-agent-server` was the legacy bridge that re-implemented a JSONL
protocol parallel to Pi's native RPC mode. It has been deleted; Craft's Pi
backend now talks to Pi through Pi's public `RpcClient`.

## Red lines

**Red line 1 — host/shared code must not import Pi internals.**
`apps/electron/**`, `packages/ui/**`, and `packages/shared/src/**` (except
`agent/backend/**`) must not `import` from `@earendil-works/pi-*`. Enforced by
`no-restricted-syntax` in each package's eslint config.

**Red line 2 — no monkey-patching Pi private state.**
No code outside Pi may assign to `agent.state.systemPrompt`,
`_baseSystemPrompt`, `_rebuildSystemPrompt`, patch `globalThis.fetch` to
intercept Pi's requests, or reach into any field prefixed with `_` on a Pi
class. Capabilities in this category must go through typed public APIs in Pi.
Craft passes host hooks through Pi `RpcClient({ hostHooksModule })` →
`createAgentSession({ fetchInterceptor, toolMetadataResolver })`; tool display
metadata is carried by Pi tool events, not by a cross-process metadata file.

## Ratchet allowlist

The following files outside `agent/backend/**` are sanctioned seam extensions,
not violations. Each must consume a typed PUBLIC Pi API where one exists; raw
file access is allowed only where Pi does not yet expose the required setter or
where Craft is preserving its own opaque metadata.

### Public Pi API imports

- `packages/shared/src/credentials/backends/secure-storage.ts` — thin wrapper
  over Pi host facade's `craft.<slug>` credential API. It must not import Pi
  path constants or reimplement `auth.json` I/O/file locking.
- `packages/shared/src/config/models-pi.ts` — static model/provider catalog
  (`getModels`/`getProviders`) used for pre-auth provider listing in connection
  setup. `RpcClient.getAvailableModels()` requires a live authenticated session
  and cannot serve this path.
- `packages/shared/src/config/pi-global-config.ts` — compatibility shell around
  Pi host facade for global providers/defaults,
  `craft.agent.*`, `shellGui.*`, and `extensionConfig.*`. Its only raw Pi path
  constant is `PI_AGENT_DIR`, used to watch for external Pi config changes; it
  must not import `PI_SETTINGS_FILE`, `PI_MODELS_FILE`, or `PI_AUTH_FILE`.
- `packages/shared/src/pi/pi-skill-resolver.ts` and
  `packages/shared/src/skills/storage.ts` — synchronous UI/server seams over
  Pi's skill listing facade. Craft may validate slugs and render metadata, but
  skill discovery/parsing stays in Pi.
- `packages/shared/src/sessions/storage.ts` — workspace-scoped session sidecar
  helpers plus Pi projection creation/lookup facade calls. It may import
  `PI_SESSIONS_DIR` only to compute the current workspace bucket.
- `packages/shared/src/sessions/tree-jsonl.ts` — uses Pi `SessionManager` for
  JSONL entry projection and Pi's `setCraftSessionMetadata` facade for Craft's
  opaque UI metadata. It may keep lightweight first-line/projection readers but
  must not own Pi transcript locking or rewrite Pi entry bodies.
- `packages/shared/src/agent/pi-agent.ts` — Craft's backend adapter over Pi's
  public `RpcClient`, preserving host-side workflow scaffolding without
  re-implementing Pi's agent runtime.

### Raw Pi path constants

`craft-shared/no-raw-pi-file-io` blocks new imports of Pi storage path constants
outside this list:

- `packages/shared/src/config/paths.ts` — defines the path constants.
- `packages/shared/src/config/pi-global-config.ts` — `PI_AGENT_DIR` only, for
  config-change watching until Pi exposes a typed subscription.
- `packages/shared/src/sessions/storage.ts` — `PI_SESSIONS_DIR` only, to compute
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
- `pi-global-config.ts` should lose raw path access once Pi exposes a
  config-change watcher/subscription.
- `sessions/storage.ts` has moved Pi-owned reads to projection APIs and
  `sessions/tree-jsonl.ts` uses Pi craft metadata setters. The remaining
  ratchet is to remove Craft-only overlays once Pi exposes a typed UI metadata
  sidecar/projection contract.
- The legacy Craft storage migration window is closed. Craft no longer imports
  or reads legacy session, skill, credential, or messaging storage, and no
  longer migrates legacy workspace cwd or Pi provider configuration at
  startup.
