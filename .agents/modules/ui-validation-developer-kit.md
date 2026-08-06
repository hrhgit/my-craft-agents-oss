---
schema: project-module/v1
id: ui-validation-developer-kit
name: UI Validation Developer Kit
summary: AI-facing mortise-ui CLI, isolated Dev Host, semantic/native actions, scenarios, and evidence.
status: active
when_to_read:
  - mortise-ui, Developer Kit, semantic or native actions, fixtures, scenarios, or evidence changes
tags:
  - mortise-ui
  - developer-kit
  - validation
  - semantic
  - native
  - scenario
  - evidence
entrypoints:
  - scripts/mortise-ui/cli.ts
  - packages/shared/src/ui-validation/index.ts
  - apps/electron/src/main/ui-validation/test-host.ts
depends_on:
  - native-desktop
  - shared-contracts
related:
  - build-release-observability
  - extension-ui
frontend_impact:
  affects: true
  areas:
    - Developer Host playground, semantic snapshots, scenarios, and validation error surfaces outside production UI
  interaction_docs:
    - .agents/modules/ui-validation-developer-kit/frontend-interactions.md
validation:
  - bun run test:mortise-ui
  - bun run test:ui-validation:fast
  - bun run test:ui-validation:runtime-contract
---

# Purpose

Give development agents a reliable, discoverable control plane for real Mortise UI validation.

# Boundary

Maintain concise AI guidance, run identity, process safety, readiness, UIA/CDP drivers, fixtures, extension semantics, and evidence retention.

Do not ship privileged test control in the normal app or replace representative physical renderer and native checks with fast tests.

# Capabilities

Own isolated run/build lifecycle, semantic and native snapshots, typed scenarios/actions, evidence, recovery, Dev Host, and kit packaging contract.

`scripts/mortise-ui` is the source-only CLI; Electron test-host code provides privileged adapters; `developer-kit` defines distribution.

# Invariants

Runs have immutable IDs plus concise labels; actions use published targets; native operations require selected-window readiness; builds pin immutable source snapshots.

On Windows, foreground validation hosts load the registered AppShell scenario host as their initial renderer entry instead of navigating a visible production window between renderer pages. Background validation and normal Mortise launches retain their standard startup entry and renderer configuration. Validation-only renderer entries dispose their bridges and acknowledge the native close handshake without invoking production persistence.

# Change Impact

Feature specialists contribute stable semantics and scenarios; build ownership preserves isolated, version-matched kit artifacts.

Automation can pass against fixtures while physical rendering fails; stale native references can target the wrong control or process.

Changes to `scripts/mortise-ui` must be checked against `apps/cli` for shared protocol, output-contract, or user-visible command effects. Keep the UI-validation CLI and server CLI independently owned, but synchronize shared contracts, documentation, focused tests, and the versioned Developer Kit whenever the change crosses their boundary. A source change is not shipped to kit users until the kit is rebuilt and its packaged smoke passes.

# Validation

Run CLI, controller, build cache, process identity, semantic, native readiness, scenario, recovery, and surface-parity suites; for cross-CLI changes also run the headless CLI tests and the Developer Kit package/smoke validation.
