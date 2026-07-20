---
schema: module-agent/v1
id: provider-model-runtime
name: Provider and Model Runtime
summary: Provider transports, model catalogs, credentials, and Mortise model-selection integration.
status: active
keywords: [provider, model, api-key, oauth, thinking, transport]
owns:
  - pi/packages/ai/**
  - packages/server-core/src/model-fetchers/**
  - packages/shared/tests/models*.test.ts
  - apps/electron/src/renderer/components/apisetup/**
related: [packages/shared/src/agent/backend/**, packages/shared/src/config/**, apps/electron/src/renderer/components/onboarding/**]
depends_on: [shared-contracts, app-settings-security]
collaborates_with: [app-settings-security]
validation:
  - { id: provider-model-regression, kind: unit, command: "npm --prefix pi test --workspace @mortise/pi-ai", description: "Run provider and model runtime regressions.", triggers: [owned-change], required: true, evidence: "Workspace test exit status and output." }
  - { id: mortise-pi-model-contract, kind: contract, command: "bun test packages/shared/tests/models-pi.test.ts", description: "Verify the Mortise-to-Pi model contract.", triggers: [contract-change], required: true, evidence: "Contract test exit status and output." }
scope_digest: cd19bd414413fd3ee88aa8724925f1cef527e43a
---

## Purpose
Provide normalized model metadata and streaming provider behavior to Pi and Mortise.

## Specialist mandate
Resolve provider authentication, request conversion, event streaming, model capabilities, and selection behavior across supported APIs.

## Responsibilities
Maintain Pi AI provider adapters, model registries, model fetching, thinking metadata, and provider-facing settings UI.

## Non-goals
Do not own agent loop policy, session persistence, or generic application settings.

## Contracts and invariants
Provider events normalize to shared Pi stream events; remote model refresh supplies candidates and never silently persists every returned model.

## Architecture and entry points
Pi transports live in `pi/packages/ai`; Mortise catalog bridges live in shared config and server model fetchers.

## Collaboration
Coordinate model execution with `pi-agent-engine` and credential persistence with `app-settings-security`.

## Validation
Run Pi AI tests plus Mortise model and provider configuration tests.

## Known risks
Provider wire formats and model identifiers drift independently; generated catalogs can hide compatibility regressions.

## Semantic history
- 2026-07-13: Migrated Mortise provider configuration to the Pi model representation.
- 2026-07-19: Reset product-owned package and version lineage to Mortise.
