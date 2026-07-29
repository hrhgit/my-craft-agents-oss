---
schema: project-module/v1
id: messaging
name: Messaging
summary: Telegram, WhatsApp, Feishu, and messaging-to-session gateway behavior.
status: active
when_to_read:
  - Telegram, WhatsApp, Feishu, or messaging-to-session gateway changes
tags:
  - messaging
  - telegram
  - whatsapp
  - feishu
  - gateway
  - remote
entrypoints:
  - packages/messaging-gateway/src/index.ts
  - packages/messaging-gateway/src/adapters/lark/index.ts
  - packages/messaging-gateway/src/adapters/telegram/index.ts
depends_on:
  - session-lifecycle
  - headless-server-cli
related: []
validation:
  - bun test packages/messaging-gateway packages/messaging-whatsapp-worker
---

# Purpose

Bridge external messaging channels into Mortise conversations and responses.

# Boundary

Maintain Telegram, WhatsApp, and Feishu integration, remote session routing, attachments, logging, and reconnect behavior.

Do not own core session persistence, Pi extension hosting, or generic network transports.

# Capabilities

Own channel adapters, gateway lifecycle, account state, message normalization, routing, worker protocol, and messaging UI.

The gateway package coordinates adapters and server services; the WhatsApp worker isolates its client runtime.

# Invariants

Incoming messages map to a stable workspace/session context; channel acknowledgements do not precede durable acceptance.

# Change Impact

Use `session-lifecycle` for conversations and `extension-runtime` for Pi-facing messaging hooks.

Provider reconnect and duplicate-delivery behavior differ; remote media can exceed local attachment limits.

# Validation

Run adapter, routing, reconnect, worker protocol, and renderer messaging tests.
