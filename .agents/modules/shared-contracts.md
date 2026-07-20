---
schema: module-agent/v1
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
scope_digest: 1fae253fe83b9565c4aab2e03b880f066d98a1ab
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
- 2026-07-20: Added the strict versioned `automation.workspace` request and result DTO boundary for unified Automations V3.
- 2026-07-12: Unified session projection and WebUI runtime contracts.
- 2026-07-19: Renamed project-owned protocol and package identity to Mortise.
- 2026-07-20: Removed the built-in Data Sources RPC, session, and message contracts while retaining generic MCP and extension contracts.
