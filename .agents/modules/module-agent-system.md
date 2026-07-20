---
schema: module-agent/v1
id: module-agent-system
name: Module Agent System
summary: Document protocol, routing CLI, and Codex adapter for capability-owned module agents.
status: active
keywords: [module-agent, routing, ownership, scope-digest, specialist]
owns:
  - .agents/module-system.yaml
  - .agents/modules/**
  - .agents/skills/module-agent-router/**
  - scripts/module-agents/**
related: [package.json]
depends_on: [build-release-observability]
collaborates_with: [build-release-observability]
validation:
  - { id: protocol-regression, kind: unit, command: "bun test scripts/module-agents", description: "Run module protocol, routing, digest, and CLI regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: repository-contract, kind: contract, command: "bun run scripts/module-agents/cli.ts validate --strict", description: "Verify repository ownership, relationships, schema, and digest contracts.", triggers: [module-document-change, ownership-change], required: true, evidence: "Structured strict validation result." }
scope_digest: 4670b2f1ad303bd6fa47dafadd3023e348336530
---

## Purpose
Keep capability knowledge discoverable without loading the whole repository into the primary agent context.

## Specialist mandate
Own the portable Markdown schema, deterministic routing, ownership validation, impact analysis, and digest refresh behavior.

## Responsibilities
Maintain the module registry, document parser, route scoring, strict diagnostics, and adapter guidance.

## Non-goals
Do not implement an agent runtime, grant permissions, or store long-lived specialist conversations.

## Contracts and invariants
Module Markdown is authoritative. Primary ownership is unique, related scopes may overlap, and digests include tracked and working-tree changes. Each module owns reproducible behavior regressions; contract providers own contract tests; the primary agent coordinates cross-module integration and acceptance. Physical UI validation stays with the business module and uses shared Developer Kit infrastructure.

## Architecture and entry points
Configuration starts at `.agents/module-system.yaml`; documents are scanned from `.agents/modules`; the CLI lives under `scripts/module-agents`.

## Collaboration
The primary agent dispatches specialists. Specialists may consult named collaborators but may not recursively create peers.

## Validation
Run module-agent unit tests, then strict repository validation and impact checks against a known Git base.

## Known risks
Broad globs can conceal new capabilities; stale digests can make accurate prose look current when it is not.

## Semantic history
- 2026-07-20: Made structured, level-based validation plans and module-owned test execution part of the portable protocol.
- 2026-07-20: Established the `module-agent/v1` document protocol and strict ownership model.
