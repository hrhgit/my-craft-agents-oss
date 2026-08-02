---
schema: project-module/v1
id: project-modules
name: Project Modules
summary: >-
  Progressive-disclosure capability documents and the stateless catalog used to locate code, reuse existing behavior,
  and check related changes.
status: active
when_to_read:
  - project module documents, catalog generation, module metadata, or module knowledge lint changes
tags:
  - module
  - catalog
  - context
  - discovery
entrypoints:
  - .agents/skills/project-modules/SKILL.md
  - scripts/project-modules/cli.ts
  - scripts/project-modules/catalog.ts
depends_on: []
related:
  - build-release-observability
frontend_impact:
  affects: false
  areas: []
validation:
  - bun test scripts/project-modules/__tests__
  - bun run module:lint
---

# Purpose

Give the current model a compact project capability map, then disclose only the module documents needed for the task.

# Boundary

Maintain the module Markdown schema, catalog renderer, lightweight knowledge lint, and usage Skill. Do not score user intent, assign agents, create worktrees, govern implementation phases, own repository files, or replace Git and CI.

# Capabilities

`module:catalog` reads current YAML frontmatter and emits a compact Markdown index, including whether each module affects frontend behavior and which areas it reaches. `module:lint` checks module-document integrity without writing repository state.

# Invariants

Module Markdown is the only authority, and every module explicitly declares consistent frontend-impact metadata. Catalog and lint operations are read-only and stateless. The current model performs semantic module selection; multiple matching modules never imply task decomposition.

# Change Impact

Catalog schema changes affect every module document and the `project-modules` Skill. Build and CI consume only the lightweight lint command.

# Validation

Run the focused catalog tests and lint the live module set.
