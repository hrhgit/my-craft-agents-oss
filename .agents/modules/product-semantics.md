---
schema: module-agent/v2
id: product-semantics
name: Product Semantics
summary: Maintain Mortise's cross-module product concepts, authority boundaries, and explicitly unresolved product questions.
status: active
keywords: [product-semantics, terminology, lifecycle, authority, invariant, product-model]
owns:
  - docs/product-semantics.md
related:
  - docs/architecture/red-line.md
  - docs/architecture/automations-protocol.md
  - docs/architecture/pi-extension-gui.md
  - apps/electron/resources/docs/pi-extensions.md
  - .agents/modules/session-lifecycle.md
  - .agents/modules/universal-layout.md
  - .agents/modules/extension-ui.md
  - .agents/modules/automations.md
depends_on: []
collaborates_with: []
validation:
  - id: semantics-diff-check
    kind: unit
    command: git diff --check -- docs/product-semantics.md
    description: Verify the tracked product semantics reference has no whitespace or patch-format defects.
    triggers: [owned-change]
    required: true
    evidence: Git diff-check exit status and output.
---

## Purpose

Keep the product meaning used across Mortise modules discoverable without turning it into a mandatory task process.

## Specialist mandate

Consolidate only product semantics supported by accepted decisions and current normative contracts, and keep unresolved product choices visibly non-normative.

## Responsibilities

Maintain the product concept model, terminology, lifecycle meanings, authority boundaries, and links to detailed domain contracts.

## Non-goals

Do not duplicate API schemas, implementation details, module ownership records, task checklists, future ideas, or unaccepted product proposals.

## Contracts and invariants

Accepted product meaning is distinct from historical implementation. Detailed domain protocols may refine this reference but must not silently contradict it. Open questions never authorize implementation.

## Architecture and entry points

The primary reference is `docs/product-semantics.md`; detailed contracts remain in their owning architecture documents and module records.

## Collaboration

Consult every affected domain owner when a semantic change crosses module boundaries. The primary agent resolves the consolidated wording and any conflict between domain interpretations.

## Validation

Run the focused diff check, then strict module validation. Domain behavior and contract tests remain with their owning modules.

## Known risks

The reference can drift if implementation details are copied into it, if open questions are mistaken for decisions, or if a narrow domain document changes meaning without updating the cross-module interpretation.

## Semantic history

- 2026-07-26: Established the initial cross-module Mortise product semantics reference while keeping its use advisory rather than procedural.
- 2026-07-26: Clarified that the primary Agent belongs to the Session, while temporary subagents are a Mortise core capability and reusable templates are a higher-level preset layer.
- 2026-07-27: Confirmed user-created and Extension-provided subagent templates, plus visible status and inspectable output for running background subagents while leaving exact UI placement open.
- 2026-07-27: Corrected child retention semantics: subagents keep resumable task history under the parent Session, and the primary Agent can inspect state and send messages without creating a child Session.
- 2026-07-27: Defined child resume as a control action that adds no synthetic continue message; only real new instructions enter child history before resumption.
