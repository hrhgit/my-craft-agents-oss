---
schema: module-agent/v2
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
  - { id: universal-layout-regression, kind: unit, command: "bun test apps/electron/src/renderer/components/app-shell apps/electron/src/renderer/lib/__tests__/draft-write-queue.test.ts apps/electron/src/renderer/lib/__tests__/window-close-flush.test.ts apps/electron/src/shared/__tests__/app-layout.test.ts", description: "Run universal layout, app-shell, and renderer persistence regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: universal-layout-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise docking and layout behavior through the shared Developer Kit host.", triggers: [ui-change, layout-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
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
- 2026-07-28: Routed the Workspace shell, transfers, and persisted dock content through the client-safe primary location identity; renderer code no longer derives authority from paths, credentials, or legacy remote-server fields, and primary-location changes retarget both the authoritative location ID and compatibility server metadata.
- 2026-07-27: Added parent-scoped core child tasks to the existing right-side task status popover with running state, bounded history inspection, and message, resume, and interrupt actions without creating ordinary Session tabs.
- 2026-07-24: Routed the shared draft record through one ordered asynchronous writer and registered window-close flushing so older debounced writes cannot overwrite a later published-draft clear.
- 2026-07-23: Made current-Session chat search host-yielding and cursor-paged: initial/divergent indexes publish atomically after asynchronous chunking, deterministic identity/content snapshots protect the sealed prefix while streaming reindexes only mutable tails, navigation preserves active match identity across lazy pages, and exact semantic-target highlighting stays hard-bounded with the mounted neighborhood.
- 2026-07-23: Unified dock layout durability behind one scope-bound asynchronous coordinator that keeps model-change hot paths serialization-free, coalesces the latest model at idle, and flushes at interaction-end, workspace-transition, window-close, and scope-dispose boundaries.
- 2026-07-22: Added a dedicated settlement recovery status that disables composer submission without presenting Stop semantics and invokes only the payload-free Session settlement command.
- 2026-07-22: Made existing-Session composer submission completion-bearing and attempt-scoped so pre-accept persistence failures retain exact retry payloads, restore only untouched cleared drafts, expose typed terminal state, and defer follow-up sent markers until acceptance.
- 2026-07-22: Remount FlexLayout when the coordinated model identity is replaced so same-profile restart cannot retain an old layout host that pushes restored workspace content below the viewport.
- 2026-07-22: Added an explicit non-Session semantic scope for draft composers while preserving Session-scoped composer identities and avoiding workspace-derived identity guesses.
- 2026-07-22: Applied the immutable platform capability contract to shared renderer layout actions: WebUI keeps browser-tab fallbacks while native BrowserPane tools, workspace auxiliary windows, dock detach controls, and persisted native browser content are omitted or safely degraded.
- 2026-07-21: Replaced mixed RemoteUI shell state with versioned interaction-only routing and mounted canonical composer-below contributions directly in the conversation layout.
- 2026-07-21: Removed renderer-side scrubbing of retired Session organization fields; canonical transfer validation now rejects them at ingress.
- 2026-07-21: Removed the global collapsed-session-group migration and deprecated skill icon wrapper APIs; current scoped persistence and the canonical entity icon API are now the only renderer paths.
- 2026-07-21: Made final-message tracking assistant-only and required canonical messaging access fields in renderer state.
- 2026-07-21: Removed per-session working-directory state and mutation controls from the shell and composer; workspace root is the sole resolution path.
- 2026-07-21: Replaced full-history chat search expansion and global highlight scanning with a shared segment index and a bounded active-match neighborhood; per-panel highlights now have isolated identities and deterministic cleanup.
- 2026-07-21: Coalesced window geometry persistence so drag and resize model changes update memory immediately but serialize and write only at idle or explicit workspace/window flush boundaries.
- 2026-07-21: Updated projection-owned processing and completion consumers to keep retrying Pi attempts active until `agent_settled`, while retaining legacy `agent_end` snapshot compatibility.
- 2026-07-21: Added local skill discovery with default-all individual selection and explicit confirmed batch import into the bound workspace.
- 2026-07-20: Removed the retired Sources navigator, detail type, and navigation-registry state from the current layout contract.
- 2026-07-20: Made initial draft-route focus one-shot and kept programmatic first-message navigation on the draft until send succeeds.
