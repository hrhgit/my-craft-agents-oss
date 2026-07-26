---
schema: module-agent/v2
id: extension-runtime
name: Extension Runtime
summary: Pi host lifecycle, extension discovery, reload, capability negotiation, and backend bridges.
status: active
keywords: [extension, pi-host, reload, rpc, capability, contribution]
owns:
  - packages/shared/src/agent/**
  - packages/shared/src/pi/**
  - packages/server-core/src/handlers/rpc/extension-config-patch*.ts
  - apps/electron/resources/pi-extensions/**
  - apps/electron/resources/docs/pi-extensions.md
related: [pi/packages/coding-agent/src/core/extensions/**, packages/shared/src/config/pi-extension-settings.ts, packages/shared/src/protocol/extension-contributions.ts]
depends_on: [pi-coding-runtime, shared-contracts, app-settings-security]
collaborates_with: [extension-ui, session-tooling]
validation:
  - { id: extension-runtime-regression, kind: unit, command: "bun test packages/shared/src/agent packages/server-core/src/handlers/pi-extension-bridge.test.ts", description: "Run extension runtime and bridge regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
---

## Purpose
Host Pi extensions safely inside Mortise and bridge their lifecycle to clients.

## Specialist mandate
Own host process startup, extension discovery and configuration, RPC capabilities, recovery, reload, and backend contribution routing.

## Responsibilities
Maintain the Pi host manager, driver boundary, extension settings, reload interruption semantics, and server bridge.

## Non-goals
Do not own extension-rendered GUI, Pi's internal extension API, or provider transport implementations.

## Contracts and invariants
Targets accept only `pi` and `mortise`; Mortise GlobalHost discovery and child processes are pinned to the runtime's explicit Mortise Agent root rather than inherited Pi defaults; reload interrupts running sessions only after confirmation; capability negotiation precedes use.

## Architecture and entry points
Shared agent backends manage Pi hosts; server-core bridges extension contributions and interactions to connected clients.

## Collaboration
GUI contribution shapes belong to `extension-ui`; validation semantics integrate with `ui-validation-developer-kit`.

## Validation
Run host recovery, routing, extension bridge, reload, and capability tests.

## Known risks
Subprocess failure can be misreported as session failure; extensions can evolve faster than a packaged host facade.

## Semantic history
- 2026-07-25: Made immutable host mode an explicit validated runtime contract for backend startup, resolving Pi, Bun/Node, ripgrep, Session services, and tool environments only from the sealed capsule instead of packaged flags, PATH, or live-tree fallbacks.
- 2026-07-23: Pinned Mortise GlobalHost startup, session runtimes, isolated runtimes, and in-process skill resolution to the Mortise project root, eliminating workspace `.pi` fallback at the embedded Pi boundary.
- 2026-07-23: Bound shared Pi GlobalHost discovery and child process configuration to each Mortise runtime's explicit Agent root, preventing Electron-like callers from falling back to independent Pi storage.
- 2026-07-22: Forwarded Pi's canonical user-message durability acknowledgement ahead of logical settlement, including during abort suppression, so Host completion cannot overtake the persisted JSONL write.
- 2026-07-21: Removed legacy widget and scalar RemoteUI host mappings; Pi host events and responses now use only versioned extension contributions and interactions with trusted ownership.
- 2026-07-21: Made runtime replacement settle suspended Mortise event streams only after awaited host release, contained teardown callback failures, and retired force-aborted runtimes before terminal UI completion.
- 2026-07-21: Removed the per-session Pi RPC fallback and its environment escape hatches; every session now requires a version-compatible global Pi host, with process environments isolated by non-secret host fingerprints.
- 2026-07-21: Removed session-tool prefix normalization, split browser-tool aliases, and legacy permission-mode input aliases; host routing now accepts only exact canonical tool identities and public mode names.
- 2026-07-21: Removed ignored working-directory extension inputs and mutable cwd fallbacks; spawn, permission, skill, and tool routing use only the workspace root.
- 2026-07-21: Made packaged Pi runtime resolution select only the compiled executable under external `resources/pi-runtime`, ignoring legacy environment and JavaScript candidates and failing explicitly when the compiled runtime is absent.
- 2026-07-21: Kept Pi retry and abort attempt events distinct from logical `agent_settled`, exposed native follow-up delivery, and preserved raw lifecycle projection through the Mortise host bridge.
- 2026-07-14: Hardened RPC extension lifecycle and recovery.
- 2026-07-20: Unified legacy capability declaration, request, response, and cancellation runtime identities while preserving host-owned routing.
- 2026-07-20: Aligned source-auth regression coverage with the current HTTP/SSE contract and made PowerShell parser fixtures self-contained.
- 2026-07-20: Removed the obsolete Data Sources bridge server path from backend runtime resolution.
