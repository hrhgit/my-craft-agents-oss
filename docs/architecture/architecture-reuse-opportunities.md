# Mortise Architecture Reuse Opportunities

Status: Passive audit record. Not approved refactor scope.

Last reviewed: 2026-07-29

## Purpose And Use

This document parks bounded architecture reuse opportunities found during the product-semantics audit. It records where an existing Mortise pattern can serve another module without merging distinct product concepts or execution engines.

- Do not implement a candidate merely because it is listed here.
- Revalidate both the source pattern and intended consumers when the user explicitly invokes a candidate.
- Prefer extraction during an approved feature or reliability change that already crosses the relevant boundary.
- Shared infrastructure may own mechanics; domain modules retain policy, lifecycle meaning, persistence schema, and acceptance.
- This inventory does not read from or expand [`docs/future-todo.md`](../future-todo.md).

## Candidate Summary

| ID | Candidate | Likely consumers | Benefit | Risk |
|---|---|---|---|---|
| `REUSE-001` | Typed capability descriptor and routing registry | Extension host, desktop client, WebUI, backend host, remote endpoint | High | Medium |
| `REUSE-002` | Revisioned owned projection | Extension GUI, Extension validation, other runtime-owned projections | High | Low-medium |
| `REUSE-003` | Explicit Session host lifecycle aggregate | Session publication, turn control, settlement, recovery | High | High |
| `REUSE-004` | Idempotent multi-writer command primitive | Workspace topology, Automations, other durable mutable authorities | Medium-high | Medium |
| `REUSE-005` | Backend-type scoped atomic snapshot store | Universal dock, optional Extension state, backend-scoped UI state | High | Low-medium |
| `REUSE-006` | Async Browser capability service | Local Electron browser, remote browser, unavailable/headless adapters | Medium-high | Medium |
| `REUSE-007` | Cross-module activity summary projection | Child tasks, Automation runs, global background tasks | Medium | Low |
| `REUSE-008` | Workspace content-provider registry | Files, Browser, Extension `workspace.content`, future built-in tools | Medium | Low-medium |
| `REUSE-009` | Local backend execution coordinator | Electron backend, WebUI backends, Session execution ownership | High | Medium |
| `REUSE-010` | Backend-owned runtime container | Agent Loops, Extension runtimes, Automation schedulers and runs | High | Medium |

## REUSE-001: Typed Capability Descriptor And Routing Registry

### Borrow

The Extension capability path already has typed request/result/progress messages, declarations, authorization, cancellation, request identity, and runtime cleanup in `packages/shared/src/protocol/capabilities.ts` and `packages/server-core/src/capabilities/router.ts`.

### Apply

Introduce a descriptor such as `CapabilityDescriptor<Operations>` that owns:

- capability name and protocol version;
- operation input/output codecs;
- availability and degradation states;
- target owner and execution endpoint;
- invocation, cancellation, progress, and normalized errors;
- derivation of handshake advertisement and platform capability snapshots.

Use it to replace parallel string lists, ad hoc client channels, and static platform booleans where those surfaces describe the same capability.

### Keep Separate

Extension identity and authorization remain stricter than trusted desktop-client routing. Requesting client, backend host, and target location can share routing mechanics without sharing one permission policy.

## REUSE-002: Revisioned Owned Projection

### Borrow

Extension GUI contribution already uses trusted route identity plus monotonic revision and `snapshot/upsert/remove/reset`. Renderer stores reject stale deltas and clear runtime-owned state on teardown.

### Apply

Extract `RevisionedOwnedProjection<TPayload>` for:

- trusted owner route injection;
- monotonic revision checks;
- snapshot recovery and delta application;
- runtime teardown/reset;
- immutable observable snapshots.

The development-only Extension validation contribution path is the first candidate because it currently repeats much of this lifecycle.

### Keep Separate

GUI payload validation, placement and sandbox budgets remain Extension UI policy. Validation permissions, scenario rules, and command ownership remain Developer Kit policy.

## REUSE-003: Explicit Session Host Lifecycle Aggregate

### Borrow

Automations V3 uses explicit legal transitions, immutable identity guards, durable history, and transactional projection updates.

### Apply

Use the transition-table approach, not the Automation state model itself, to define a Session host aggregate such as:

