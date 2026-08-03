---
schema: project-module/v1
id: provider-model-runtime
name: Provider and Model Runtime
summary: Provider transports, model catalogs, credentials, and Mortise model-selection integration.
status: active
when_to_read:
  - provider transports, model catalogs, credentials, OAuth, thinking, or model selection changes
tags:
  - provider
  - model
  - api-key
  - oauth
  - thinking
  - transport
entrypoints:
  - packages/server-core/src/model-fetchers/index.ts
  - pi/packages/ai/src/index.ts
  - apps/electron/src/renderer/components/apisetup/index.ts
depends_on:
  - shared-contracts
  - app-settings-security
related:
  - app-settings-security
frontend_impact:
  affects: true
  areas:
    - provider, model, and authentication settings and selectors
    - composer model and thinking controls and provider error states
  interaction_docs:
    - .agents/modules/provider-model-runtime/frontend-interactions.md
validation:
  - npm --prefix pi test --workspace @mortise/pi-ai
  - bun test packages/shared/tests/models-pi.test.ts
---

# Purpose

Provide normalized model metadata and streaming provider behavior to Pi and Mortise.

# Boundary

Maintain Pi AI provider adapters, model registries, model fetching, thinking metadata, and provider-facing settings UI.

Do not own agent loop policy, session persistence, or generic application settings.

# Capabilities

Resolve provider authentication, request conversion, event streaming, model capabilities, and selection behavior across supported APIs.

Pi transports live in `pi/packages/ai`; Mortise catalog bridges live in shared config and server model fetchers.

# Invariants

Provider events normalize to shared Pi stream events; remote model refresh supplies candidates and never silently persists every returned model.

# Change Impact

Coordinate model execution with `pi-agent-engine` and credential persistence with `app-settings-security`.

Provider wire formats and model identifiers drift independently; generated catalogs can hide compatibility regressions.

# Validation

Run Pi AI tests plus Mortise model and provider configuration tests.
