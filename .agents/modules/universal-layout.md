---
schema: project-module/v1
id: universal-layout
name: Universal Layout
summary: Workspace-scoped dock, sidebar navigation, tab grouping, detach, focus, and layout persistence.
status: active
when_to_read:
  - workspace dock, sidebar, tabs, groups, detach, focus, navigation, or layout persistence changes
tags:
  - dock
  - layout
  - tab
  - sidebar
  - split
  - detach
  - workspace
entrypoints:
  - apps/electron/src/renderer/components/app-shell/UnifiedDockWorkspace.tsx
  - apps/electron/src/renderer/components/app-shell/unified-dock-model.ts
  - apps/electron/src/shared/app-layout.ts
depends_on:
  - workspace-state
  - shared-contracts
related:
  - browser-runtime
  - file-workbench
  - native-desktop
validation:
  - >-
    bun test apps/electron/src/renderer/components/app-shell
    apps/electron/src/renderer/lib/__tests__/draft-write-queue.test.ts
    apps/electron/src/renderer/lib/__tests__/window-close-flush.test.ts
    apps/electron/src/shared/__tests__/app-layout.test.ts
  - bun run test:ui-validation:electron
---

# Purpose

Give each backend type one saved, Workspace-scoped dock arrangement for the content it projects.

# Boundary

Maintain group operations, tab chrome, geometry, route mapping, canvas controls, persistence, and responsive navigation.

Do not create feature-specific right panels or mix content from different workspaces in one rendered layout.

# Capabilities

Own dock groups and tabs, workspace-centric sidebar, navigation history, split/detach behavior, focus mode, and backend-type layout serialization.

Renderer app-shell models use shared layout and route types; `UnifiedDockWorkspace` hosts the workspace canvas.

# Invariants

Switching workspace replaces the active backend's entire layout; full tools use ordinary `workspace.content` tabs; there is no shell-level second sidebar. Different backend types do not live-synchronize tabs, groups, order, or active content. Detached Electron windows can edit their layout but cannot detach again or form nested windows.

# Change Impact

Content owners provide tab semantics; `native-desktop` implements auxiliary windows and native-view coordination.

Current Electron persistence still uses one global `app-layout.v1.json`, and WebUI lacks its own persisted baseline; the accepted backend-type file boundary remains an implementation gap. Persisted layouts can reference removed content; native views can occlude drag targets and floating surfaces.

# Validation

Run unified dock, navigation, workspace sidebar, geometry, detach, and layout serialization tests.
