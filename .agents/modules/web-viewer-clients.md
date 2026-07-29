---
schema: project-module/v1
id: web-viewer-clients
name: Web and Viewer Clients
summary: Browser adapter, WebUI bootstrap, read-only viewer, and local WebUI launch lifecycle.
status: active
when_to_read:
  - WebUI, browser adapters, read-only viewer, localhost authentication, or launch lifecycle changes
tags:
  - webui
  - viewer
  - browser-client
  - adapter
  - localhost
  - websocket
entrypoints:
  - apps/webui/src/main.tsx
  - apps/webui/src/adapter/web-api.ts
  - apps/viewer/src/main.tsx
depends_on:
  - headless-server-cli
  - shared-contracts
  - shared-ui-i18n
related:
  - headless-server-cli
validation:
  - bun test apps/webui apps/viewer scripts/webui-process-utils.test.ts
  - bun run lint:webui
---

# Purpose

Offer intentionally bounded browser clients over Mortise's shared backend contracts.

# Boundary

Maintain sign-in bootstrap, routed workspace API, connection state, browser shims, client startup, cleanup, and viewer navigation.

Do not duplicate the main renderer layout or emulate Electron-only native capabilities.

# Capabilities

Own WebUI bootstrap and browser API adapter, viewer behavior, localhost launcher lifecycle, and browser-specific degradation.

The browser adapter maps shared client contracts to Web APIs; PowerShell launchers start server and Vite through portmux.

# Invariants

WebUI is an explicit subset; development auto-login is localhost-only; reusable UI remains outside `apps/webui/src`.

# Change Impact

Backend capabilities come from `headless-server-cli`; shared workflows coordinate with their feature UI owners.

Browser security policy differs from Electron; development auto-login must never escape the localhost launcher boundary.

# Validation

Run WebUI type/lint tests, adapter tests, launcher process tests, and browser interaction checks for supported workflows.
