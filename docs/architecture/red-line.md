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

These concerns live in the Pi repo (`@earendil-works/pi-*`, currently a fork at
`E:\_workSpace\_Agents\pi`) and their source of truth is `~/.pi/agent/`. Craft
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
- Multi-session inbox, status workflow (Todo/In Progress/Needs Review/Done),
  flagging, session naming.
- Automations engine (LabelAdd, SchedulerTick, PreToolUse triggers, etc.) —
  Craft listens to its own events and drives Pi via `RpcClient`.
- Messaging gateway (Telegram, WhatsApp), pairing, bindings.
- Browser pane manager (local and remote-bridged).
- File attachments, rich-output block rendering, deep linking, updater,
  i18n, settings UI.

Scaffolding code talks to Pi through exactly two channels:

1. **`RpcClient`** — typed commands and events over the RPC protocol.
2. **Pi's config file paths** — reading/writing `~/.pi/agent/*.json` through
   the typed helpers Pi exposes (e.g. `readPiGlobalAuth`, `SettingsManager`),
   never by re-instantiating Pi's internal classes in the host process.

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
  over Pi `AuthStorage`'s `craft.<slug>` credential namespace
  (`setCraftCredential`/`getCraftCredential`), a purpose-built public API. Pi
  owns credential storage; craft reimplementing auth.json I/O and file locking
  would violate the boundary in the other direction.
- `packages/shared/src/config/models-pi.ts` — static model/provider catalog
  (`getModels`/`getProviders`) used for pre-auth provider listing in connection
  setup. `RpcClient.getAvailableModels()` requires a live authenticated session
  and cannot serve this path.
- `packages/shared/src/config/pi-global-config.ts` — uses Pi `SettingsManager`
  for typed settings fields (`defaultProvider`, `defaultModel`,
  `defaultThinkingLevel`, `shellGui.*`, `extensionConfig.*`). It still performs
  raw writes for `models.json` provider CRUD and Pi-opaque `craft.agent.*`
  values because Pi does not expose typed setters for those domains.
- `packages/shared/src/sessions/tree-jsonl.ts` — uses Pi `SessionManager` for
  JSONL entry parsing/projection while preserving Craft's opaque header metadata
  with a lightweight first-line reader and raw metadata writes.
- `packages/shared/src/agent/pi-agent.ts` — Craft's backend adapter over Pi's
  public `RpcClient`, preserving host-side workflow scaffolding without
  re-implementing Pi's agent runtime.

### Raw Pi path constants

`craft-shared/no-raw-pi-file-io` blocks new imports of Pi storage path constants
outside this list:

- `packages/shared/src/config/paths.ts` — defines the path constants.
- `packages/shared/src/config/pi-global-config.ts` — see above.
- `packages/shared/src/credentials/backends/secure-storage.ts` — passes
  `PI_AUTH_FILE` to Pi `AuthStorage`.
- `packages/shared/src/sessions/storage.ts` and
  `packages/shared/src/sessions/tree-jsonl.ts` — session projection and
  Craft metadata sidecar/header writes while Pi lacks a craft-metadata setter.
  Read paths should delegate to Pi `SessionManager` where that is not a list-view
  performance regression.
- `packages/shared/src/config/unified-migration.ts` — one-shot migration into
  Pi-owned storage with rollback.
- `packages/shared/src/workspaces/storage.ts` and
  `packages/shared/src/pi/pi-session-store.ts` — read-only session bucket
  projections for workspace/session routing.

The allowlists are recorded in `packages/shared/eslint.config.mjs` and
`packages/shared/eslint-rules/no-raw-pi-file-io.cjs`. Any NEW file that wants a
Pi import or Pi path constant must either go through `agent/backend/**`, or make
the case here for why it is a seam extension.
