---
schema: project-module/v1
id: sources-skills-mcp
name: Skills and MCP Utilities
summary: Skill storage, skill management surfaces, resource RPC, and generic in-process MCP server utilities.
status: active
when_to_read:
  - Skill storage or import, resource RPC, or generic MCP utility changes
tags:
  - skill
  - mcp
  - resource
entrypoints:
  - packages/shared/src/mcp/index.ts
  - packages/shared/src/skills/index.ts
  - apps/electron/resources/docs/skills.md
depends_on:
  - shared-contracts
related: []
frontend_impact:
  affects: true
  areas:
    - skill and source management, resource selection, and MCP result surfaces
validation:
  - bun test packages/shared/src/skills packages/server-core/src/handlers/rpc/skills.test.ts
---

# Purpose

Connect agents to reusable skills and expose generic in-process MCP helpers.

# Boundary

Maintain skill resolution metadata, resource RPC integration, and generic in-process MCP server construction.

Do not own session-specific tool execution, external connection management, generic credentials, or Pi extension lifecycle.

# Capabilities

Own skill discovery/storage and its user-facing management surface, plus generic in-process MCP server construction.

Shared skill storage provides durable configuration; the renderer skill page exposes management details; the MCP helper creates in-process servers for generic host tools.

# Invariants

Skill metadata does not grant tools or permissions. Resource import and export must not mutate unrelated user state.

# Change Impact

Session tool surfaces consume skill metadata and generic MCP helpers.

Skill discovery may vary by workspace and runtime target; preserve deterministic resolution and metadata boundaries.

# Validation

Run skill storage and resolution tests after owned changes.
