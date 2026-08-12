---
schema: project-module/v1
id: pi-coding-runtime
name: Mortise Embedded Coding Runtime
summary: Mortise-only embedded headless Agent runtime, RPC host, sessions, tools, compaction, and extension lifecycle.
status: active
when_to_read:
  - embedded Pi coding runtime, RPC host, sessions, tools, compaction, or extension lifecycle changes
  - Attempt identity, continue-from-history behavior, or interrupted continuation changes
tags:
  - coding-agent
  - embedded-runtime
  - headless
  - rpc
  - extension
  - session
  - tools
  - compaction
  - attempt
  - interrupted-continuation
  - attempt-identity
  - session-runtime-ownership
entrypoints:
  - pi/packages/coding-agent/src/index.ts
  - pi/packages/coding-agent/src/core/index.ts
  - pi/packages/coding-agent/src/core/compaction/index.ts
depends_on:
  - pi-agent-engine
  - provider-model-runtime
related: []
frontend_impact:
  affects: true
  areas:
    - session runtime, compaction, tool, and extension states rendered in conversation surfaces
validation:
  - npm --prefix pi test --workspace @mortise/pi-coding-agent
  - npm --prefix pi run build:workspace
---

# Purpose

Provide Mortise with its embedded headless coding-Agent runtime over the repository's UI-neutral Agent engine.

# Boundary

Maintain the UI-neutral coding-agent core, Mortise headless/RPC entrypoint, Session and compaction behavior, concrete tools, extension loading, sidecar integration, and versioned host contracts.

Do not operate or preserve an independent Pi product in this repository. Do not maintain or ship TUI, interactive mode, terminal themes or session pickers, a standalone coding-agent CLI, browser launcher, self-update channel, or separate release surface. The independently operated external Pi repository is out of scope. Mortise desktop chrome, server-side persistence, and provider transports remain owned by their respective modules.

# Capabilities

Own the Mortise-only coding runtime, including Session behavior, tools, compaction, extension lifecycle, and the dedicated headless/RPC host contract. Keep terminal presentation outside the production runtime graph.

`pi/packages/coding-agent` contains the embedded core, tools, sessions, compaction, extension APIs, and the dedicated Mortise headless/RPC entrypoint. `pi/packages/agent` remains the UI-neutral Agent Loop authority. The compiled headless entrypoint is the only staged runtime; terminal presentation, interactive/standalone launchers, and JavaScript runtime fallbacks are absent from the supported source and production graphs.

The shared GlobalHost keeps compiled Extension module and resource-resolution caches warm across isolated Session runtimes for an attached Workspace. Deferred request preparation is single-flight per runtime and converts optional resource, Extension, network, model-selection, or prompt-rebuild failures into runtime diagnostics instead of disabling input.

# Invariants

The UI-neutral Agent Loop, Session, tool execution, compaction, extension lifecycle, and RPC semantics are canonical and must not change during headless separation. Pi is the sole runtime authority for Session history, command acceptance, Attempt, Turn, and Agent Loop state. Prompt, continue, steer, follow-up, compact, abort, tool execution, and settlement commands enter one Session state machine, which accepts, queues, or rejects them according to its current state. Pi assigns a stable `attemptId` when it starts an Attempt and carries it on lifecycle, message, and tool events for correlation and stale-generation isolation; Pi retry counters remain internal details of that Attempt. `continueFromHistory` may create a new Attempt only after an explicit continuation command and must never run automatically merely because a runtime restarted or interrupted history exists. Mortise routes Workspace-level requests to one canonical Pi runtime per persistent Session and projects the long-lived Session event stream; it does not issue Attempt permissions or maintain a parallel execution state machine. RPC events and the single host-neutral Extension contract remain versioned for supported Mortise hosts; target and engine selectors are invalid. Cleanup, abort, retry, settlement, and replacement paths complete in canonical order; tool results remain serializable. Production headless code must not import TUI or terminal component/render types, and Mortise extension GUI must flow only through versioned host/RPC contribution APIs. No interactive, standalone, or external-Pi compatibility fallback may remain reachable from production entrypoints.

The tool execution contract is policy-neutral: Pi runs Extension `tool_call` handlers first, then asks the host only for generic allow, block, or input-modification coordination. Permission modes, approval queues, remembered decisions, and approval presentation must not be implemented in the coding runtime or RPC host.

# Change Impact

Coordinate host-facing RPC and extension lifecycle changes with `extension-runtime`, Session publication and durability with `session-lifecycle`, host composition with `headless-server-cli`, and production graph or artifact gates with `build-release-observability`.

Future changes can accidentally reintroduce terminal dependencies through exports, package metadata, extension types, assets, or resolver candidates, or alter event ordering, cancellation, durability, compaction, and extension cleanup semantics while changing the headless boundary. Production import, metafile, staged-artifact, and runtime-resolution guards must therefore remain fail-closed. External-Pi compatibility pressure must not reintroduce aliases or fallbacks into the Mortise runtime.

# Validation

Run coding-runtime and workspace contract tests plus downstream Agent Loop, Session, compaction, extension-lifecycle, and RPC regressions. Headless-separation acceptance additionally requires an import-boundary guard that rejects TUI dependencies from the core graph and a production artifact scan that rejects interactive, standalone CLI, launcher, updater, terminal asset, and fallback entrypoints.
