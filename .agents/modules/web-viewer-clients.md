---
schema: module-agent/v1
id: web-viewer-clients
name: Web and Viewer Clients
summary: Browser adapter, WebUI bootstrap, read-only viewer, and local WebUI launch lifecycle.
status: active
keywords: [webui, viewer, browser-client, adapter, localhost, websocket]
owns:
  - apps/webui/**
  - apps/viewer/**
  - scripts/start-webui.ps1
  - scripts/start-webui-client.ps1
  - scripts/start-webui-instance.ps1
  - scripts/stop-webui.ps1
  - scripts/webui-process-utils.ps1
  - scripts/webui-process-utils.test.ts
  - start-webui.cmd
  - stop-webui.cmd
related: [packages/server-core/src/webui/**, apps/electron/src/renderer/**]
depends_on: [headless-server-cli, shared-contracts, shared-ui-i18n]
collaborates_with: [headless-server-cli]
validation:
  - { id: web-client-regression, kind: unit, command: "bun test apps/webui apps/viewer scripts/webui-process-utils.test.ts", description: "Run WebUI, viewer, and process utility regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: web-client-contract, kind: contract, command: "bun run lint:webui", description: "Verify WebUI client contracts and lint rules.", triggers: [contract-change], required: true, evidence: "Lint exit status and diagnostics." }
scope_digest: 4c193efd5618fa963941b8f2e5ef4967f5efc29f
---

## Purpose
Offer intentionally bounded browser clients over Mortise's shared backend contracts.

## Specialist mandate
Own WebUI bootstrap and browser API adapter, viewer behavior, localhost launcher lifecycle, and browser-specific degradation.

## Responsibilities
Maintain sign-in bootstrap, routed workspace API, connection state, browser shims, client startup, cleanup, and viewer navigation.

## Non-goals
Do not duplicate the main renderer layout or emulate Electron-only native capabilities.

## Contracts and invariants
WebUI is an explicit subset; development auto-login is localhost-only; reusable UI remains outside `apps/webui/src`.

## Architecture and entry points
The browser adapter maps shared client contracts to Web APIs; PowerShell launchers start server and Vite through portmux.

## Collaboration
Backend capabilities come from `headless-server-cli`; shared workflows coordinate with their feature UI owners.

## Validation
Run WebUI type/lint tests, adapter tests, launcher process tests, and browser interaction checks for supported workflows.

## Known risks
Browser security policy differs from Electron; development auto-login must never escape the localhost launcher boundary.

## Semantic history
- 2026-07-21: Kept local skill import explicitly desktop-only in the WebUI adapter.
- 2026-07-20: Removed the WebUI adapter's retired Data Sources OAuth orchestration.
- 2026-07-12: Unified WebUI session projection with the shared runtime.
- 2026-07-18: Stabilized WebUI launch and process cleanup in monorepo validation.
