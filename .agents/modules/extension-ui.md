---
schema: project-module/v1
id: extension-ui
name: Extension UI
summary: Versioned host-rendered extension contributions, interactions, sandbox surfaces, and placement contracts.
status: active
when_to_read:
  - extension-contributed GUI, interactions, sandbox surfaces, placement, or validation semantics
tags:
  - extension-ui
  - contribution
  - remote-ui
  - sandbox
  - slot
  - interaction
entrypoints:
  - docs/architecture/pi-extension-gui.md
  - packages/shared/src/protocol/extension-contributions.ts
  - packages/shared/src/protocol/extension-interactions.ts
depends_on:
  - extension-runtime
  - shared-contracts
related:
  - extension-runtime
  - ui-validation-developer-kit
validation:
  - >-
    bun test --isolate apps/electron/src/renderer/components/extensions
    packages/shared/src/protocol/extension-contributions.test.ts
  - bun run test:ui-validation:extension
---

# Purpose

Let extensions add rich GUI while the host preserves stability, semantics, and shared-region policy.

# Boundary

Maintain versioned contribution validation, lifecycle state, composer integration, slots, focus semantics, and fallbacks.

Do not hard-code extension-specific screens in core or grant arbitrary global positioning and z-index.

# Capabilities

Own contribution schemas, renderer stores, sandbox hosts, remote interaction routing, and extension placement documentation.

Shared protocol defines wire schemas; renderer extension components translate validated contributions into host surfaces.

# Invariants

Extensions declare placement intent; Mortise owns ordering, overflow, collapse, focus, conflict resolution, and host-rendered safety. Contribution runtimes and projections are backend-owned. Closing a tab does not unload the Extension, and a persisted layout reference whose Extension is unavailable remains an unavailable placeholder.

# Change Impact

Coordinate conversation slots with `conversation-ui`, workspace tabs with `universal-layout`, and semantic hooks with the developer kit.

Contribution version skew can leave stale interaction state; excessive freedom can compromise host layout or accessibility. Current contribution identity and storage still include Session/runtime-shaped ownership, so backend-type persistence remains an accepted implementation gap.

# Validation

Run contribution protocol, interaction store, sandbox, renderer routing, and extension validation tests.
