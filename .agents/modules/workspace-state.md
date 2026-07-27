---
schema: module-agent/v2
id: workspace-state
name: Workspace State
summary: Workspace discovery, storage, selection, file watching, and workspace-scoped transitions.
status: active
keywords: [workspace, project, cwd, storage, navigation, file-watch]
owns:
  - packages/shared/src/workspaces/**
  - packages/shared/src/storage/**
  - packages/server-core/src/handlers/rpc/workspace.ts
  - packages/server-core/src/handlers/rpc/files.ts
  - packages/server-core/src/handlers/rpc/files.test.ts
  - apps/electron/src/renderer/components/workspace/**
  - packages/server-core/src/handlers/rpc/transfer*.ts
  - packages/server-core/src/handlers/rpc/workspace-*.ts
related: [apps/electron/src/transport/workspace-api.ts, packages/server-core/src/runtime/**]
depends_on: [shared-contracts]
collaborates_with: []
validation:
  - { id: workspace-state-regression, kind: unit, command: "bun test packages/shared/src/workspaces packages/shared/src/storage packages/server-core/src/handlers/rpc/files.test.ts", description: "Run workspace state, storage, and file RPC regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
---

## Purpose
Make workspace identity and mutable workspace data consistent across processes and concurrent backends.

## Specialist mandate
Own workspace records, multi-writer storage primitives, workspace RPC, file access boundaries, and renderer workspace transitions.

## Responsibilities
Maintain atomic workspace persistence, path validation, file watching, creation flows, and workspace selection semantics.

## Non-goals
Do not own session transcript storage, dock layout rendering, or file preview presentation.

## Contracts and invariants
Workspace writes are atomic and conflict-aware; file RPC stays inside the selected workspace; switching workspace replaces workspace-owned state; Mortise project resources resolve exclusively under `<workspace>/.mortise`, while Session buckets remain under the Mortise-owned Agent root.

## Architecture and entry points
Shared storage provides the durable boundary, server RPC exposes workspace operations, and renderer workspace components drive selection.

## Collaboration
Coordinate layout replacement with `universal-layout` and workspace-owned session publication with `session-lifecycle`.

## Validation
Run multi-writer storage, workspace normalization, path validation, and renderer transition tests.

## Known risks
Path normalization differs by platform; concurrent source and installed backends can race without operation identities.

## Semantic history
- 2026-07-28: Made ID-keyed SQLite topology authoritative for Workspace V2 locations, added strict membership markers and revisioned idempotent mutations, and qualified local file/draft/watch/transfer operations by stable location identity.
- 2026-07-23: Hard-cut workspace project resources to `<workspace>/.mortise`, renamed the Session bucket API to Mortise terminology, and retained no project `.pi` fallback or alias.
- 2026-07-23: Routed workspace Session projections through the Mortise-owned Agent root without reading independent Pi Session history.
- 2026-07-21: Made `state.sqlite` the sole workspace-configuration authority, removed workspace-local JSON import/materialization, strictly rejected retired fields and permission aliases without rewriting them, and published the canonical record identity for non-runtime consumers.
- 2026-07-21: Stopped workspace load and creation from deleting retired organization files; legacy user data stays opaque until an explicitly confirmed cleanup.
- 2026-07-20: Added independently negotiated domain capabilities to MultiWriterStore mutations while preserving compatible reads and unrelated writes.
- 2026-07-20: Stopped creating workspace Data Source and local-MCP settings while preserving legacy fields and directories as opaque user data.
- 2026-07-18: Hardened shared multi-writer storage and atomic persistence.
- 2026-07-18: Advanced workspace-scoped universal layout transitions.
