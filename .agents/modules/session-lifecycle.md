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
  - { id: session-lifecycle-regression, kind: unit, command: "bun test packages/shared/src/sessions packages/server-core/src/sessions apps/electron/src/renderer/lib/__tests__/drafts.test.ts", description: "Run session lifecycle and draft regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
scope_digest: edcfd9fea7cbcbcd93362a39c265ce1de97ae911
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
- 2026-07-21: Routed queued mid-stream delivery through Pi-native follow-up when available, retaining the Host FIFO only as an unsupported-backend fallback, and settled abort-terminal completion as interrupted.
- 2026-07-20: Reserved the legacy empty-session RPC for hidden and branch internals; ordinary conversations must enter the assistant-backed first-turn publication transaction.
- 2026-07-20: Added canonical automation prompt delivery through assistant-backed Session publication, exact same-workspace follow-up/steer targets, and isolated non-Session completion.
- 2026-07-20: Replaced persisted deferred sessions with an internal provisional first-turn lifecycle published only after Pi's first assistant message.
- 2026-07-12: Unified Pi session projection across Electron and WebUI.
- 2026-07-18: Hardened persistence queues for concurrent writes.
