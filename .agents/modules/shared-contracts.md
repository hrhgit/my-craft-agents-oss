---
schema: module-agent/v2
id: shared-contracts
name: Shared Contracts
summary: Cross-process domain types, protocol DTOs, routing, utilities, and core workspace abstractions.
status: active
keywords: [protocol, dto, event, channel, routing, domain, utility]
owns:
  - packages/core/**
  - packages/shared/package.json
  - packages/shared/tsconfig.json
  - packages/shared/CLAUDE.md
  - packages/shared/src/index.ts
  - packages/shared/src/branding.ts
  - packages/shared/src/feature-flags.ts
  - packages/shared/src/protocol/__tests__/routing.test.ts
  - packages/shared/src/protocol/__tests__/automation-capability.test.ts
  - packages/shared/src/protocol/__tests__/session-settlement.test.ts
  - packages/shared/src/protocol/automation-capability.ts
  - packages/shared/src/protocol/capabilities.ts
  - packages/shared/src/protocol/channels.ts
  - packages/shared/src/protocol/dto.ts
  - packages/shared/src/protocol/events.ts
  - packages/shared/src/protocol/index.ts
  - packages/shared/src/protocol/pi-projection.ts
  - packages/shared/src/protocol/production.ts
  - packages/shared/src/protocol/routing.ts
  - packages/shared/src/protocol/types.ts
  - packages/shared/src/protocol/workspace-coordination.ts
  - packages/shared/src/types/**
  - packages/shared/src/utils/**
  - packages/shared/src/validation/**
related: [apps/electron/src/shared/**, packages/server-core/src/domain/**]
depends_on: []
collaborates_with: []
validation:
  - { id: shared-regression, kind: unit, command: "bun test packages/shared/src/protocol packages/shared/src/utils", description: "Run shared protocol and utility regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: shared-contract, kind: contract, command: "bun run typecheck:shared", description: "Verify shared contracts compile for consumers.", triggers: [contract-change], required: true, evidence: "TypeScript compiler exit status and diagnostics." }
---

## Purpose
Define stable data and utility boundaries shared by desktop, server, CLI, and browser clients.

## Specialist mandate
Own transport DTOs, channel contracts, routing types, core workspace interfaces, validation helpers, and broadly reused utilities.

## Responsibilities
Keep protocol exports explicit, wire values serializable, and low-level helpers platform-neutral.

## Non-goals
Do not implement client presentation, server orchestration, or feature-specific persistence.

## Contracts and invariants
Production protocol exports exclude test-only APIs; channel maps and DTOs stay consistent across all transports.

## Architecture and entry points
`@mortise/core` holds base domain types; `@mortise/shared/protocol` and shared utilities are the cross-process surface.

## Collaboration
All transport owners review changes that alter serialized structures or route semantics.

## Validation
Run protocol and utility tests, shared type checking, and channel-map parity checks.

## Known risks
A convenient shared helper can accumulate feature policy; protocol changes can compile locally while breaking older concurrent backends.

## Semantic history
- 2026-07-26: Preserved Automation run/history cursor query fingerprints and frozen pagination bounds across strict command and result DTO parsing, rejecting incomplete or mismatched cursor envelopes before they reach the indexed store.
- 2026-07-25: Kept shared environment sanitization as a consumer of the host-neutral sealed-runtime contract and removed the empty shared runtime ownership after canonical runtime authority moved to `session-tools-core`.
- 2026-07-22: Moved runtime-log locking, rotation, and append work to ordered asynchronous filesystem I/O, with bounded queue high-water and persistence-failure metrics plus orderly flush coverage.
- 2026-07-22: Added a typed accepted-pending-settlement Session failure event, runtime Session snapshot field, and payload-free Session command that can retry only the pending settlement boundary.
- 2026-07-22: Published the source-only first-turn validation backend through an explicit Node-only package subpath so browser consumers of the shared UI-validation barrel cannot import Pi runtime code.
- 2026-07-21: Exposed the side-effect-free Mortise SQLite state contract through a narrow package subpath for profile and tooling consumers.
- 2026-07-21: Replaced the legacy RemoteUI response channel with a strictly typed Extension Interaction V1 response contract and removed legacy bridge event variants.
- 2026-07-21: Added typed Session durability transport codes and serializable error data so retryability, publication outcome, and failure stage survive cross-process RPC.
- 2026-07-21: Removed historical `role=plan`, `planPath`, and legacy plan-artifact compatibility; plans use only assistant messages with `PlanArtifactV1`.
- 2026-07-21: Added the versioned cross-client platform capability snapshot and stable serializable `CAPABILITY_UNAVAILABLE` error-data contract.
- 2026-07-21: Removed per-session working-directory DTOs, commands, and events; workspace root is the sole path authority.
- 2026-07-21: Exposed bounded runtime-log queue metrics plus asynchronous and process-exit flush contracts for host lifecycle integration.
- 2026-07-21: Added local-only home skill discovery and selective batch-import RPC contracts, plus bundle-file collection for staged resource imports.
- 2026-07-20: Added the strict versioned `automation.workspace` request and result DTO boundary for unified Automations V3.
- 2026-07-12: Unified session projection and WebUI runtime contracts.
- 2026-07-19: Renamed project-owned protocol and package identity to Mortise.
- 2026-07-20: Removed the built-in Data Sources RPC, session, and message contracts while retaining generic MCP and extension contracts.
