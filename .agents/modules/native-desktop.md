---
schema: project-module/v1
id: native-desktop
name: Native Desktop
summary: Electron lifecycle, windows, menus, IPC, preload, native services, and operating-system integration.
status: active
when_to_read:
  - Electron lifecycle, windows, menus, IPC, preload, dialogs, or operating-system integration
tags:
  - electron
  - ipc
  - window
  - menu
  - preload
  - native
  - dialog
entrypoints:
  - apps/electron/src/main/index.ts
  - apps/electron/src/transport/index.ts
  - apps/electron/src/main/handlers/index.ts
depends_on:
  - shared-contracts
  - headless-server-cli
related:
  - universal-layout
validation:
  - bun test --isolate apps/electron/src/main apps/electron/src/transport
  - bun run typecheck:electron
  - bun run test:ui-validation:electron
---

# Purpose

Provide Mortise's privileged desktop shell and bridge native capabilities to reusable application code.

# Boundary

Maintain channel handlers, window state, shutdown flushing, layout coordination, platform services, secure files, and transport adapters.

Do not require WebUI parity for privileged behavior or own embedded browser/product validation internals.

# Capabilities

Own Electron process lifecycle, windows, IPC, preload exposure, menus, dialogs, updates, native security, and backend spawning.

Main starts at `apps/electron/src/main/index.ts`; preload bridges shared contracts; transport routes calls to workspace backends.

# Invariants

Preload exposes a bounded API; window readiness precedes native actions; background validation yields control after manual window restore.

# Change Impact

Universal layout owns renderer arrangement; browser runtime owns embedded panes; developer kit owns test-only privileged control.

Windows process and file semantics differ from Unix; IPC surface expansion can cross a privilege boundary.

# Validation

Run main, IPC, transport parity, window lifecycle, close flushing, and Electron type checks.
