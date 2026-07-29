---
schema: project-module/v1
id: workspace-state
name: Workspace State
summary: Workspace discovery, storage, selection, file watching, and workspace-scoped transitions.
status: active
when_to_read:
  - Workspace identity, discovery, locations, storage, selection, file watching, or scoped transition changes
tags:
  - workspace
  - project
  - cwd
  - storage
  - navigation
  - file-watch
entrypoints:
  - packages/shared/src/workspaces/index.ts
  - packages/shared/src/workspaces/topology-storage.ts
  - apps/electron/src/renderer/components/workspace/index.ts
depends_on:
  - shared-contracts
related: []
validation:
  - >-
    bun test packages/shared/src/workspaces packages/shared/src/storage
    packages/server-core/src/handlers/rpc/files.test.ts
---

# Purpose

Make workspace identity and mutable workspace data consistent across processes and concurrent backends.

# Boundary

Maintain atomic workspace persistence, path validation, file watching, creation flows, and workspace selection semantics.

Do not own session transcript storage, dock layout rendering, or file preview presentation.

# Capabilities

Own workspace records, multi-writer storage primitives, workspace RPC, file access boundaries, and renderer workspace transitions.

Shared storage provides the durable boundary, server RPC exposes workspace operations, and renderer workspace components drive selection.

# Invariants

Workspace writes are atomic and conflict-aware; file RPC stays inside the selected workspace; switching workspace replaces the active backend's Workspace-scoped projection; Mortise project resources resolve exclusively under `<workspace>/.mortise`, while Session buckets remain under the Mortise-owned Agent root. Removing a Workspace from the app preserves locations, markers, and files; detaching a location removes only its Workspace marker and preserves ordinary files; Workspace management exposes no delete-data command.

# Change Impact

Coordinate layout replacement with `universal-layout` and workspace-owned session publication with `session-lifecycle`.

Path normalization differs by platform; concurrent source and installed backends can race without operation identities. Marker detach must verify Workspace identity before deleting only the marker, and remove-from-app must never grow into data deletion.

# Validation

Run multi-writer storage, workspace normalization, path validation, and renderer transition tests.
