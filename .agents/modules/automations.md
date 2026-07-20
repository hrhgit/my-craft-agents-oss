---
schema: module-agent/v1
id: automations
name: Automations
summary: Scheduled and event-driven automation definitions, execution, persistence, and UI.
status: active
keywords: [automation, schedule, cron, event, trigger, run]
owns:
  - packages/shared/src/automations/**
  - packages/shared/src/scheduler/**
  - packages/server-core/src/handlers/rpc/automations.ts
  - apps/electron/src/renderer/components/automations/**
  - apps/electron/resources/docs/automations.md
  - docs/architecture/automations-protocol.md
  - docs/architecture/automations-protocol-candidates.json
related: [packages/shared/src/sessions/**, packages/server-core/src/runtime/**]
depends_on: [workspace-state, session-lifecycle]
collaborates_with: []
validation:
  - { id: regression, kind: unit, command: "bun test packages/shared/src/automations packages/shared/src/scheduler apps/electron/src/renderer/components/automations", description: "Run automation and scheduler regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
scope_digest: 2f30d275855d798823a208ce1839484b95e01377
---

## Purpose
Run durable scheduled or event-triggered agent work with visible execution history.

## Specialist mandate
Own automation schemas, schedule calculation, persistence, runner lifecycle, RPC, and management UI.

## Responsibilities
Maintain idempotent operations, next-run calculation, enablement, interruption, recovery, and automation session linkage.

## Non-goals
Do not own general session execution, messaging transports, or operating-system schedulers.

## Contracts and invariants
Automation writes are atomic and operation-identified; repeated delivery cannot create duplicate durable transitions.

## Architecture and entry points
`docs/architecture/automations-protocol.md` defines the normative versioned contract; shared automation storage and scheduler feed server handlers and the renderer automation page.

## Collaboration
Automation-created sessions use `session-lifecycle`; outbound notifications coordinate with `messaging`.

## Validation
Run scheduler edge cases, persistence concurrency, RPC, and management UI tests.

## Known risks
Clock changes and process downtime affect schedules; concurrent backends must agree on operation identity and version.

## Semantic history
- 2026-07-20: Removed the obsolete active Data Sources field from the automation runtime options; prompt mentions now describe skills rather than built-in Sources.
- 2026-07-20: Fenced Automations writes by definitions/ingress/runs/history capability versions and made skipped once misfires durable without disabling unrelated triggers.
- 2026-07-20: Implemented the V3 core contract with strict schemas, atomic V2 migration, MultiWriterStore-backed definitions/events/runs, CloudEvents idempotency, precise cron/once/interval recovery, and callback-owned action execution.
- 2026-07-20: Accepted the unified Automations v3 architecture, CloudEvents ingress, deterministic run protocol, and prompt-automation migration boundary.
- 2026-07-18: Hardened automation persistence for concurrent backend writes.
