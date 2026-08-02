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

# Invariants

Extension manifests have one Mortise runtime contract and do not accept `targets` or `engines`; Mortise GlobalHost discovery and child processes are pinned to the runtime's explicit Mortise Agent root rather than inherited Pi defaults; global and `<workspace>/.mortise/extensions` are accepted default-trusted sources and load when a backend opens or attaches the Workspace; file changes take effect only on the next backend/Workspace load; capability negotiation precedes use; parent runtime teardown owns its foreground and background child-task leases. Extension authoring documentation follows Pi's runnable, API-oriented guide style, keeps constraints beside the relevant API, includes complete examples and an examples index, and leaves architecture rationale in separate architecture documents.

# Change Impact

GUI contribution shapes belong to `extension-ui`; validation semantics integrate with `ui-validation-developer-kit`.

Subprocess failure can be misreported as session failure; extensions can evolve faster than a packaged host facade. Runtime changes must isolate one failing Extension, defer file changes until the next backend/Workspace load, and keep Electron/WebUI runtime instances independent.

# Validation

Run host recovery, routing, extension bridge, reload, and capability tests.
