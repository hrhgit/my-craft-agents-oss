---
schema: module-agent/v1
id: extension-ui
name: Extension UI
summary: Versioned host-rendered extension contributions, interactions, sandbox surfaces, and placement contracts.
status: active
keywords: [extension-ui, contribution, remote-ui, sandbox, slot, interaction]
owns:
  - packages/shared/src/protocol/extension-contributions.ts
  - packages/shared/src/protocol/extension-contributions.test.ts
  - packages/shared/src/protocol/extension-interactions.ts
  - packages/shared/src/protocol/extension-interactions.test.ts
  - packages/shared/src/protocol/extension-ui-validation.ts
  - packages/shared/src/protocol/__tests__/extension-ui-validation.test.ts
  - apps/electron/src/renderer/components/extensions/**
  - docs/architecture/pi-extension-gui.md
  - docs/architecture/pi-extension-gui-style-placement.md
related: [apps/electron/src/renderer/components/app-shell/**, pi/packages/coding-agent/examples/extensions/**]
depends_on: [extension-runtime, shared-contracts]
collaborates_with: [extension-runtime, ui-validation-developer-kit]
validation:
  - { id: extension-ui-regression, kind: unit, command: "bun test apps/electron/src/renderer/components/extensions packages/shared/src/protocol/extension-contributions.test.ts", description: "Run extension contribution UI regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: extension-ui-physical, kind: physical, command: "bun run test:ui-validation:extension", description: "Exercise extension UI through the shared Developer Kit host.", triggers: [ui-change, extension-contract-change, release], required: false, evidence: "Developer Kit run output and retained extension UI evidence." }
scope_digest: aa8b5d7c85c66a3479a00880d8a0dcdcca2cbb64
---

## Purpose
Let extensions add rich GUI while the host preserves stability, semantics, and shared-region policy.

## Specialist mandate
Own contribution schemas, renderer stores, sandbox hosts, remote interaction routing, and extension placement documentation.

## Responsibilities
Maintain versioned contribution validation, lifecycle state, composer integration, slots, focus semantics, and fallbacks.

## Non-goals
Do not hard-code extension-specific screens in core or grant arbitrary global positioning and z-index.

## Contracts and invariants
Extensions declare placement intent; Mortise owns ordering, overflow, collapse, focus, conflict resolution, and host-rendered safety.

## Architecture and entry points
Shared protocol defines wire schemas; renderer extension components translate validated contributions into host surfaces.

## Collaboration
Coordinate conversation slots with `conversation-ui`, workspace tabs with `universal-layout`, and semantic hooks with the developer kit.

## Validation
Run contribution protocol, interaction store, sandbox, renderer routing, and extension validation tests.

## Known risks
Contribution version skew can leave stale interaction state; excessive freedom can compromise host layout or accessibility.

## Semantic history
- 2026-07-13: Added versioned Pi extension UI contributions and placement policy.
- 2026-07-14: Synchronized extension interaction state and validation semantics.
