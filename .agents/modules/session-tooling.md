---
schema: module-agent/v1
id: session-tooling
name: Session Tooling
summary: Session-scoped tools, MCP bridge, child-session delegation, and tool result helpers.
status: active
keywords: [session-tool, mcp, child-session, delegation, artifact, tool-result]
owns:
  - packages/session-tools-core/**
  - packages/session-mcp-server/**
  - packages/shared/src/tools/**
  - packages/shared/src/mentions/**
  - packages/shared/src/prompts/**
related: [pi/packages/coding-agent/src/core/tools/**, packages/server-core/src/sessions/**]
depends_on: [session-lifecycle, pi-coding-runtime]
collaborates_with: [extension-runtime, conversation-ui]
validation:
  - { id: session-tooling-regression, kind: unit, command: "bun test packages/session-tools-core packages/session-mcp-server", description: "Run session tool and MCP server regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: session-tool-contract, kind: contract, command: "bun run typecheck:all", description: "Verify session tool contracts compile across consumers.", triggers: [contract-change], required: true, evidence: "TypeScript compiler exit status and diagnostics." }
scope_digest: 18cd4930583517fa6440321af9fc2b01806c39a0
---

## Purpose
Expose bounded tools and session delegation capabilities through shared host-neutral packages.

## Specialist mandate
Own tool definitions, handlers, templates, MCP session service, child-session controls, and tool-result normalization.

## Responsibilities
Maintain schemas, permissions, artifacts, task and plan tools, delegation lifecycle, and session MCP transport.

## Non-goals
Do not own the Pi built-in coding tools, external MCP connection management, or transcript UI.

## Contracts and invariants
Tool inputs validate before side effects; child-session actions remain scoped to their parent and workspace; results are serializable.

## Architecture and entry points
`session-tools-core` supplies definitions and handlers; `session-mcp-server` exposes them to compatible runtimes.

## Collaboration
Coordinate child-session persistence with `session-lifecycle` and generic MCP helpers with `sources-skills-mcp`.

## Validation
Run package tests and downstream agent host tests for schema or lifecycle changes.

## Known risks
Tool schema drift can break model calls without TypeScript errors; delegated sessions can outlive parent expectations.

## Semantic history
- 2026-07-20: Removed Data Sources validation, authentication, credential prompts, API wrappers, and source-test tools while retaining session tools and the generic MCP transport.
- 2026-07-07: Added RPC host hooks and child-session support.
- 2026-07-10: Hardened plan workflow and Pi runtime integration.
