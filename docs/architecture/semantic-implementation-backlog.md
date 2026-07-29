# Mortise Semantic Implementation Backlog

Status: Passive audit record. Not active implementation scope.

Last reviewed: 2026-07-29

## Purpose And Use

This document parks implementation gaps found while comparing
[`docs/product-semantics.md`](../product-semantics.md), accepted architecture contracts, module records, and the current codebase.

- Do not dispatch, implement, or use an item as decision guidance merely because it appears here.
- An item becomes active only when the user explicitly invokes it or approves work whose acceptance boundary includes it.
- Revalidate current code and product semantics before implementation. Evidence and status can become stale.
- Product decisions belong in the product semantics reference. Exact contracts belong to the owning architecture document. This file is neither authority.
- This inventory does not read from or expand [`docs/future-todo.md`](../future-todo.md).

## Priority Meaning

- `P0`: an unresolved authority, trust, or concurrency boundary can permit contradictory outcomes.
- `P1`: accepted behavior is missing, incomplete, or backed by the wrong authority.
- `P2`: bounded follow-up, contract cleanup, or an explicitly deferred product direction.

## Deferred Product Directions

These directions were already present before the completed authority review. They remain passive and are not prerequisites for the accepted behavior below.

| ID | Priority | Direction | Decision required before implementation | Current evidence |
|---|---|---|---|---|
| `SEM-005` | P2 | Replace-class Extension surfaces have no accepted long-term boundary | Decide which replace surfaces remain supported, their fallback, focus, accessibility, and conflict semantics before expanding them | [`pi-extension-gui.md`](./pi-extension-gui.md) records deterministic V1 replacement but the product reference leaves the long-term boundary unresolved |
| `SEM-006` | P2 | Extension modes are an accepted future direction without a domain model | Define mode identity, selection, transition, Extension capability selection, and interaction with global enablement | Product semantics deliberately describes modes in future tense; current runtime only has global Extension configuration |

## Accepted Behavior Not Yet Fully Implemented

