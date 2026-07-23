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
scope_digest: b529261472fd47b210f1ad3567b5f06d9db9dee5
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
- 2026-07-24: Made RPC listener allocation reject Fetch-blocked WebSocket ports and retry browser-unsafe ephemeral bindings before advertising readiness to Electron or WebUI clients.
- 2026-07-24: Made server registration parse only complete protocol-v2 records and remove live legacy or unsupported-version registrations instead of treating them as current locks.
- 2026-07-23: Removed startup-time Pi extension migration entirely; headless Mortise startup uses only Mortise-owned roots and never reads or imports the independent Pi Agent root.
- 2026-07-23: Bounded Session content search at the ripgrep process boundary by completing only a deterministic newest-first `maxSessions` prefix before termination, with bounded accumulation and stable result ordering.
- 2026-07-22: Exposed a payload-free Session settlement retry contract so RPC clients can resume host durability without resending an already accepted user message.
- 2026-07-22: Let isolated Developer Host workspace-server processes install the provisional first-turn validation backend only when run identity, profile mode, process role, and exact Mortise/Pi profile directories agree.
- 2026-07-21: Removed CLI and headless bridge adapters for legacy RemoteUI requests and synthesized widgets; terminal interaction now accepts only Interaction V1 and aborts bounded queued or active requests when versioned cancel/settled events arrive.
- 2026-07-21: Made Session transfer imports reject retired organization fields instead of accepting and discarding them.
- 2026-07-21: Preserved typed error data in both server-to-client and client-to-server RPC responses instead of reducing durability outcomes to message-only handler failures.
- 2026-07-21: Replaced duplicated bootstrap rollback and shutdown cleanup with one idempotent teardown state machine while retaining listener binding as the sole readiness commit.
- 2026-07-21: Removed the pre-protocol server-lock sentinel branch; backend coordination now accepts only the current versioned registration protocol.
- 2026-07-21: Made CLI WebSocket message routing single-phase so RPC responses arriving immediately after handshake cannot be lost while swapping event handlers.
- 2026-07-21: Removed the obsolete per-Session working-directory mutation from the headless SessionManager contract after workspace root became the sole path authority.
- 2026-07-21: Removed the obsolete Automations V2 RPC registration and made native URL/file/reveal actions return typed `CAPABILITY_UNAVAILABLE` errors when neither the requesting client nor host platform implements them.
- 2026-07-21: Extended transactional readiness through application runtime initialization so Automation and Messaging handlers, publishers, and workspace state are ready before the listener commits; rollback and stop dispose them in reverse order.
- 2026-07-21: Added a host-only first-turn publication hook so external gateways can install bindings before public Session events without creating empty Sessions.
- 2026-07-21: Made listener binding the bootstrap readiness commit and added rollback for partially initialized server resources and registrations.
- 2026-07-20: Removed Data Sources commands, flags, and current-product documentation from the headless CLI while preserving generic MCP and extension interaction support.
- 2026-07-20: Required confirmation for automation reads that expose prompts, webhook configuration, run snapshots, or isolated-Agent output.
- 2026-07-20: Added the unified Automations V3 RPC and CLI surface plus loopback CloudEvents ingress with workspace-scoped token lifecycle.
