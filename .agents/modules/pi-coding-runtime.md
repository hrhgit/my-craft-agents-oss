---
schema: module-agent/v1
id: pi-coding-runtime
name: Pi Coding Runtime
summary: Coding-agent CLI, RPC mode, extensions, tools, terminal UI, and launcher packages.
status: active
keywords: [coding-agent, rpc, extension, cli, tui, tools, compaction]
owns:
  - pi/packages/coding-agent/**
  - pi/packages/tui/**
  - pi/packages/web-launcher/**
related: [apps/electron/resources/pi-extensions/**, packages/shared/src/agent/**]
depends_on: [pi-agent-engine, provider-model-runtime]
collaborates_with: []
validation:
  - { id: pi-coding-regression, kind: unit, command: "npm --prefix pi test --workspace @mortise/pi-coding-agent", description: "Run Pi coding runtime regressions.", triggers: [owned-change], required: true, evidence: "Workspace test exit status and output." }
  - { id: pi-workspace-contract, kind: contract, command: "npm --prefix pi run build:workspace", description: "Build Pi workspaces to verify package contracts.", triggers: [contract-change], required: true, evidence: "Workspace build exit status and diagnostics." }
scope_digest: 9b37b73f760501d313db0e5df7a66b844a46c227
---

## Purpose
Turn the Pi engine into an interactive and RPC-capable coding agent runtime.

## Specialist mandate
Own coding tools, sessions, compaction, extension loading, RPC protocol, interactive mode, and terminal presentation.

## Responsibilities
Maintain the coding-agent package, reusable TUI primitives, browser launcher, examples, docs, and sidecar integration.

## Non-goals
Do not own Mortise desktop chrome, server session persistence, or provider transports.

## Contracts and invariants
RPC events remain compatible with host consumers; extension cleanup and abort paths complete; tool results remain serializable.

## Architecture and entry points
`pi/packages/coding-agent` contains core, modes, tools, sessions, and extension APIs; TUI and web-launcher are sibling packages.

## Collaboration
Coordinate host-facing RPC changes with `extension-runtime`, `session-lifecycle`, and `headless-server-cli`.

## Validation
Build the Pi workspace, run coding-agent tests, and exercise downstream RPC host tests for protocol changes.

## Known risks
RPC compatibility spans embedded binaries and source builds; extension flexibility can bypass assumptions made by interactive mode.

## Semantic history
- 2026-07-21: Made RPC completion helpers wait for logical `agent_settled` after retry and compaction recovery rather than stopping at an intermediate `agent_end`.
- 2026-07-20: Removed Mortise Data Sources host events and session activation plumbing from the Pi RPC contract while preserving generic extension and MCP capabilities.
- 2026-07-14: Added versioned extension UI validation and closed RPC interaction lifecycle gaps.
- 2026-07-18: Integrated the Pi coding runtime into the Mortise monorepo.
- 2026-07-20: Added explicit host system-prompt clear/append semantics and strict capability route identity validation.
