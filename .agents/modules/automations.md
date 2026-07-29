---
schema: project-module/v1
id: automations
name: Automations
summary: Scheduled and event-driven automation definitions, execution, persistence, and UI.
status: active
when_to_read:
  - scheduled or event-driven automation definitions, execution, persistence, or UI changes
tags:
  - automation
  - schedule
  - cron
  - event
  - trigger
  - run
entrypoints:
  - packages/shared/src/automations/index.ts
  - packages/shared/src/scheduler/index.ts
  - packages/server-core/src/handlers/rpc/automations.ts
depends_on:
  - workspace-state
  - session-lifecycle
related: []
validation:
  - >-
    bun test packages/shared/src/automations packages/shared/src/scheduler
    apps/electron/src/renderer/components/automations
---

# Purpose

Run durable scheduled or event-triggered agent work with visible execution history.

# Boundary

Maintain idempotent operations, next-run calculation, enablement, interruption, backend-owned scheduler/run lifecycle, automation session linkage, indexed query projections, and the representative query-performance workload.

Do not own general session execution, messaging transports, or operating-system schedulers.

# Capabilities

Own automation schemas, schedule calculation, persistence, runner lifecycle, RPC, and management UI.

`docs/architecture/automations-protocol.md` defines the normative versioned contract; shared automation storage and scheduler feed server handlers and the renderer automation page.

# Invariants

Automation writes are atomic and operation-identified; repeated delivery cannot create duplicate durable transitions. Concurrent backend-owned schedulers use stable occurrence identity and an atomic claim so one occurrence has at most one normal run. No scheduler survives after every backend closes, and trigger boundaries missed with no active backend are not replayed. Canonical V3 records and their SQLite query projections commit in one transaction, migrations schema-validate every durable record before enabling writes, immutable index identities cannot drift, and bounded cursors are bound to a normalized query fingerprint.

# Change Impact

Automation-created sessions use `session-lifecycle`; outbound notifications coordinate with `messaging`.

Clock changes and process downtime affect schedules; concurrent backends must agree on operation identity and version. The current scheduler implementation and tests still include missed-once recovery and interval coalescing, which must be aligned with the accepted skip-while-no-backend contract. Projection corruption, stale leases, cursor reuse under different filters, and mixed-version writers must fail explicitly instead of looping or overwriting a newer transition.

# Validation

Run scheduler edge cases, persistence concurrency, RPC, and management UI tests.
