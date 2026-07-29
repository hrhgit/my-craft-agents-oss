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
validation:
  - >-
    bun test packages/shared/src/sessions packages/shared/tests/persistence-queue.test.ts
    packages/server-core/src/sessions packages/server-core/src/handlers/rpc/sessions
    apps/electron/src/renderer/lib/__tests__/drafts.test.ts
---

# Purpose

Persist and project conversations without leaking draft or hidden-session implementation details into clients.

# Boundary

Maintain create/send/interrupt lifecycle, transcript durability, sidecar handling, unread state, and empty-draft publication behavior.

Do not own agent loop internals, message rendering, or tool implementations.

# Capabilities

Own session files, tree JSONL, persistence queues, server session management, projection, and renderer session state.

Shared session storage is consumed by server `SessionManager`; ordinary first turns enter through the combined `createAndSendFirstTurn` transaction and publish when the first UserMessage is durably appended. Projection and Mortise metadata cannot publish a Session before that canonical message boundary.

# Invariants

A normal UI draft is not a Session until the first UserMessage is durably appended; failures before that boundary leave no stored Session. Every complete AgentMessage becomes shared only after its own append, flush, and durable acknowledgement. Core subagent tasks persist below the owning parent Session sidecar and never enter the ordinary Session list; their inbox and completion records are capabilities of that concrete task type, not a platform guarantee for every child task. Hidden internal sessions retain their invisible persisted semantics until separately migrated.

# Change Impact

Coordinate send semantics with `conversation-ui`, runtime events with `pi-agent-engine`, and remote channels with `messaging`.

Publishing metadata or projection before the first durable UserMessage can create visible phantom sessions; event ordering can make a running session appear terminated.

# Validation

Run session storage, persistence queue, projection, send durability, and draft tests.
