---
schema: module-agent/v1
id: conversation-ui
name: Conversation UI
summary: Transcript rendering, composer interactions, plans, annotations, and conversation pages.
status: active
keywords: [chat, transcript, composer, turn, plan, annotation, message]
owns:
  - packages/ui/src/components/chat/**
  - packages/ui/src/components/annotations/**
  - apps/electron/src/renderer/components/chat/**
  - apps/electron/src/renderer/pages/ChatPage.tsx
  - apps/electron/src/renderer/pages/NewConversationPage.tsx
  - apps/electron/src/renderer/event-processor/**
related: [packages/shared/src/sessions/**, apps/electron/src/renderer/components/app-shell/**, apps/electron/src/renderer/components/extensions/**]
depends_on: [session-lifecycle, shared-ui-i18n]
collaborates_with: [session-lifecycle, session-tooling, shared-ui-i18n]
validation:
  - { id: conversation-regression, kind: unit, command: "bun test packages/ui/src/components/chat packages/ui/src/components/annotations apps/electron/src/renderer/components/chat apps/electron/src/renderer/pages/__tests__/new-conversation-submit.test.ts", description: "Run conversation, annotation, and new-conversation draft regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: conversation-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise conversation behavior through the shared Developer Kit host.", triggers: [ui-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
scope_digest: e31a70fb040f7267be9f2e17bb554ef63c9b2d49
---

## Purpose
Present a coherent, accessible conversation from durable user and agent events.

## Specialist mandate
Own transcript grouping, composer behavior, turn lifecycle, plan presentation, annotations, and conversation page integration.

## Responsibilities
Maintain message cards, tool presentation hooks, answer submission, drafts integration, follow-ups, and extension inline surfaces.

## Non-goals
Do not own session persistence, agent execution, generic dock layout, or extension backend lifecycle.

## Contracts and invariants
All send actions use Lucide `ArrowUp`; the blank workspace draft contains a complete composer but no welcome or preset prompts. A new-conversation draft remains authoritative while the combined first turn is unpublished; clear it and navigate to the Session only after session-lifecycle confirms Pi's first assistant message is durable and the Session is published.

## Architecture and entry points
Reusable transcript components live in `packages/ui`; Electron composes them in `ChatPage`, `ChatDisplay`, and input components.

## Collaboration
Consume durable state from `session-lifecycle`, extension contributions from `extension-ui`, and placement from `universal-layout`.

## Validation
Run turn grouping, plan, annotation, composer, remote interaction, and chat page tests.

## Known risks
Event projections can create duplicate or prematurely terminal turns; rich extension content can disrupt composer focus.

## Semantic history
- 2026-07-12: Unified conversation projection between Electron and WebUI.
- 2026-07-14: Synchronized extension interaction state with the composer.
- 2026-07-20: Kept blank-conversation drafts visible and durable until the first assistant message publishes the Session.