```text
provisional -> active -> runtime-settled -> host-settling -> ready
                                              |             |
                                              +-> failed    +-> interrupted
```

The aggregate should encode publication, accepted message, pending settlement, Stop, follow-up recompetition readiness, local coordinator ownership loss, and terminal late-event rejection. Transitions return domain state and an explicit side-effect plan; SessionManager continues to orchestrate runtime and storage I/O.

### Keep Separate

Attempt remains a Pi runtime execution segment. Session lifecycle does not become an Automation run, and Automation does not gain authority over Session transcript or settlement.

## REUSE-004: Idempotent Multi-Writer Command Primitive

### Borrow

`MultiWriterStore` provides SQLite transactions, CAS, operation payload hashes, capability fencing, and durable replay receipts. Workspace topology has a mature command-plus-receipt boundary.

### Apply

Extract narrowly scoped helpers such as:

- `applyIdempotentCommand()`;
- `mutateRecordWithRetry()`;
- stable outer operation identity plus version-specific attempt identity;
- pure transform and schema validation before commit;
- durable original-result replay;
- consistent conflict, read-only, and retry-exhausted results.

Automation mutation loops and other durable domain commands with true optimistic-concurrency semantics are initial consumers.

### Keep Separate

Do not create a generic Repository abstraction. Automation history/index transactions and Workspace marker/transfer behavior remain domain-owned. Session turn control is in-memory coordination plus an operating-system lock, not another durable command store.

## REUSE-005: Backend-Type Scoped Atomic Snapshot Store

### Borrow

The Electron layout coordinator already coalesces rapid updates and persists complete snapshots asynchronously. Workspace storage provides atomic file replacement and path-scoped write boundaries.

### Apply

Extract a small snapshot store for state that is shared only as a startup baseline among backends of the same type:

- one layout snapshot per Workspace and backend type;
- optional Extension state files keyed by Workspace, backend type, and Extension identity;
- other backend-scoped UI state that needs restart restoration but no live cross-backend synchronization.

The store should serialize a complete validated snapshot, write through a temporary file, atomically replace the target, and use a path-scoped exclusive lock. Concurrent writers use last-complete-write-wins; it does not add revision conflicts or merge semantics that the product did not request. A running backend keeps its in-memory copy and does not subscribe to another backend's layout changes.

### Keep Separate

Layout and Extension data keep separate schemas and directories. The store owns only complete-snapshot mechanics; it does not decide what an Extension persists, how it migrates business state, or when a task recovers. Session transcripts, Automation records, and Workspace topology retain their stronger domain-specific authorities.

## REUSE-006: Async Browser Capability Service

### Borrow

The Electron browser capability adapter is already naturally asynchronous and operation-oriented.

### Apply

Define an async `BrowserService` for operations shared by local and remote execution. Implement local, remote, and unavailable adapters through the typed capability registry. Keep BrowserView geometry, focus, and native-window coordination in an Electron-only controller.

This removes fire-and-forget synchronous adapter methods, swallowed remote errors, and placeholder `remote-pending:*` values.

### Keep Separate

Workspace ownership and endpoint routing remain host concerns. BrowserView/native window behavior remains desktop-only and must not be faked in WebUI.

## REUSE-007: Cross-Module Activity Summary Projection

### Borrow

Child tasks, Automation runs, and Pi global background tasks each already expose identity, status, timestamps, and a target that can be opened.

### Apply

Project them into a small read model:

```ts
interface ActivitySummaryV1 {
  kind: 'child-task' | 'automation-run' | 'background-task'
  owner: { workspaceId?: string; sessionId?: string; activityId: string }
  status: string
  startedAt?: number
  updatedAt?: number
  attention?: 'none' | 'running' | 'waiting' | 'failed'
  openTarget?: unknown
}
```

Use it for the lightweight activity popover, CLI observation, and diagnostics.

### Keep Separate

This is a read projection only. It does not promise that every task preserves results, supports recovery, or exposes the same actions. Child tasks retain their concrete task contracts, Automations retain their own definitions and records, and global background tasks keep their own lifecycle.

## REUSE-008: Workspace Content-Provider Registry

### Borrow

