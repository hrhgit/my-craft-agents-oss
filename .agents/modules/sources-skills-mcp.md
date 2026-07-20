---
schema: module-agent/v1
id: sources-skills-mcp
name: Skills and MCP Utilities
summary: Skill storage, skill management surfaces, resource RPC, and generic in-process MCP server utilities.
status: active
keywords: [skill, mcp, resource]
owns:
  - packages/shared/src/skills/**
  - packages/shared/src/mcp/**
  # Retain ownership while retired Data Sources files remain visible as deletions.
  - packages/shared/src/sources/**
  - packages/shared/tests/mcp-pool.test.ts
  - apps/electron/src/renderer/pages/SkillInfoPage.tsx
  - apps/electron/src/renderer/pages/SourceInfoPage.tsx
  - apps/electron/resources/docs/skills.md
  - apps/electron/resources/docs/sources.md
  - packages/server-core/src/handlers/rpc/resources.ts
  - packages/server-core/src/handlers/rpc/skills.ts
  - packages/server-core/src/handlers/rpc/skills.test.ts
  - packages/server-core/src/handlers/rpc/sources.ts
related: [packages/session-tools-core/**, apps/electron/src/renderer/components/settings/**]
depends_on: [shared-contracts]
collaborates_with: []
validation:
  - { id: skills-mcp-regression, kind: unit, command: "bun test packages/shared/src/skills packages/server-core/src/handlers/rpc/skills.test.ts", description: "Run skill storage, discovery, and import regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
scope_digest: 0ab3efaa9d7f0d48881a9e0c1d2d2a1d9b27eaf3
---

## Purpose
Connect agents to reusable skills and expose generic in-process MCP helpers.

## Specialist mandate
Own skill discovery/storage and its user-facing management surface, plus generic in-process MCP server construction.

## Responsibilities
Maintain skill resolution metadata, resource RPC integration, and generic in-process MCP server construction.

## Non-goals
Do not own session-specific tool execution, external connection management, generic credentials, or Pi extension lifecycle.

## Contracts and invariants
Skill metadata does not grant tools or permissions. Resource import and export must not mutate unrelated user state.

## Architecture and entry points
Shared skill storage provides durable configuration; the renderer skill page exposes management details; the MCP helper creates in-process servers for generic host tools.

## Collaboration
Session tool surfaces consume skill metadata and generic MCP helpers.

## Validation
Run skill storage and resolution tests after owned changes.

## Known risks
Skill discovery may vary by workspace and runtime target; preserve deterministic resolution and metadata boundaries.

## Semantic history
- 2026-07-21: Added desktop-only bounded discovery of valid skills folders under the user home directory and explicit selective import with staged copy, workspace exclusion, home-path enforcement, and skip-on-conflict semantics.
- 2026-05-21: Added remote extension and session settings synchronization foundations.
- 2026-07-18: Moved Pi skill resolution into the unified Mortise runtime.
- 2026-07-20: Removed the built-in Data Sources implementation, management surfaces, and source-only MCP connection runtime while preserving user data on disk.
