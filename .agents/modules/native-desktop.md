---
schema: module-agent/v1
id: native-desktop
name: Native Desktop
summary: Electron lifecycle, windows, menus, IPC, preload, native services, and operating-system integration.
status: active
keywords: [electron, ipc, window, menu, preload, native, dialog]
owns:
  - apps/electron/src/__tests__/**
  - apps/electron/src/main/__tests__/**
  - apps/electron/src/main/handlers/**
  - apps/electron/src/main/shims/**
  - apps/electron/src/main/application-exit.ts
  - apps/electron/src/main/auto-update.ts
  - apps/electron/src/main/chunked-rpc.ts
  - apps/electron/src/main/deep-link.ts
  - apps/electron/src/main/electron-resource-paths.ts
  - apps/electron/src/main/index.ts
  - apps/electron/src/main/initial-window-target.ts
  - apps/electron/src/main/keyboard-close-shortcut.ts
  - apps/electron/src/main/layout-coordinator.ts
  - apps/electron/src/main/logger.ts
  - apps/electron/src/main/menu.ts
  - apps/electron/src/main/network-proxy-utils.ts
  - apps/electron/src/main/network-proxy.ts
  - apps/electron/src/main/notifications.ts
  - apps/electron/src/main/onboarding.ts
  - apps/electron/src/main/platform.ts
  - apps/electron/src/main/power-manager.ts
  - apps/electron/src/main/secure-files.ts
  - apps/electron/src/main/shell-env.ts
  - apps/electron/src/main/thumbnail-protocol.ts
  - apps/electron/src/main/window-bounds.ts
  - apps/electron/src/main/window-manager.ts
  - apps/electron/src/main/window-renderer-query.ts
  - apps/electron/src/main/window-state.ts
  - apps/electron/src/main/workspace-server-spawner.ts
  - apps/electron/src/preload/bootstrap.ts
  - apps/electron/src/runtime/**
  - apps/electron/src/shared/**
  - apps/electron/src/transport/**
  - apps/electron/src/renderer/App.tsx
  - apps/electron/src/renderer/index.html
  - apps/electron/src/renderer/main.tsx
  - apps/electron/src/renderer/vite-env.d.ts
  - apps/electron/src/renderer/components/*.tsx
  - apps/electron/src/renderer/components/app-menu/**
  - apps/electron/src/renderer/components/info/**
related: [apps/electron/src/main/ui-validation/**, apps/electron/src/main/browser-pane-manager.ts]
depends_on: [shared-contracts, headless-server-cli]
collaborates_with: [universal-layout]
validation:
  - { id: native-desktop-regression, kind: unit, command: "bun test --isolate apps/electron/src/main apps/electron/src/transport", description: "Run Electron main-process and transport regressions with per-file module isolation.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: electron-native-contract, kind: contract, command: "bun run typecheck:electron", description: "Verify Electron native contracts compile.", triggers: [contract-change], required: true, evidence: "TypeScript compiler exit status and diagnostics." }
  - { id: native-desktop-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise native desktop behavior through the shared Developer Kit host.", triggers: [native-change, release], required: false, evidence: "Developer Kit run output and retained native UI evidence." }
scope_digest: 1de1726e6ed8b97e81eb9bdd349d6f9580504869
---

## Purpose
Provide Mortise's privileged desktop shell and bridge native capabilities to reusable application code.

## Specialist mandate
Own Electron process lifecycle, windows, IPC, preload exposure, menus, dialogs, updates, native security, and backend spawning.

## Responsibilities
Maintain channel handlers, window state, shutdown flushing, layout coordination, platform services, secure files, and transport adapters.

## Non-goals
Do not require WebUI parity for privileged behavior or own embedded browser/product validation internals.

## Contracts and invariants
Preload exposes a bounded API; window readiness precedes native actions; background validation yields control after manual window restore.

## Architecture and entry points
Main starts at `apps/electron/src/main/index.ts`; preload bridges shared contracts; transport routes calls to workspace backends.

## Collaboration
Universal layout owns renderer arrangement; browser runtime owns embedded panes; developer kit owns test-only privileged control.

## Validation
Run main, IPC, transport parity, window lifecycle, close flushing, and Electron type checks.

## Known risks
Windows process and file semantics differ from Unix; IPC surface expansion can cross a privilege boundary.

## Semantic history
- 2026-07-18: Stabilized native window readiness and source-development validation.
- 2026-07-19: Hardened Mortise UI process identity and concurrent run safety.
- 2026-07-20: Updated handler registration coverage for workspace coordination and isolated Electron test files from cross-module mocks.
- 2026-07-20: Preserved protected conversation tabs when opening workspace drafts, rejected malformed draft routes safely, and made current-workspace selection enter the requested draft view.
- 2026-07-20: Removed the legacy Data Sources OAuth orchestration from the privileged Electron preload surface.
