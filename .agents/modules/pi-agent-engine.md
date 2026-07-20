---
schema: module-agent/v1
id: pi-agent-engine
name: Pi Agent Engine
summary: Model-independent agent loop, message state, tool execution, and retry behavior.
status: active
keywords: [agent-loop, tool-call, retry, stream, state, steering]
owns:
  - pi/packages/agent/**
related: [pi/packages/ai/**, packages/shared/src/agent/**]
depends_on: [provider-model-runtime]
collaborates_with: []
validation:
  - { id: pi-agent-regression, kind: unit, command: "npm --prefix pi test --workspace @mortise/pi-agent-core", description: "Run Pi agent engine regressions.", triggers: [owned-change], required: true, evidence: "Workspace test exit status and output." }
scope_digest: 5ffc543fb81f2e478604e5f5c46c0a8b6601eb8c
---

## Purpose
Run the reusable stateful agent loop over model streams and tool calls.

## Specialist mandate
Own loop state transitions, prompts, tool execution, steering, follow-ups, retry, and transport-neutral agent events.

## Responsibilities
Maintain `Agent`, `agentLoop`, message conversion, proxy helpers, and their behavioral tests.

## Non-goals
Do not own terminal UI, filesystem tools, provider implementations, or Mortise renderer state.

## Contracts and invariants
State updates and emitted events remain ordered; abort and retry paths preserve a coherent message history.

## Architecture and entry points
The public package entry exports the agent state machine; loop internals consume Pi AI streams and registered tools.

## Collaboration
`pi-coding-runtime` supplies concrete tools and modes; Mortise session code projects engine events into durable sessions.

## Validation
Run the Pi agent package tests and downstream host integration tests after event-shape changes.

## Known risks
Small event-order changes can break RPC clients, retry presentation, or persisted transcript reconstruction.

## Semantic history
- 2026-07-06: Mortise unified its runtime integration around Pi agent semantics.
- 2026-07-18: Pi history and packages became part of the Mortise monorepo.
