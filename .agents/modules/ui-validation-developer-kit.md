---
schema: module-agent/v1
id: ui-validation-developer-kit
name: UI Validation Developer Kit
summary: AI-facing mortise-ui CLI, isolated Dev Host, semantic/native actions, scenarios, and evidence.
status: active
keywords: [mortise-ui, developer-kit, validation, semantic, native, scenario, evidence]
owns:
  - developer-kit/**
  - scripts/mortise-ui/**
  - scripts/e2e/ui-validation/**
  - apps/electron/src/main/ui-validation/**
  - apps/electron/src/main/ui-validation.dev.ts
  - apps/electron/src/renderer/ui-validation/**
  - apps/electron/src/renderer/ui-validation-disabled/**
  - apps/electron/src/renderer/playground/**
  - apps/electron/src/renderer/playground.tsx
  - apps/electron/src/renderer/playground.html
  - packages/shared/src/ui-validation/**
  - docs/testing.md
related: [apps/electron/src/main/**, apps/electron/src/renderer/components/extensions/**]
depends_on: [native-desktop, shared-contracts]
collaborates_with: [build-release-observability, extension-ui]
validation:
  - { id: mortise-ui-regression, kind: unit, command: "bun run test:mortise-ui", description: "Run the AI-facing mortise-ui CLI regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: validation-fast-contract, kind: contract, command: "bun run test:ui-validation:fast", description: "Verify fast validation semantics across host layers.", triggers: [contract-change], required: true, evidence: "Cross-layer test exit status and output." }
  - { id: validation-runtime-integration, kind: integration, command: "bun run test:ui-validation:runtime-contract", description: "Exercise the validation runtime contract end to end.", triggers: [runtime-change, release], required: true, evidence: "Runtime contract result and retained diagnostics." }
scope_digest: 290968135e761f058da29785682a736cf6a9f33d
---

## Purpose
Give development agents a reliable, discoverable control plane for real Mortise UI validation.

## Specialist mandate
Own isolated run/build lifecycle, semantic and native snapshots, typed scenarios/actions, evidence, recovery, Dev Host, and kit packaging contract.

## Responsibilities
Maintain concise AI guidance, run identity, process safety, readiness, UIA/CDP drivers, fixtures, extension semantics, and evidence retention.

## Non-goals
Do not ship privileged test control in the normal app or replace representative physical renderer and native checks with fast tests.

## Contracts and invariants
Runs have immutable IDs plus concise labels; actions use published targets; native operations require selected-window readiness; builds pin immutable source snapshots.

## Architecture and entry points
`scripts/mortise-ui` is the source-only CLI; Electron test-host code provides privileged adapters; `developer-kit` defines distribution.

## Collaboration
Feature specialists contribute stable semantics and scenarios; build ownership preserves isolated, version-matched kit artifacts.

## Validation
Run CLI, controller, build cache, process identity, semantic, native readiness, scenario, recovery, and surface-parity suites.

## Known risks
Automation can pass against fixtures while physical rendering fails; stale native references can target the wrong control or process.

## Semantic history
- 2026-07-23: Cut validation profiles over to `mortise-config/agent`; clone mode accepts only an explicit Mortise profile, while fixture and isolated runs never read independent Pi state.
- 2026-07-23: Added authenticated, selected-window renderer performance diagnostics with bounded aggregate-only sampling and reliable lifecycle-test teardown under full-suite load.
- 2026-07-23: Made profile preparation await canonical fixture Session durability before the UI validation Host can start.
- 2026-07-22: Made physical runtime replacement target the unique current Pi GlobalHost CLI process and fail with bounded diagnostics on missing or ambiguous candidates.
- 2026-07-22: Aligned physical settlement runtime evidence parsing with the current structured log `data` envelope so replacement checks observe authoritative Host identities.
- 2026-07-22: Bound the physical abort settlement timeline to authoritative aborted turn, agent-end, and agent-settled projection states instead of fuzzy runtime event names.
- 2026-07-22: Made the physical Session settlement runner selectable by timeline and retained bounded failure diagnostics plus the isolated profile after a failed timeline.
- 2026-07-22: Extended the isolated publication backend with a Session-targeted one-shot canonical-user persistence failure so physical validation can prove exact composer restoration and identity-stable retry for existing Sessions.
- 2026-07-22: Added transferable same-profile restarts with fresh run identity and a Node-only one-shot first-turn backend restricted to provisional Sessions, with cross-process single-winner lease claims and physical failure/success/reload publication acceptance.
- 2026-07-21: Reconciled DOM, accessibility, and business semantics by resolved element identity, and bound WebUI refs to decision-relevant semantic revisions instead of incidental DOM mutations.
- 2026-07-21: Moved the complete playground component registry behind its own dynamic boundary so validation-only demos do not inflate the main renderer startup graph.
- 2026-07-21: Made fixture and clone profiles SQLite-only for Mortise configuration, with consistent database snapshots and no legacy config, drafts, or sync-baseline files.
- 2026-07-21: Migrated the interaction playground and physical validation scenario from legacy RemoteUI fixtures to a real Extension Interaction V1 request.
- 2026-07-21: Updated messaging and browser playground fixtures to emit only current required access fields and canonical browser_tool commands.
- 2026-07-21: Added a canceled skill-import stub to the renderer playground API surface.
- 2026-07-20: Removed the Sources route surface and legacy workspace icon dependency from validation fixtures; fixture workspaces now create their root directly without creating a sources directory.
- 2026-07-14: Added UI validation host, extension semantics, and RPC lifecycle support.
- 2026-07-18: Added immutable build cache, native readiness, and expanded AI-facing surfaces.
- 2026-07-19: Hardened process identity for concurrent source runs.
