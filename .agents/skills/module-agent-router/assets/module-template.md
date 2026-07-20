---
schema: module-agent/v1
id: replace-with-module-id
name: Replace With Module Name
summary: One sentence describing the owned business capability.
status: draft
keywords: [replace-me]
owns: [replace/me/**]
related: []
depends_on: []
collaborates_with: []
validation:
  - id: regression
    kind: unit
    command: bun test replace/me
    description: Run the module's focused behavior regressions.
    triggers: [owned-change]
    required: true
    evidence: Test exit status and focused failure output.
scope_digest: ""
---

## Purpose

Describe why this capability exists.

## Specialist mandate

Describe the specialist's task-scoped authority.

## Responsibilities

Describe the behavior and validation this module owns.

## Non-goals

Describe adjacent behavior owned elsewhere.

## Contracts and invariants

Describe stable provider and consumer expectations.

## Architecture and entry points

List the primary code and documentation entry points.

## Collaboration

Describe when declared peers must be consulted.

## Validation

Keep focused regressions with the behavior owner, contract tests with the provider, cross-module acceptance with the primary agent, and physical UI validation with the business module through shared Developer Kit infrastructure.

## Known risks

Describe concrete failure modes.

## Semantic history

- YYYY-MM-DD: Established the module contract.
