---
schema: module-agent/v1
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
  - packages/server-core/src/handlers/rpc/oauth.ts
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
scope_digest: 1c456a479dbf9ecbbaaa2cffeff620c845abf3f3
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
AI connection, model, and thinking defaults are global; secrets are never exposed through ordinary DTOs; permission changes validate before persistence.

## Architecture and entry points
Shared config and credential stores are surfaced through server/Electron handlers and the renderer settings pages.

## Collaboration
Provider fields are defined with `provider-model-runtime`; extension settings and sources retain feature-owned semantics.

## Validation
Run config, credential, permission, onboarding, and renderer settings tests.

## Known risks
Configuration migrations can silently weaken defaults; browser and desktop authentication have different trust boundaries.

## Semantic history
- 2026-07-13: Consolidated provider, model, and thinking defaults into global settings.
- 2026-07-18: Hardened shared configuration writes for concurrent backends.
- 2026-07-20: Removed Data Sources-owned settings and content-validation contracts while leaving legacy on-disk fields and data untouched.
