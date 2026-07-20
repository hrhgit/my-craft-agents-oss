---
schema: module-agent/v1
id: headless-server-cli
name: Headless Server and CLI
summary: Reusable backend bootstrap, RPC transport, runtime services, standalone server, and command-line client.
status: active
keywords: [server, cli, rpc, websocket, bootstrap, headless]
owns:
  - apps/cli/**
  - packages/server/**
  - packages/server-core/package.json
  - packages/server-core/README.md
  - packages/server-core/tsconfig.json
  - packages/server-core/src/index.ts
  - packages/server-core/src/bootstrap/**
  - packages/server-core/src/capabilities/**
  - packages/server-core/src/domain/**
  - packages/server-core/src/runtime/**
  - packages/server-core/src/services/**
  - packages/server-core/src/transport/**
  - packages/server-core/src/utils/**
  - packages/server-core/src/webui/**
  - packages/server-core/src/handlers/*.ts
  - packages/server-core/src/handlers/__tests__/**
  - packages/server-core/src/handlers/rpc/index.ts
  - packages/server-core/src/handlers/rpc/server.ts
  - packages/server-core/src/handlers/rpc/system*.ts
  - docs/cli.md
  - apps/electron/resources/docs/mortise-cli.md
related: [packages/server-core/src/handlers/rpc/**, apps/webui/**]
depends_on: [shared-contracts, session-lifecycle]
collaborates_with: [web-viewer-clients]
validation:
  - { id: server-cli-regression, kind: unit, command: "bun test apps/cli packages/server packages/server-core", description: "Run headless server and CLI regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: server-cli-contract, kind: contract, command: "bun run typecheck:all", description: "Verify repository-wide server and CLI type contracts.", triggers: [contract-change], required: true, evidence: "TypeScript compiler exit status and diagnostics." }
scope_digest: fbd403ed161a1592e99cc3e0da740487e20bedde
---

## Purpose
Run Mortise capabilities without Electron and expose them to CLI and WebSocket clients.

## Specialist mandate
Own backend bootstrap, endpoint discovery, runtime composition, RPC transport, server executable, and command-line experience.

## Responsibilities
Maintain server lifecycle, capabilities, routing, authentication boundary, client reconnect, remote UI streams, and startup discovery.

## Non-goals
Do not own feature-specific domain logic, desktop IPC, or browser client presentation.

## Contracts and invariants
Headless and Electron backends share domain contracts; endpoints authenticate before privileged calls; server startup reports a usable endpoint.

## Architecture and entry points
`server-core` composes reusable services; `packages/server` starts them; `apps/cli` consumes the RPC client.

## Collaboration
Feature handlers remain reviewed with their domain owners; WebUI consumes the same transport through its browser adapter.

## Validation
Run server-core, server smoke, CLI command, streaming, spawner, and transport tests.

## Known risks
Client/server version skew affects capabilities; stale endpoint discovery can connect a client to the wrong backend.

## Semantic history
- 2026-07-20: Removed Data Sources commands, flags, and current-product documentation from the headless CLI while preserving generic MCP and extension interaction support.
- 2026-07-20: Required confirmation for automation reads that expose prompts, webhook configuration, run snapshots, or isolated-Agent output.
- 2026-07-20: Added the unified Automations V3 RPC and CLI surface plus loopback CloudEvents ingress with workspace-scoped token lifecycle.
- 2026-07-12: Unified WebUI and Electron session runtime behind server-core.
- 2026-07-18: Completed monorepo CI setup for shared server execution.
