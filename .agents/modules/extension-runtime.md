---
schema: project-module/v1
id: extension-runtime
name: Extension Runtime
summary: Pi host lifecycle, extension discovery, reload, capability negotiation, and backend bridges.
status: active
when_to_read:
  - Pi extension discovery, host lifecycle, reload, capability negotiation, or backend bridge changes
tags:
  - extension
  - pi-host
  - reload
  - rpc
  - capability
  - contribution
entrypoints:
  - packages/shared/src/agent/index.ts
  - packages/shared/src/pi/index.ts
  - packages/shared/src/agent/backend/index.ts
depends_on:
  - pi-coding-runtime
  - shared-contracts
  - app-settings-security
related:
  - extension-ui
  - session-tooling
frontend_impact:
  affects: true
  areas:
    - extension settings, reload and status indicators, and contribution availability
validation:
  - bun test packages/shared/src/agent packages/server-core/src/handlers/pi-extension-bridge.test.ts
---

# Purpose

Host Pi extensions safely inside Mortise and bridge their lifecycle to clients.

# Boundary

Maintain the Pi host manager, driver boundary, extension settings, reload interruption semantics, and server bridge.

Do not own extension-rendered GUI, Pi's internal extension API, or provider transport implementations.

# Capabilities

Own host process startup, extension discovery and configuration, RPC capabilities, recovery, reload, and backend contribution routing.

Shared agent backends manage Pi hosts; server-core bridges extension contributions and interactions to connected clients.

Application startup imports the global Extension blueprint once. Attaching a Workspace then loads its project Extension snapshot and starts one independent warm runtime that keeps the shared Pi host and compiled module caches available; concrete Session runtimes still create isolated Extension instances and bind their own Session context.

# Invariants

Extension manifests have one Mortise runtime contract and do not accept `targets` or `engines`; Mortise GlobalHost discovery and child processes are pinned to the runtime's explicit Mortise Agent root rather than inherited Pi defaults; global and `<workspace>/.mortise/extensions` are accepted default-trusted sources and load when a backend opens or attaches the Workspace; file changes take effect after an explicit runtime reload or the next backend/Workspace load; capability negotiation precedes use; parent runtime teardown owns its foreground and background child-task leases. Extension authoring documentation follows Pi's runnable, API-oriented guide style, keeps constraints beside the relevant API, includes complete examples and an examples index, and leaves architecture rationale in separate architecture documents.

Tool approval modes, policy decisions, persisted approval state, and approval GUI are owned by the bundled `mortise-permissions` Extension. Core discovery and runtime code may expose only generic configuration snapshots, frontend channels, lifecycle events, and neutral tool execution interception; it must not interpret permission modes or inject permission state into model context.

Unopened Workspaces must not scan or execute project Extensions during application boot. Concurrent Workspace opens and first Session creation join the same preparation Promise; a failed warmup remains a Workspace-scoped degraded state and cannot block Session input or other Workspaces. Workspace and product-integration requests from Extensions route through declared Mortise host capabilities. Commands for the current Session enter that Pi Session's unified command queue, where Pi accepts, queues, or rejects them. Extensions must not bypass the Session state machine or create a second Pi runtime for the same persistent Session.

# Change Impact

GUI contribution shapes belong to `extension-ui`; validation semantics integrate with `ui-validation-developer-kit`.

Subprocess failure can be misreported as session failure; extensions can evolve faster than a packaged host facade. Runtime changes must isolate one failing Extension, defer file changes until the next backend/Workspace load, and keep Electron/WebUI runtime instances independent.

# Validation

Run host recovery, routing, extension bridge, reload, and capability tests.
