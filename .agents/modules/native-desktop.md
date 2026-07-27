---
schema: module-agent/v2
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
  - apps/electron/src/main/workspace-remote-credentials.ts
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
- 2026-07-28: Made Electron own remote-primary creation and explicit Workspace transfer channels, removed arbitrary token-bearing remote invocation from preload, and restored logical Workspace identity in nested remote results and events.
- 2026-07-28: Made Electron renderer Workspace state consume redacted topology and derive remote presentation and Session identity only from the current primary location.
- 2026-07-28: Made preload transport route concurrent Workspace locations by stable location identity, kept layout Workspace-scoped, and isolated remote credentials behind a private main-to-preload resolver boundary.
- 2026-07-25: Made Electron and its workspace-server child consume one validated immutable runtime layout, propagate sealed resource/tool identities explicitly, strip inherited layout overrides, and reject mutable workspace-server entry fallbacks in immutable mode.
- 2026-07-24: Registered renderer draft persistence with the committed window-close flush boundary and serialized shared draft-record writes without blocking composer input.
- 2026-07-24: Consolidated renderer logging into the Mortise bootstrap preload, disabled electron-log's second preload registration, and locked desktop settings tests to reject retired thinking values.
- 2026-07-23: Bound Electron startup and its embedded Pi GlobalHost to the Mortise Agent root, ran extension-only import before backend initialization, and made legacy import failures diagnostic but non-blocking.
- 2026-07-23: Moved canonical AppLayout persistence to a coalescing asynchronous revision writer; layout RPC durability and committed exit now await flush while renderer drag/resize mutations remain memory-only.
- 2026-07-22: Moved the always-on messaging and auto-update logs to independent bounded asynchronous writers with severity-aware backpressure, observable failures, rotation, and committed-exit flushing.
- 2026-07-22: Injected the deterministic first-turn backend only for active isolated UI Test Host runs while preserving the default backend for production, headless, and clone-profile runtimes.
- 2026-07-22: Gated the mobile workspace new-window action on native window lifecycle support so WebUI cannot invoke an Electron-only workspace window path.
- 2026-07-22: Removed the unused Electron Pi runtime path projection so the packaged backend resolver is the sole authority for the compiled Pi executable.
- 2026-07-21: Moved the PDF file-preview renderer behind a Suspense-backed dynamic import so PDF.js is absent from the main renderer startup graph.
- 2026-07-21: Renamed and narrowed the Electron extension response API and IPC channel to the current typed interaction contract.
- 2026-07-21: Removed the retired skills `workingDirectory` argument from the Electron API so workspace identity is the sole skill-root authority.
- 2026-07-21: Removed Electron consumers of retired plan roles and browser tool aliases, and made messaging binding access fields required at the desktop boundary.
- 2026-07-21: Published an immutable versioned Electron platform-capability snapshot through the preload `ElectronAPI` boundary for shared renderer feature gating.
- 2026-07-21: Moved Electron Automation ingress and Messaging publisher, workspace initialization, and fan-out setup into the shared pre-listen runtime transaction with rollback cleanup.
- 2026-07-21: Extended the Electron skill API and channel map for a local folder picker import action while keeping the privileged path out of WebUI.
- 2026-07-20: Updated handler registration coverage for workspace coordination and isolated Electron test files from cross-module mocks.
