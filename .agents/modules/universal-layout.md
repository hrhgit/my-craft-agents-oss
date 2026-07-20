---
schema: module-agent/v1
id: universal-layout
name: Universal Layout
summary: Workspace-scoped dock, sidebar navigation, tab grouping, detach, focus, and layout persistence.
status: active
keywords: [dock, layout, tab, sidebar, split, detach, workspace]
owns:
  - apps/electron/src/renderer/components/app-shell/**
  - apps/electron/src/renderer/actions/**
  - apps/electron/src/renderer/atoms/**
  - apps/electron/src/renderer/hooks/**
  - apps/electron/src/renderer/lib/**
  - apps/electron/src/renderer/context/**
  - apps/electron/src/renderer/pages/ShortcutsPage.tsx
  - apps/electron/src/renderer/pages/__tests__/**
  - apps/electron/src/renderer/pages/index.ts
  - apps/electron/src/renderer/contexts/**
related: [apps/electron/src/renderer/components/right-workbench/**, apps/electron/src/main/window-manager.ts]
depends_on: [workspace-state, shared-contracts]
collaborates_with: [browser-runtime, file-workbench, native-desktop]
validation:
  - { id: universal-layout-regression, kind: unit, command: "bun test apps/electron/src/renderer/components/app-shell apps/electron/src/shared/__tests__/app-layout.test.ts", description: "Run universal layout and app-shell regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: universal-layout-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise docking and layout behavior through the shared Developer Kit host.", triggers: [ui-change, layout-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
scope_digest: dcaa41c79b2880c417ed5d217943992f340c00dc
---

## Purpose
Give every workspace one saved, dockable arrangement for all workspace-owned content.

## Specialist mandate
Own dock groups and tabs, workspace-centric sidebar, navigation history, split/detach behavior, focus mode, and layout serialization.

## Responsibilities
Maintain group operations, tab chrome, geometry, route mapping, canvas controls, persistence, and responsive navigation.

## Non-goals
Do not create feature-specific right panels or mix content from different workspaces in one rendered layout.

## Contracts and invariants
Switching workspace replaces the entire layout; full tools use ordinary `workspace.content` tabs; there is no shell-level second sidebar.

## Architecture and entry points
Renderer app-shell models use shared layout and route types; `UnifiedDockWorkspace` hosts the workspace canvas.

## Collaboration
Content owners provide tab semantics; `native-desktop` implements auxiliary windows and native-view coordination.

## Validation
Run unified dock, navigation, workspace sidebar, geometry, detach, and layout serialization tests.

## Known risks
Persisted layouts can reference removed content; native views can occlude drag targets and floating surfaces.

## Semantic history
- 2026-07-20: Removed the retired Sources navigator, detail type, and navigation-registry state from the current layout contract.
- 2026-07-20: Made initial draft-route focus one-shot and kept programmatic first-message navigation on the draft until send succeeds.
- 2026-07-18: Advanced workspace-scoped universal dock and layout validation.
