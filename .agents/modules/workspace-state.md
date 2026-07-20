---
schema: module-agent/v1
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
scope_digest: c0313e97ab90100e9ea5ee9d2fb7f29750b8e91e
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
Workspace writes are atomic and conflict-aware; file RPC stays inside the selected workspace; switching workspace replaces workspace-owned state.

## Architecture and entry points
Shared storage provides the durable boundary, server RPC exposes workspace operations, and renderer workspace components drive selection.

## Collaboration
Coordinate layout replacement with `universal-layout` and workspace-owned session publication with `session-lifecycle`.

## Validation
Run multi-writer storage, workspace normalization, path validation, and renderer transition tests.

## Known risks
Path normalization differs by platform; concurrent source and installed backends can race without operation identities.

## Semantic history
- 2026-07-20: Added independently negotiated domain capabilities to MultiWriterStore mutations while preserving compatible reads and unrelated writes.
- 2026-07-20: Stopped creating workspace Data Source and local-MCP settings while preserving legacy fields and directories as opaque user data.
- 2026-07-18: Hardened shared multi-writer storage and atomic persistence.
- 2026-07-18: Advanced workspace-scoped universal layout transitions.
