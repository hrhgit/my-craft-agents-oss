---
schema: module-agent/v1
id: messaging
name: Messaging
summary: Telegram, WhatsApp, Feishu, and messaging-to-session gateway behavior.
status: active
keywords: [messaging, telegram, whatsapp, feishu, gateway, remote]
owns:
  - packages/messaging-gateway/**
  - packages/messaging-whatsapp-worker/**
  - apps/electron/src/renderer/components/messaging/**
  - packages/server-core/src/handlers/rpc/messaging.ts
related: [apps/electron/resources/pi-extensions/messaging.js, packages/shared/src/sessions/**]
depends_on: [session-lifecycle, headless-server-cli]
collaborates_with: []
validation:
  - { id: messaging-regression, kind: unit, command: "bun test packages/messaging-gateway packages/messaging-whatsapp-worker", description: "Run messaging gateway and worker regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
scope_digest: 6f485d5a6f138ce4eeb7f97cd9b93c15f2c63ae5
---

## Purpose
Bridge external messaging channels into Mortise conversations and responses.

## Specialist mandate
Own channel adapters, gateway lifecycle, account state, message normalization, routing, worker protocol, and messaging UI.

## Responsibilities
Maintain Telegram, WhatsApp, and Feishu integration, remote session routing, attachments, logging, and reconnect behavior.

## Non-goals
Do not own core session persistence, Pi extension hosting, or generic network transports.

## Contracts and invariants
Incoming messages map to a stable workspace/session context; channel acknowledgements do not precede durable acceptance.

## Architecture and entry points
The gateway package coordinates adapters and server services; the WhatsApp worker isolates its client runtime.

## Collaboration
Use `session-lifecycle` for conversations and `extension-runtime` for Pi-facing messaging hooks.

## Validation
Run adapter, routing, reconnect, worker protocol, and renderer messaging tests.

## Known risks
Provider reconnect and duplicate-delivery behavior differ; remote media can exceed local attachment limits.

## Semantic history
- 2026-06-07: Expanded session activity and extension runtime behavior used by messaging.
- 2026-07-14: Hardened Pi messaging extension routing.
