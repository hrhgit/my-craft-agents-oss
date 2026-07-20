---
schema: module-agent/v1
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
scope_digest: 6263004e6984f9b91e0f5dc52bcbf9185409a204
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
Targets accept only `pi` and `mortise`; reload interrupts running sessions only after confirmation; capability negotiation precedes use.

## Architecture and entry points
Shared agent backends manage Pi hosts; server-core bridges extension contributions and interactions to connected clients.

## Collaboration
GUI contribution shapes belong to `extension-ui`; validation semantics integrate with `ui-validation-developer-kit`.

## Validation
Run host recovery, routing, extension bridge, reload, and capability tests.

## Known risks
Subprocess failure can be misreported as session failure; extensions can evolve faster than a packaged host facade.

## Semantic history
- 2026-07-12: Added the global Pi extension host runtime.
- 2026-07-14: Hardened RPC extension lifecycle and recovery.
- 2026-07-20: Unified legacy capability declaration, request, response, and cancellation runtime identities while preserving host-owned routing.
- 2026-07-20: Aligned source-auth regression coverage with the current HTTP/SSE contract and made PowerShell parser fixtures self-contained.
- 2026-07-20: Removed the obsolete Data Sources bridge server path from backend runtime resolution.
