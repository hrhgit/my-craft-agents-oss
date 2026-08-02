---
schema: project-module/v1
id: session-tooling
name: Session Tooling
summary: Session-scoped tools, MCP bridge, child-session delegation, and tool result helpers.
status: active
when_to_read:
  - Session tools, MCP bridge, child tasks, artifacts, prompts, or tool result changes
tags:
  - session-tool
  - mcp
  - child-session
  - delegation
  - artifact
  - tool-result
entrypoints:
  - packages/session-mcp-server/src/index.ts
  - packages/session-tools-core/src/index.ts
  - packages/session-tools-core/src/handlers/index.ts
depends_on:
  - session-lifecycle
  - pi-coding-runtime
related:
  - extension-runtime
  - conversation-ui
frontend_impact:
  affects: true
  areas:
    - conversation tool cards, plans, artifacts, and child-task or delegation controls
validation:
  - bun test packages/session-tools-core packages/session-mcp-server
  - bun run typecheck:all
---

# Purpose

Expose bounded tools and session delegation capabilities through shared host-neutral packages.

# Boundary

Maintain schemas, permissions, artifacts, task and plan tools, delegation lifecycle, and session MCP transport.

Do not own the Pi built-in coding tools, external MCP connection management, or transcript UI.

# Capabilities

Own tool definitions, handlers, templates, MCP session service, child-session controls, and tool-result normalization.

`session-tools-core` supplies definitions and handlers; `session-mcp-server` exposes them to compatible runtimes.

# Invariants

Tool inputs validate before side effects; child-task spawn, list, inspect, message, resume, interrupt, and parent-deletion preparation remain scoped to their parent and workspace; each child type owns only the settlement its deletion contract requires; resume adds no synthetic history, and attachments must be existing absolute paths readable through the child's allowed tools. Results are serializable.

# Change Impact

Coordinate child-session persistence with `session-lifecycle` and generic MCP helpers with `sources-skills-mcp`.

Tool schema drift can break model calls without TypeScript errors; delegated sessions can outlive parent expectations.

# Validation

Run package tests and downstream agent host tests for schema or lifecycle changes.
