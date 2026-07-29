---
schema: project-module/v1
id: shared-contracts
name: Shared Contracts
summary: Cross-process domain types, protocol DTOs, routing, utilities, and core workspace abstractions.
status: active
when_to_read:
  - cross-process types, DTOs, events, channels, routing, or shared domain contracts
tags:
  - protocol
  - dto
  - event
  - channel
  - routing
  - domain
  - utility
entrypoints:
  - packages/core/src/index.ts
  - packages/shared/src/index.ts
  - packages/core/src/types/index.ts
depends_on: []
related: []
validation:
  - bun test packages/shared/src/protocol packages/shared/src/utils
  - bun run typecheck:shared
---

# Purpose

Define stable data and utility boundaries shared by desktop, server, CLI, and browser clients.

# Boundary

Keep protocol exports explicit, wire values serializable, and low-level helpers platform-neutral.

Do not implement client presentation, server orchestration, or feature-specific persistence.

# Capabilities

Own transport DTOs, channel contracts, routing types, core workspace interfaces, validation helpers, and broadly reused utilities.

`@mortise/core` holds base domain types; `@mortise/shared/protocol` and shared utilities are the cross-process surface.

# Invariants

Production protocol exports exclude test-only APIs; channel maps and DTOs stay consistent across all transports.

# Change Impact

All transport owners review changes that alter serialized structures or route semantics.

A convenient shared helper can accumulate feature policy; protocol changes can compile locally while breaking older concurrent backends.

# Validation

Run protocol and utility tests, shared type checking, and channel-map parity checks.
