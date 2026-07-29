---
schema: project-module/v1
id: browser-runtime
name: Browser Runtime
summary: Embedded browser panes, CDP control, request observation, toolbar, and blank new-tab behavior.
status: active
when_to_read:
  - embedded browser panes, navigation, CDP control, requests, or browser toolbar changes
tags:
  - browser
  - cdp
  - webview
  - navigation
  - request
  - toolbar
entrypoints:
  - scripts/browser-tool.ts
  - apps/electron/resources/docs/browser-tools.md
  - apps/electron/src/main/browser-capability-adapter.ts
depends_on:
  - native-desktop
  - universal-layout
related:
  - universal-layout
validation:
  - >-
    bun test apps/electron/src/main/__tests__/browser-cdp.test.ts
    apps/electron/src/renderer/browser-new-tab-contract.test.ts
  - bun run test:ui-validation:electron
---

# Purpose

Provide workspace-owned browsing with native embedding and agent-operable browser control.

# Boundary

Maintain pane creation, bounds, history, downloads, shortcuts, semantic capabilities, and browser tool integration.

Do not place task templates or conversation prompt actions in browser content, or own generic native windows.

# Capabilities

Own browser pane lifecycle, navigation, CDP actions, request observation, toolbar preload, and lightweight new tabs.

Electron main owns native panes and CDP; toolbar preload and renderer browser components expose the user surface.

# Invariants

Browser tabs belong to exactly one workspace; new tabs are lightweight blank pages; native pane occlusion follows dock geometry.

# Change Impact

Layout supplies pane geometry; validation uses semantic actions and CDP evidence through the developer kit.

Browser views render outside the DOM; stale bounds or readiness can make automation target an invisible pane.

# Validation

Run CDP, pane lifecycle, request observer, toolbar, blank-tab, and dock occlusion tests.
