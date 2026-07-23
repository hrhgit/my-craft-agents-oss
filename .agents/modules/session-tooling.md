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
scope_digest: 960239564d19ee77b325fbe009d8557da8250e7a
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
- 2026-07-24: Made `spawn_session.thinkingLevel` expose exactly the six current Mortise values in both Zod and exported MCP JSON Schema, rejecting retired values without a shared-package dependency.
- 2026-07-23: Moved the Session MCP server's Session and global-skill roots to the Mortise-owned Agent root and removed independent Pi path compatibility from the generated production bundle.
- 2026-07-21: Removed the host-neutral config validator's retired JSON fallback; SQLite config and aggregate validation now require an injected authoritative validator and fail explicitly when unavailable.
- 2026-07-21: Removed Pi coding/TUI runtime imports from the Session MCP entrypoint; it now consumes only host-neutral tool types, canonical skill roots, and narrow path/validation contracts.
- 2026-07-21: Removed `mcp__session__*` and `session__*` tool-name aliases and prefix-producing helper options; session tools now accept and emit canonical names only.
- 2026-07-21: Made `session-tools-core` host-neutral by owning its result contract and resolving skills exclusively from injected ordered skill roots, removing its dependency on `@mortise/shared`.
- 2026-07-20: Removed Data Sources validation, authentication, credential prompts, API wrappers, and source-test tools while retaining session tools and the generic MCP transport.
- 2026-07-07: Added RPC host hooks and child-session support.
- 2026-07-10: Hardened plan workflow and Pi runtime integration.
