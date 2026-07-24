---
schema: module-agent/v1
id: pi-coding-runtime
name: Mortise Embedded Coding Runtime
summary: Mortise-only embedded headless Agent runtime, RPC host, sessions, tools, compaction, and extension lifecycle.
status: active
keywords: [coding-agent, embedded-runtime, headless, rpc, extension, session, tools, compaction]
owns:
  - pi/packages/coding-agent/**
  - pi/packages/tui/**
  - pi/packages/web-launcher/**
related: [apps/electron/resources/pi-extensions/**, packages/shared/src/agent/**]
depends_on: [pi-agent-engine, provider-model-runtime]
collaborates_with: []
validation:
  - { id: pi-coding-regression, kind: unit, command: "npm --prefix pi test --workspace @mortise/pi-coding-agent", description: "Run Pi coding runtime regressions.", triggers: [owned-change], required: true, evidence: "Workspace test exit status and output." }
  - { id: pi-workspace-contract, kind: contract, command: "npm --prefix pi run build:workspace", description: "Build Pi workspaces to verify package contracts.", triggers: [contract-change], required: true, evidence: "Workspace build exit status and diagnostics." }
scope_digest: 005c2d34912aca7d1973b28163106fd4e0d244a1
---

## Purpose
Provide Mortise with its embedded headless coding-Agent runtime over the repository's UI-neutral Agent engine.

## Specialist mandate
Own the Mortise-only coding runtime, including Session behavior, tools, compaction, extension lifecycle, and the dedicated headless/RPC host contract. Keep terminal presentation outside the production runtime graph.

## Responsibilities
Maintain the UI-neutral coding-agent core, Mortise headless/RPC entrypoint, Session and compaction behavior, concrete tools, extension loading, sidecar integration, and versioned host contracts. Until deleted, `pi/packages/tui` and `pi/packages/web-launcher` remain owned only as quarantined non-production removal surfaces, not as supported runtime capabilities.

## Non-goals
Do not operate or preserve an independent Pi product in this repository. Do not maintain or ship TUI, interactive mode, terminal themes or session pickers, a standalone coding-agent CLI, browser launcher, self-update channel, or separate release surface. The independently operated external Pi repository is out of scope. Mortise desktop chrome, server-side persistence, and provider transports remain owned by their respective modules.

## Contracts and invariants
The UI-neutral Agent Loop, Session, tool execution, compaction, extension lifecycle, and RPC semantics are canonical and must not change during headless separation. RPC events and extension contracts remain versioned for supported Mortise hosts; cleanup, abort, retry, settlement, and replacement paths complete in canonical order; tool results remain serializable. Production headless code must not import TUI or terminal component/render types, and Mortise extension GUI must flow only through versioned host/RPC contribution APIs. No interactive, standalone, or external-Pi compatibility fallback may remain reachable from production entrypoints.

## Architecture and entry points
`pi/packages/coding-agent` contains the embedded core, tools, sessions, compaction, extension APIs, and the dedicated Mortise headless/RPC entrypoint. `pi/packages/agent` remains the UI-neutral Agent Loop authority. Terminal presentation, currently represented by interactive/TUI/launcher code under the owned scope, is a separate non-production concern scheduled for removal and must not be imported, bundled, staged, or selected by Mortise production builds.

## Collaboration
Coordinate host-facing RPC and extension lifecycle changes with `extension-runtime`, Session publication and durability with `session-lifecycle`, host composition with `headless-server-cli`, and production graph or artifact gates with `build-release-observability`.

## Validation
Run coding-runtime and workspace contract tests plus downstream Agent Loop, Session, compaction, extension-lifecycle, and RPC regressions. Headless-separation acceptance additionally requires an import-boundary guard that rejects TUI dependencies from the core graph and a production artifact scan that rejects interactive, standalone CLI, launcher, updater, terminal asset, and fallback entrypoints.

## Known risks
The current mixed entrypoint and extension type surface can pull TUI code into the embedded graph even when Mortise starts in RPC mode. Removing presentation code can accidentally alter event ordering, cancellation, durability, compaction, or extension cleanup semantics; retaining shared launchers, exports, package metadata, assets, or resolver candidates can silently preserve a second product path. External-Pi compatibility pressure must not reintroduce aliases or fallbacks into the Mortise runtime.

## Semantic history
- 2026-07-24: Locked the embedded host thinking-level boundary to the six current values and retained typed rejection for retired values without aliases or migration.
- 2026-07-23: Declared this repository's `pi/` subtree a Mortise-only embedded headless runtime, preserved canonical UI-neutral Agent and RPC semantics, and classified TUI, interactive, standalone CLI, launcher, updater, and separate Pi product surfaces as non-production removal scope with no compatibility fallback.
- 2026-07-23: Parameterized the project config root across startup, RPC runtimes, settings, packages, and resources so embedded Mortise runtimes use `.mortise` exclusively while standalone Pi retains `.pi` as its default.
- 2026-07-23: Added an explicit hidden-only draft publication boundary and made cold host metadata updates merge under the canonical Session lock so concurrent active-runtime appends are preserved.
- 2026-07-22: Replaced synchronous Session JSONL hot-path writes with a bounded ordered async durability queue, preserving draft-only first-turn publication and requiring canonical flush/readback before markers, settlement, replacement, and shutdown.
- 2026-07-22: Treated missing usage in persisted assistant history as unknown telemetry, preserving prompt execution, overflow recovery, message/tool counts, and durability ordering without weakening live message types or inventing token values.
- 2026-07-22: Added an awaited RPC durability event that identifies the host mutation and canonical Session entry only after the user message is readable from the published JSONL, before logical settlement.
- 2026-07-21: Made interaction v1 and contribution v1 the sole RPC wire contracts for extension convenience dialogs and widgets, removing legacy request methods and scalar response variants.
- 2026-07-21: Retired startup credential and implicit environment-reference migrations, removed embedded provider API-key and child working-directory compatibility readers, and made current auth/models plus inherited workspace roots the only supported contracts.
- 2026-07-21: Replaced Craft-named host storage, facade, session metadata, and RPC client APIs with canonical Mortise names and removed the legacy fetch-interceptor environment/export aliases.
- 2026-07-21: Removed implicit extension-directory discovery and legacy extension pattern/self-update compatibility coverage, making strict `{ id, path, targets }` declarations and the current Mortise distribution the only supported contracts.
- 2026-07-21: Restored generated built-in models as the coding runtime registry baseline, layered current models.json overrides over that baseline, and made path-segment find globs independent of Windows drive and separator syntax.
- 2026-07-21: Updated the subagent example to obtain the current thinking level from the extension API instead of the narrower execution context, restoring the canonical Pi type-check gate.
- 2026-07-21: Made RPC completion helpers wait for logical `agent_settled` after retry and compaction recovery rather than stopping at an intermediate `agent_end`.
- 2026-07-20: Removed Mortise Data Sources host events and session activation plumbing from the Pi RPC contract while preserving generic extension and MCP capabilities.
- 2026-07-14: Added versioned extension UI validation and closed RPC interaction lifecycle gaps.
- 2026-07-18: Integrated the Pi coding runtime into the Mortise monorepo.
- 2026-07-20: Added explicit host system-prompt clear/append semantics and strict capability route identity validation.
