---
schema: module-agent/v1
id: browser-runtime
name: Browser Runtime
summary: Embedded browser panes, CDP control, request observation, toolbar, and blank new-tab behavior.
status: active
keywords: [browser, cdp, webview, navigation, request, toolbar]
owns:
  - apps/electron/src/main/browser-capability-adapter.ts
  - apps/electron/src/main/browser-cdp.ts
  - apps/electron/src/main/browser-pane-manager.ts
  - apps/electron/src/main/embedded-browser-host-shortcuts.ts
  - apps/electron/src/main/web-request-observer-hub.ts
  - apps/electron/src/preload/browser-toolbar.ts
  - apps/electron/src/renderer/components/browser/**
  - apps/electron/src/renderer/browser-empty-state.html
  - apps/electron/src/renderer/browser-new-tab-contract.test.ts
  - apps/electron/src/renderer/browser-toolbar.html
  - apps/electron/src/renderer/browser-toolbar.tsx
  - apps/electron/resources/docs/browser-tools.md
  - scripts/browser-tool.ts
related: [apps/electron/src/renderer/components/right-workbench/**, apps/electron/src/main/__tests__/**]
depends_on: [native-desktop, universal-layout]
collaborates_with: [universal-layout]
validation:
  - { id: browser-regression, kind: unit, command: "bun test apps/electron/src/main/__tests__/browser-cdp.test.ts apps/electron/src/renderer/browser-new-tab-contract.test.ts", description: "Run browser CDP and new-tab regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: browser-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise browser behavior through the shared Developer Kit host.", triggers: [ui-change, native-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
scope_digest: baff249e6252f0df5a991c2d54b3bfe5314c356c
---

## Purpose
Provide workspace-owned browsing with native embedding and agent-operable browser control.

## Specialist mandate
Own browser pane lifecycle, navigation, CDP actions, request observation, toolbar preload, and lightweight new tabs.

## Responsibilities
Maintain pane creation, bounds, history, downloads, shortcuts, semantic capabilities, and browser tool integration.

## Non-goals
Do not place task templates or conversation prompt actions in browser content, or own generic native windows.

## Contracts and invariants
Browser tabs belong to exactly one workspace; new tabs are lightweight blank pages; native pane occlusion follows dock geometry.

## Architecture and entry points
Electron main owns native panes and CDP; toolbar preload and renderer browser components expose the user surface.

## Collaboration
Layout supplies pane geometry; validation uses semantic actions and CDP evidence through the developer kit.

## Validation
Run CDP, pane lifecycle, request observer, toolbar, blank-tab, and dock occlusion tests.

## Known risks
Browser views render outside the DOM; stale bounds or readiness can make automation target an invisible pane.

## Semantic history
- 2026-07-20: Replaced built-in Data Sources guidance with reusable CLI, Pi extension, and direct MCP integration guidance.
- 2026-07-14: Added browser CDP control to the UI validation surface.
- 2026-07-18: Integrated native browser panes with universal dock validation.