The universal dock already frames Conversation, Files, Browser, and Extension `workspace.content` as content tabs. `RightWorkbench.tsx` currently combines discovery and rendering for several of these tools.

### Apply

Define a host-owned content provider contract for:

- stable content kind and route codec;
- title/icon projection;
- singleton or multiple-instance identity;
- platform availability;
- protection state such as dirty, running, or awaiting input;
- renderer factory and optional native adapter;
- backend-type layout restoration and unavailable-placeholder hooks.

Use one registry to populate the content picker and resolve restored tabs. Extension contributions adapt into this contract after validation; they do not register arbitrary React code.

### Keep Separate

Built-in content can use trusted renderer components. Extension Level 1 remains host-rendered from primitives, and Level 2 remains sandboxed. A common frame must not erase these trust boundaries.

## REUSE-009: Local Backend Execution Coordinator

### Borrow

The server bootstrap and transport layers already provide authenticated local process connections, backend identity, disconnect observation, and reusable runtime composition. Session activity tracking already projects active runtime information, but it is not an atomic ownership authority.

### Apply

Introduce one on-demand coordinator instance per machine. All Electron and WebUI backends connect to it through local inter-process communication. It keeps only live in-memory state and atomically maps a Session to:

- the owning backend connection;
- the backend-managed Agent Loop process;
- a small starting, running, or stopping state.

Use the shared module for control authorization, relationship indexing, release, status queries, and coordinator shutdown after the last backend disconnects. The owning backend performs model calls, tool execution, and Session writes while holding a turn-scoped control handle backed by an operating-system exclusive lock. Backend-to-backend discovery remains observational and cannot grant control. Enforce a single coordinator instance with an operating-system boundary; coordinator connection loss preserves existing backend control. A replacement coordinator rejects new grants while it rebuilds its index from every discoverable live backend and held lock, then callers submit fresh authorization requests after recovery completes.

### Keep Separate

The coordinator is global to the local machine, not partitioned by Workspace, and keys control only by `sessionId`. It is not an Agent supervisor, transcript store, Automation occurrence ledger, durable Workspace coordination ledger, or cross-machine authority. Session message durability remains owned by Session lifecycle; tool side-effect receipts remain durable domain records; Automation keeps its own persisted occurrence identity and claim rules. Supporting multiple machines would require a separate shared authority and is not implied by this local coordinator.

## REUSE-010: Backend-Owned Runtime Container

### Borrow

Server bootstrap and backend composition already provide a process identity, connected-client observation, service startup, bounded shutdown, and shared diagnostics. Pi host management already owns child-process termination and runtime cleanup.

### Apply

Define a narrow backend runtime container that can register and stop backend-owned execution units:

- Session Agent Loops;
- Extension runtimes and contribution publishers;
- Automation schedulers and active runs;
- backend-local client projections and optional state flushers.

The container provides startup ordering, cancellation broadcast, bounded drain, forced child-process termination, state flush, and diagnostic enumeration. Closing a tab never closes the container; closing the backend does. Electron and WebUI instantiate the same lifecycle mechanics while keeping separate runtime instances and backend-type state.

### Keep Separate

This is lifecycle composition, not a generic task engine. Agent Loop semantics, Extension loading and business state, Automation occurrence claims and retries, and each concrete child task's result/recovery contract remain domain-owned. The container must not invent universal result delivery, orphan recovery, or cleanup policy.

## Recommended Adoption Order

1. Extract `REUSE-002` when the next Extension contribution lifecycle change is approved.
2. Design `REUSE-001` before adding another platform or endpoint capability family.
3. Extract `REUSE-005` when backend-type layout persistence or optional Extension file state becomes active scope.
4. Specify `REUSE-003` and its migration slices before changing Session lifecycle code.
5. Extract `REUSE-004` incrementally from one proven caller at a time.
6. Adopt `REUSE-006` with the next cross-platform Browser change.
7. Keep `REUSE-007` projection-only and `REUSE-008` frame-only.
8. Treat `REUSE-009` as the reusable boundary already being adopted by the Session control implementation; extend it only after focused acceptance finds a gap.
9. Extract `REUSE-010` only when a change already crosses two or more backend-owned runtime lifecycles.

The order is guidance for an explicitly activated architecture task, not an implementation schedule.
