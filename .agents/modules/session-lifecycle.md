---
schema: project-module/v1
id: session-lifecycle
name: Session Lifecycle
summary: Session creation, persistence, projection, execution state, and transcript durability.
status: active
when_to_read:
  - Session creation, persistence, projection, drafts, execution state, unread, or transcript durability
tags:
  - session
  - transcript
  - draft
  - persistence
  - projection
  - unread
entrypoints:
  - packages/server-core/src/projection/index.ts
  - packages/server-core/src/sessions/index.ts
  - packages/server-core/src/session-control/index.ts
  - packages/shared/src/coordination/index.ts
depends_on:
  - workspace-state
  - pi-agent-engine
related:
  - conversation-ui
frontend_impact:
  affects: true
  areas:
    - workspace session list, drafts, transcript visibility, and unread, running, or deleting states
validation:
  - >-
    bun test packages/shared/src/sessions packages/shared/tests/persistence-queue.test.ts
    packages/server-core/src/sessions packages/server-core/src/handlers/rpc/sessions
    apps/electron/src/renderer/lib/__tests__/drafts.test.ts
---

# Purpose

Persist and project conversations without leaking draft or hidden-session implementation details into clients.

# Boundary

Maintain create/send/interrupt/delete lifecycle, transcript durability, typed Pi UI metadata sidecars, unread state, and empty-draft publication behavior.

Do not own agent loop internals, message rendering, or tool implementations.

# Capabilities

Own session files, tree JSONL, persistence queues, server session management, projection, and renderer session state.

Shared session storage is consumed by server `SessionManager`; ordinary first turns enter through the combined `createAndSendFirstTurn` transaction. Mortise first accepts a recoverable outbox record and returns a caller-private pending Session, then publishes when the first canonical UserMessage is durably appended by Pi. Projection and Mortise metadata cannot publish a Session before that canonical message boundary.

# Invariants

A normal UI draft has a caller-private pending Session after Mortise accepts its outbox record; it enters the shared Session list only when the first UserMessage is durably appended by Pi. Failures before Mortise acceptance leave no stored Session, while accepted failures retain a retryable pending record. Every complete AgentMessage becomes shared only after its own append, flush, and durable acknowledgement. Core subagent tasks persist below the owning parent Session sidecar and never enter the ordinary Session list; their inbox and completion records are capabilities of that concrete task type, not a platform guarantee for every child task. Parent deletion freezes new writes and child creation, invokes each registered child-task deletion contract, and retains a visible retryable `deleting` state when required settlement fails. Hidden internal sessions retain their invisible persisted semantics until separately migrated.

# Change Impact

Coordinate send semantics with `conversation-ui`, runtime events with `pi-agent-engine`, and remote channels with `messaging`.

Publishing metadata or projection before the first durable UserMessage can create visible phantom sessions; event ordering can make a running session appear terminated.

# Validation

Run session storage, persistence queue, projection, send durability, and draft tests.
