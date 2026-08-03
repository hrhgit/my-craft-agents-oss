---
schema: project-module/v1
id: product-semantics
name: Product Semantics
summary: Maintain Mortise's cross-module product concepts, authority boundaries, and explicitly unresolved product questions.
status: active
when_to_read:
  - cross-module product meaning, terminology, authority, lifecycle, or unresolved product decisions
tags:
  - product-semantics
  - terminology
  - lifecycle
  - authority
  - invariant
  - product-model
entrypoints:
  - docs/product-semantics.md
depends_on: []
related: []
frontend_impact:
  affects: true
  areas:
    - workspace, session, automation, extension, browser, and layout behavior governed by semantic decisions
  interaction_docs:
    - .agents/modules/product-semantics/frontend-interactions.md
validation:
  - git diff --check -- docs/product-semantics.md
---

# Purpose

Keep the product meaning used across Mortise modules discoverable without turning it into a mandatory task process.

# Boundary

Maintain the product concept model, terminology, lifecycle meanings, authority boundaries, and links to detailed domain contracts.

Do not duplicate API schemas, implementation details, module ownership records, task checklists, future ideas, or unaccepted product proposals.

# Capabilities

Consolidate only product semantics supported by accepted decisions and current normative contracts, and keep unresolved product choices visibly non-normative.

The primary reference is `docs/product-semantics.md`; detailed contracts remain in their owning architecture documents and module records.

# Invariants

Accepted product meaning is distinct from historical implementation. Detailed domain protocols may refine this reference but must not silently contradict it. Open questions never authorize implementation.

# Change Impact

Consult every affected domain owner when a semantic change crosses module boundaries. The primary agent resolves the consolidated wording and any conflict between domain interpretations.

The reference can drift if implementation details are copied into it, if open questions are mistaken for decisions, or if a narrow domain document changes meaning without updating the cross-module interpretation.

# Validation

Run the focused diff check, then strict module validation. Domain behavior and contract tests remain with their owning modules.
