---
schema: project-module/v1
id: conversation-ui
name: Conversation UI
summary: Transcript rendering, composer interactions, plans, annotations, and conversation pages.
status: active
when_to_read:
  - chat transcripts, composers, turns, plans, annotations, or conversation page changes
tags:
  - chat
  - transcript
  - composer
  - turn
  - plan
  - annotation
  - message
entrypoints:
  - packages/ui/src/components/chat/index.ts
  - apps/electron/src/renderer/pages/ChatPage.tsx
  - apps/electron/src/renderer/pages/NewConversationPage.tsx
depends_on:
  - session-lifecycle
  - shared-ui-i18n
related:
  - session-lifecycle
  - session-tooling
  - shared-ui-i18n
frontend_impact:
  affects: true
  areas:
    - conversation transcript, composer, turn controls, plans, and annotations
validation:
  - >-
    bun test packages/ui/src/components/chat packages/ui/src/components/annotations
    apps/electron/src/renderer/pages/__tests__/new-conversation-submit.test.ts
  - bun run test:ui-validation:electron
---

# Purpose

Present a coherent, accessible conversation from durable user and agent events.

# Boundary

Maintain message cards, tool presentation hooks, answer submission, drafts integration, follow-ups, and extension inline surfaces.

Do not own session persistence, agent execution, generic dock layout, or extension backend lifecycle.

# Capabilities

Own transcript grouping, composer behavior, turn lifecycle, plan presentation, annotations, and conversation page integration.

Reusable transcript components live in `packages/ui`; Electron composes them in `ChatPage`, `ChatDisplay`, and input components.

# Invariants

All send actions use Lucide `ArrowUp`; slash commands remain visible only for capabilities without a Mortise GUI control. The blank workspace draft contains a complete composer but no welcome or preset prompts. A new-conversation draft remains authoritative while the combined first turn is unpublished; clear it and navigate to the Session only after session-lifecycle confirms Pi's first assistant message is durable and the Session is published.

# Change Impact

Consume durable state from `session-lifecycle`, extension contributions from `extension-ui`, and placement from `universal-layout`.

Event projections can create duplicate or prematurely terminal turns; rich extension content can disrupt composer focus.

# Validation

Run turn grouping, plan, annotation, composer, remote interaction, and chat page tests.
