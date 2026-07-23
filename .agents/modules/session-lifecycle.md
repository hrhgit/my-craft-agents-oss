---
schema: module-agent/v1
id: session-lifecycle
name: Session Lifecycle
summary: Session creation, persistence, projection, execution state, and transcript durability.
status: active
keywords: [session, transcript, draft, persistence, projection, unread]
owns:
  - packages/shared/src/sessions/**
  - packages/shared/src/coordination/**
  - packages/server-core/src/sessions/**
  - packages/server-core/src/projection/**
  - packages/server-core/src/handlers/rpc/sessions.ts
  - packages/server-core/src/handlers/rpc/session*.ts
related: [packages/shared/src/agent/**, apps/electron/src/renderer/pages/ChatPage.tsx]
depends_on: [workspace-state, pi-agent-engine]
collaborates_with: [conversation-ui]
validation:
  - { id: session-lifecycle-regression, kind: unit, command: "bun test packages/shared/src/sessions packages/shared/tests/persistence-queue.test.ts packages/server-core/src/sessions packages/server-core/src/handlers/rpc/sessions apps/electron/src/renderer/lib/__tests__/drafts.test.ts", description: "Run session lifecycle, durability queue, projection, Session RPC, and draft regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
scope_digest: 75f3e7aadd03514531b879fec1bc5ca04c9b1c41
---

## Purpose
Persist and project conversations without leaking draft or hidden-session implementation details into clients.

## Specialist mandate
Own session files, tree JSONL, persistence queues, server session management, projection, and renderer session state.

## Responsibilities
Maintain create/send/interrupt lifecycle, transcript durability, sidecar handling, unread state, and empty-draft publication behavior.

## Non-goals
Do not own agent loop internals, message rendering, or tool implementations.

## Contracts and invariants
A normal UI draft and its provisional first-turn runtime are not a Session until Pi atomically persists the first assistant message; failures before that boundary leave no stored Session. Hidden internal sessions retain their invisible persisted semantics until separately migrated.

## Architecture and entry points
Shared session storage is consumed by server `SessionManager`; ordinary first turns enter through the combined `createAndSendFirstTurn` transaction, while projection and Mortise metadata remain memory-only until Pi's first-assistant JSONL publication gate.

## Collaboration
Coordinate send semantics with `conversation-ui`, runtime events with `pi-agent-engine`, and remote channels with `messaging`.

## Validation
Run session storage, persistence queue, projection, send durability, and draft tests.

## Known risks
Publishing metadata or projection before Pi's assistant-backed JSONL exists can create visible phantom sessions; event ordering can make a running session appear terminated.

## Semantic history
- 2026-07-23: Moved Mortise Session storage to the Mortise-owned Agent root without importing or falling back to independent Pi Session history.
- 2026-07-23: Made canonical Session metadata and Mortise overlay writes fully async; cold metadata updates now merge against the latest lock-scoped Pi JSONL so concurrent active appends survive, ordinary drafts remain fileless until first-assistant publication, and only explicitly hidden Sessions may publish header-only state.
- 2026-07-22: Made compaction completion sidecar persistence an awaited part of turn settlement; Host completion cannot overtake it, persistent failures retain a settlement-only retry, and pending-plan memory stays aligned with durable state.
- 2026-07-22: Made Pi projection settlement choose recoverable displaced-file replacement up front for existing Windows sidecars so a pending rename-over-existing cannot block completion, with durable preparation and deterministic artifact cleanup; also removed duplicate awaited remote browser cleanup.
- 2026-07-22: Made post-accept turn settlement a single-flight retryable durability boundary with a payload-free retry command, typed failure event, and same-Host snapshot projection; metadata/projection failures keep the Session non-ready, cannot re-enter generic chat cleanup, and block completion, queued replay, and later sends until settlement succeeds.
- 2026-07-22: Made canonical metadata/overlay writes reject swallowed failures and signature mismatches, and delayed ordinary Session send acceptance until Pi confirms its canonical user-message write with a typed terminal retry outcome when that boundary is not reached.
- 2026-07-22: Marked injected Session backend construction as provisional or ordinary so one-shot validation backends cannot consume first-turn leases for persisted Session runtimes.
- 2026-07-22: Added a constructor-injected Session backend factory boundary so source-development validation can exercise the real first-turn transaction with a deterministic backend while production remains on the canonical shared factory.
- 2026-07-22: Removed the obsolete `listActiveSessions` alias and Session bundle re-exports of shared file primitives; callers now use `listSessions`, while bundle file types and limits remain owned by shared utilities.
- 2026-07-21: Session interaction responses now accept only validated Extension Interaction V1 payloads; nullable scalar responses and legacy cancellation reasons are rejected at RPC ingress.
- 2026-07-21: Isolated pre-message runtime persistence tests from the real user Pi session store so module validation cannot mutate active data.
- 2026-07-21: Closed a false-success path where rejected canonical headers were treated as durable metadata writes; critical flush now fails with a typed persistence error.
- 2026-07-21: Unified new Pi transcript filenames and headers on `mortiseId`; `sdkSessionId` remains backend resume metadata and no longer creates files the canonical locator cannot rediscover.
- 2026-07-21: Made first-turn metadata/projection durability failures typed, retryable request outcomes with an explicit terminal unpublished attempt, routed provisional shutdown through abandonment, and covered real directory/rename faults.
- 2026-07-21: Rejected retired Session metadata at the tree JSONL boundary, removed header-scan filename fallback and provider-lock migration, and removed the old metadata-picker alias.
- 2026-07-21: Removed legacy plan-role, id-only Session bundle, and thinking-level restore compatibility; file-backed plan submissions now expose canonical assistant messages carrying `PlanArtifactV1` while retaining `planPath` as the active execution target.
- 2026-07-21: Routed Session `showInFinder` through an advertised requesting-client capability or the injected platform, with a typed unavailable error instead of false success.
- 2026-07-21: Removed persisted and runtime `session.workingDirectory` authority; Session storage and SessionManager now derive paths only from the workspace root and reject the removed field with a typed contract error.
- 2026-07-21: Made turn settlement await metadata and projection durability before emitting UI completion or starting queued replay, with explicit ordering regression coverage.
- 2026-07-21: Added real `createAndSendFirstTurn` fault injection for metadata and projection durability, and made abandonment discard failed projection retries so persistent disk errors cannot leave provisional artifacts.
