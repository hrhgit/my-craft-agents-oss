---
schema: module-agent/v2
id: app-settings-security
name: Application Settings and Security
summary: Global configuration, authentication, credentials, permissions, onboarding, and settings UI.
status: active
keywords: [settings, config, auth, credential, permission, onboarding, security]
owns:
  - packages/shared/src/auth/**
  - packages/shared/src/config/**
  - packages/shared/src/credentials/**
  - packages/shared/tests/permissions-mortise-sync.test.ts
  - packages/shared/tests/shellguard-corpus.test.ts
  - apps/electron/src/renderer/components/settings/**
  - apps/electron/src/renderer/components/onboarding/**
  - apps/electron/src/renderer/pages/settings/**
  - apps/electron/resources/permissions/**
  - apps/electron/src/renderer/config/**
  - packages/server-core/src/handlers/rpc/auth.ts
  - packages/server-core/src/handlers/rpc/onboarding.ts
  - packages/server-core/src/handlers/rpc/pi-global-sync*.ts
  - packages/server-core/src/handlers/rpc/pi-providers*.ts
  - packages/server-core/src/handlers/rpc/settings*.ts
related: [apps/electron/src/main/handlers/settings.ts, packages/server-core/src/handlers/rpc/onboarding.ts]
depends_on: [shared-contracts, workspace-state]
collaborates_with: [provider-model-runtime]
validation:
  - { id: settings-security-regression, kind: unit, command: "bun test --isolate packages/shared/src/config packages/shared/src/auth packages/shared/src/credentials", description: "Run settings, authentication, and credential regressions with per-file module isolation.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: electron-settings-contract, kind: contract, command: "bun run typecheck:electron", description: "Verify Electron settings contracts compile.", triggers: [contract-change], required: true, evidence: "TypeScript compiler exit status and diagnostics." }
  - { id: settings-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise settings behavior through the shared Developer Kit host.", triggers: [ui-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
---

## Purpose
Persist secure global application choices and guide users through connection setup.

## Specialist mandate
Own settings schemas and storage, authentication callbacks, credential protection, permission policy, onboarding, and settings presentation.

## Responsibilities
Maintain defaults, migrations, credential lifetimes, global provider choices, permission synchronization, and settings navigation.

## Non-goals
Do not own provider wire transports, workspace-specific state, or extension execution.

## Contracts and invariants
AI connection, model, and thinking defaults are global; `state.sqlite` is the sole authority for Mortise global configuration and session drafts, while retired JSON files are ignored and left untouched; Mortise's Pi runtime uses `<CONFIG_DIR>/agent` and never falls back to independent Pi's `~/.pi/agent`; Mortise project settings and resources use only `<workspace>/.mortise` and never read or write project `.pi`; the one-time root migration is serialized across processes and imports loose extension assets, `extension-data`, package declarations, local extension declarations, and `extensionConfig`, while package-manager caches are rebuilt and sessions, providers, credentials, defaults, and unrelated settings are never imported; provider definitions never carry credentials, and provider API keys enter the canonical auth store only through an explicit credential argument; secrets are never exposed through ordinary DTOs; permission changes validate before persistence.

## Architecture and entry points
Shared config and credential stores are surfaced through server/Electron handlers and the renderer settings pages. `config/state-contract.ts` exposes the side-effect-free database path and global record identity for consumers that operate on an explicit profile directory.

## Collaboration
Provider fields are defined with `provider-model-runtime`; extension settings and sources retain feature-owned semantics.

## Validation
Run config, credential, permission, onboarding, and renderer settings tests.

## Known risks
Configuration schema changes can silently weaken defaults; browser and desktop authentication have different trust boundaries. SQLite state changes must continue to preserve capability fencing, optimistic concurrency, idempotent operations, and atomic writes across concurrently running supported Mortise versions.

## Semantic history
- 2026-07-24: Locked global thinking defaults and settings validation to the six current levels; retired `think` and `max` inputs are rejected without migration or persistence.
- 2026-07-23: Made `.mortise` the sole Mortise project resource root for settings, skills, and extensions; removed shared `PI_PROJECT_*` path aliases and rejected project `.pi/skills` as a config path.
- 2026-07-23: Separated Mortise's Agent root from independent Pi and added a cross-process serialized, one-time extension-only import that explicitly excludes sessions, providers, credentials, defaults, and unrelated settings.
- 2026-07-21: Made SQLite the sole runtime authority for global config and session drafts, exposed its profile-independent state contract, and removed retired JSON imports, materialization, backups, sync baselines, and file watchers.
- 2026-07-21: Made Telegram access fail closed in settings and required canonical binding access fields instead of treating missing values as open.
- 2026-07-21: Removed provider API-key startup migration and embedded `provider.apiKey` fallback; current callers must pass credentials explicitly and storage sanitizes provider definitions.
- 2026-07-21: Removed legacy `automations.json` validation, watcher, and direct-file guard contracts; Automations V3 is the sole current configuration authority.
- 2026-07-13: Consolidated provider, model, and thinking defaults into global settings.
- 2026-07-18: Hardened shared configuration writes for concurrent backends.
- 2026-07-20: Removed Data Sources-owned settings and content-validation contracts while leaving legacy on-disk fields and data untouched.
