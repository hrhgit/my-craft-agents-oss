---
schema: project-module/v1
id: pi-agent-engine
name: Pi Agent Engine
summary: Model-independent agent loop, message state, tool execution, and retry behavior.
status: active
when_to_read:
  - model-independent agent loop, tool execution, retry, stream, steering, or state changes
tags:
  - agent-loop
  - tool-call
  - retry
  - stream
  - state
  - steering
entrypoints:
  - pi/packages/agent/src/index.ts
  - pi/packages/agent/src/agent.ts
  - pi/packages/agent/src/agent-loop.ts
depends_on:
  - provider-model-runtime
related: []
validation:
  - npm --prefix pi test --workspace @mortise/pi-agent-core
---

# Purpose

Run the reusable stateful agent loop over model streams and tool calls.

# Boundary

Maintain `Agent`, `agentLoop`, message conversion, proxy helpers, and their behavioral tests.

Do not own terminal UI, filesystem tools, provider implementations, or Mortise renderer state.

# Capabilities

Own loop state transitions, prompts, tool execution, steering, follow-ups, retry, and transport-neutral agent events.

The public package entry exports the agent state machine; loop internals consume Pi AI streams and registered tools.

# Invariants

State updates and emitted events remain ordered; abort and retry paths preserve a coherent message history.

# Change Impact

`pi-coding-runtime` supplies concrete tools and modes; Mortise session code projects engine events into durable sessions.

Small event-order changes can break RPC clients, retry presentation, or persisted transcript reconstruction.

# Validation

Run the Pi agent package tests and downstream host integration tests after event-shape changes.
