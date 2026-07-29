---
schema: project-module/v1
id: headless-server-cli
name: Headless Server and CLI
summary: Reusable backend bootstrap, RPC transport, runtime services, standalone server, and command-line client.
status: active
when_to_read:
  - headless server bootstrap, RPC transport, runtime services, WebSocket, or CLI changes
tags:
  - server
  - cli
  - rpc
  - websocket
  - bootstrap
  - headless
entrypoints:
  - apps/cli/src/index.ts
  - packages/server-core/src/index.ts
  - packages/server/src/index.ts
depends_on:
  - shared-contracts
  - session-lifecycle
related:
  - web-viewer-clients
validation:
  - bun test apps/cli packages/server packages/server-core
  - bun run typecheck:all
---

# Purpose

Run Mortise capabilities without Electron and expose them to CLI and WebSocket clients.

# Boundary

Maintain server lifecycle, capabilities, routing, authentication boundary, client reconnect, remote UI streams, and startup discovery.

Do not own feature-specific domain logic, desktop IPC, or browser client presentation.

# Capabilities

Own backend bootstrap, endpoint discovery, runtime composition, RPC transport, server executable, and command-line experience.

`server-core` composes reusable services; `packages/server` starts them; `apps/cli` consumes the RPC client.

# Invariants

Headless and Electron backends share domain contracts; endpoints authenticate before privileged calls; server startup reports a usable endpoint.

# Change Impact

Feature handlers remain reviewed with their domain owners; WebUI consumes the same transport through its browser adapter.

Client/server version skew affects capabilities; stale endpoint discovery can connect a client to the wrong backend.

# Validation

Run server-core, server smoke, CLI command, streaming, spawner, and transport tests.