| ID | Priority | Gap | Required outcome | Current evidence |
|---|---|---|---|---|
| `IMP-001` | P1 | Layout persistence does not yet follow the accepted backend-type boundary | Store one layout baseline per Workspace and backend type; initialize each backend from its type's latest complete snapshot; keep running copies independent; use last-complete-write-wins with exclusive locking, temporary files, and atomic replacement | Electron main still uses one global `app-layout.v1.json`; WebUI has no independent persisted layout baseline |
| `IMP-002` | P1 | Remote attached locations are represented but are not complete Agent execution locations | Route file read/write/search and commands to the selected remote endpoint with typed availability, permission, and version checks | Workspace V2 topology and transfer exist, but local file services reject remote locations and Session runtimes still default to a local primary root |
| `IMP-003` | P1 | Location changes cannot reliably interrupt only actual users of that location | Track active location/resource leases for Sessions, child tasks, Automation runs, tools, and subprocesses; detach/replace only interrupts affected leases | Session state records one `activeWorkspaceLocationId`; Automation topology interruption is Workspace-wide |
| `IMP-004` | P1 | Accepted project-local Extension loading and trust semantics are not aligned across runtime, Settings, and authoring documentation | Treat global and `<workspace>/.mortise/extensions` as default-trusted formal sources; load them when a backend opens or attaches the Workspace; defer file changes until the next reload; isolate one failing Extension without retry loops | Authoring docs still direct users to Settings-triggered reload, while discovery and backend lifecycle are split across Pi and Mortise host paths |
| `IMP-005` | P1 | Extension projection and optional state persistence still use runtime/Session-shaped ownership | Make runtime, contribution, commands, and memory backend-owned; provide optional file state keyed by Workspace, backend type, and Extension identity; preserve unavailable layout placeholders; closing a tab must not unload the Extension | Contribution identity and renderer storage still include `sessionId/runtimeId`; there is no backend-type state file contract or complete unavailable-placeholder restoration path |
| `IMP-006` | P1 | Automation still supports the cancelled `isolated-agent` target | Remove it atomically from schema, runtime, capability advertisement, UI types, tests, and documentation-derived surfaces | Active references remain in `v3-types.ts`, `v3-schemas.ts`, Automation RPC, SessionManager, and renderer tests |
| `IMP-007` | P1 | Automation portability is below the accepted import/export semantics | Preserve complete definitions and dependency declarations without secrets; reconnect known dependencies; import incomplete items disabled; return isolated per-item results for batch imports | Current resource bundle support lacks a dependency manifest/incomplete state and can fail a whole batch together |
| `IMP-008` | P1 | Automation authorization and protocol documentation drift from current semantics and code | Resolve whether trusted Extension/Agent mutations prompt per operation; align policy, advertised scopes, generated descriptions, protocol versions, and operations from one source | Product semantics says no extra confirmation; Electron policy prompts reads and mutations. The accepted protocol records `3/1` capability versions while code advertises `4/2` and adds `list-changes` |
| `IMP-009` | P1 | Extension GUI V1 host responsibilities remain incomplete | Implement group-aware allocation, distinct menu/collapse overflow, viewport-responsive capacity, cross-contribution focus restoration, and stable primitive semantic identity | See `Current V1 gaps that remain host responsibilities` in [`pi-extension-gui.md`](./pi-extension-gui.md#layout-and-conflict-resolution) |
| `IMP-010` | P1 | Capability routing does not uniformly enforce the accepted execution owner | Route filesystem and command operations to the selected location backend; keep native interactions on the requesting client; return explicit unsupported/no-interactive-client/target-unavailable results without silent handoff or location fallback | Capability checks are still spread across adapters and platform booleans; remote file execution remains incomplete |
| `IMP-011` | P2 | The Pi/Mortise red-line ratchet is not fully closed | Replace raw config watching with a typed Pi subscription and replace Mortise-only Session overlays with a typed Pi UI metadata sidecar/projection contract | See [`red-line.md`](./red-line.md#ratchet-removal-route) |
| `IMP-012` | P1 | Automation runtime ownership and offline trigger behavior conflict with the accepted backend model | Let each backend own its scheduler and runs while sharing canonical definitions and atomic occurrence claims; stop execution when the owning backend closes; skip all triggers missed while no backend is active | Current scheduler schemas, implementation, and tests still include `run-once` recovery and interval coalescing paths that must be reconciled with the updated accepted protocol |
| `IMP-013` | P1 | Parent Session deletion is not verified as one cascade across every registered child-task type | Freeze new parent writes, stop each child through its own task contract, complete only required settlement, then delete parent and child records; keep a visible retryable deleting state on failure | Current core child tasks have teardown and durable delivery, but the cross-type delete boundary is not covered as one product-level acceptance path |
| `IMP-014` | P1 | Workspace removal actions are not fully separated in product-facing APIs and UI | Keep remove-from-app registration-only; make location detach remove only the target marker and preserve ordinary files; do not expose a Workspace-level delete-data command | Topology removal preserves roots and markers today; an explicit marker-only detach flow is not established across supported clients |

## Explicitly Not Pending

The 2026-07-29 audit found these foundations implemented. Do not recreate them as backlog items without new contrary evidence:

- Session publication at the first durable UserMessage and per-AgentMessage transcript durability.
- Core child-task mechanics such as spawn, list, inspect, message, resume, interrupt, and task-specific durable inbox/delivery where that task contract chooses them.
- Global default connection, model, thinking selection, and semantic model references.
- Workspace V2 topology records, markers, local/remote endpoint types, topology mutation, explicit transfer journal, and Session/Automation topology interruption hooks.
- Automations V3 canonical store, scheduler, run ledger, transactional projections, and capability fencing.
- Electron universal-dock detach and auxiliary native-window mechanics themselves. The pending work is backend-type persistence and the no-nested-detach product boundary, not basic native detach.
- The global, in-memory Session control service and turn-scoped control handle in the current worktree; re-add only if focused validation finds a concrete missing acceptance boundary.

## Activation Checklist

When the user explicitly activates an item:

1. Re-read current product semantics and the owning module documents.
2. Verify the cited implementation gap still exists.
3. Check whether a listed deferred product direction actually applies before freezing interfaces.
4. Define a bounded acceptance surface and affected clients.
5. Move execution planning to the owning task or architecture contract; do not turn this inventory into a second task system.
