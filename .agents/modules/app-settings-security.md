---
schema: project-module/v1
id: app-settings-security
name: Application Settings and Security
summary: Global configuration, authentication, credentials, permissions, onboarding, and settings UI.
status: active
when_to_read:
  - global settings, authentication, credentials, permissions, onboarding, or security policy changes
tags:
  - settings
  - config
  - auth
  - credential
  - permission
  - onboarding
  - security
entrypoints:
  - packages/shared/src/auth/index.ts
  - packages/shared/src/config/index.ts
  - packages/shared/src/credentials/index.ts
depends_on:
  - shared-contracts
  - workspace-state
related:
  - provider-model-runtime
frontend_impact:
  affects: true
  areas:
    - Electron and WebUI settings pages
    - onboarding, authentication, credential, and permission surfaces
  interaction_docs:
    - .agents/modules/app-settings-security/frontend-interactions.md
validation:
  - bun test --isolate packages/shared/src/config packages/shared/src/auth packages/shared/src/credentials
  - bun run typecheck:electron
  - bun run test:ui-validation:electron
---

# Purpose

Persist secure global application choices and guide users through connection setup.

# Boundary

Maintain defaults, migrations, credential lifetimes, global provider choices, permission synchronization, and settings navigation.

Do not own provider wire transports, workspace-specific state, or extension execution.

# Capabilities

Own settings schemas and storage, authentication callbacks, credential protection, permission policy, onboarding, and settings presentation.

Shared config and credential stores are surfaced through server/Electron handlers and the renderer settings pages. `config/state-contract.ts` exposes the side-effect-free database path and global record identity for consumers that operate on an explicit profile directory.

# Invariants

AI connection, model, and thinking defaults are global; `state.sqlite` is the sole authority for Mortise global configuration and session drafts, while retired JSON files are ignored and left untouched; Mortise's Pi runtime uses `<CONFIG_DIR>/agent` and never falls back to independent Pi's `~/.pi/agent`; Mortise project settings and resources use only `<workspace>/.mortise` and never read or write project `.pi`; user-authored and Extension-provided subagent templates use the same core execution contract, while Extension templates remain read-only and Extension-owned; the one-time root migration is serialized across processes and imports loose extension assets, `extension-data`, package declarations, local extension declarations, and `extensionConfig`, while package-manager caches are rebuilt and sessions, providers, credentials, defaults, and unrelated settings are never imported; provider definitions never carry credentials, and provider API keys enter the canonical auth store only through an explicit credential argument; secrets are never exposed through ordinary DTOs; permission changes validate before persistence.

# Change Impact

Provider fields are defined with `provider-model-runtime`; extension settings and sources retain feature-owned semantics.

Configuration schema changes can silently weaken defaults; browser and desktop authentication have different trust boundaries. SQLite state changes must continue to preserve capability fencing, optimistic concurrency, idempotent operations, and atomic writes across concurrently running supported Mortise versions.

# Validation

Run config, credential, permission, onboarding, and renderer settings tests.
