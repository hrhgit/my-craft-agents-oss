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
  - apps/electron/src/renderer/pages/ChatPage.tsx
  - apps/electron/src/renderer/pages/chat-search-focus-binding.ts
  - apps/electron/src/renderer/pages/NewConversationPage.tsx
  - apps/electron/src/renderer/event-processor/**
related: [packages/shared/src/sessions/**, apps/electron/src/renderer/components/app-shell/**, apps/electron/src/renderer/components/extensions/**]
depends_on: [session-lifecycle, shared-ui-i18n]
collaborates_with: [session-lifecycle, session-tooling, shared-ui-i18n]
validation:
  - { id: conversation-regression, kind: unit, command: "bun test packages/ui/src/components/chat packages/ui/src/components/annotations apps/electron/src/renderer/pages/__tests__/new-conversation-submit.test.ts", description: "Run conversation, annotation, and new-conversation draft regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: conversation-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise conversation behavior through the shared Developer Kit host.", triggers: [ui-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
scope_digest: b63dfc4f6ca2b3a71b99b91448d471b80fffa940
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
- 2026-07-24: Made first-turn publication await the ordered durable clear of the workspace draft before navigating, while keeping an already-published Session truthful if draft cleanup itself fails.
- 2026-07-23: Removed legacy Pi and workspace Session-path tooltip compatibility; inline file badges now shorten only the current Mortise Agent sidecar layout.
- 2026-07-23: Bound shared conversation-search navigation and match reporting to the focused panel, and made response/tool search targets semantically addressable with controlled reveal of collapsed activity groups.
- 2026-07-22: Kept transcript and attempt projection owned by Pi while routing durable Host `complete` through the conversation processor as the canonical boundary that clears settlement failure and processing state.
- 2026-07-22: Consumed accepted-pending-settlement as persistent Session state without creating a transcript error or resend effect, kept the Session processing until complete, and cleared stale failure state from fresh Host snapshots.
- 2026-07-22: Made typed unpublished durability failures persistent and explicit for both retryable and terminal-only outcomes, with retries bound to the exact frozen first-turn payload.
- 2026-07-22: Gave blank-workspace composers a stable workspace-and-draft semantic scope without implying that an unpublished draft is a Session.
- 2026-07-21: Removed the legacy scalar dialog composer branch and kept the conversation composer replacement boundary strictly on versioned extension interactions.
- 2026-07-21: Kept failed first-turn drafts authoritative and exposed an inline retry only for typed retryable `unpublished` durability outcomes from the RPC boundary.
- 2026-07-21: Removed the legacy Session event normalization bridge; the renderer processor now consumes only the current shared canonical event contract and explicitly ignores current host-only events.
- 2026-07-21: Removed the retired plan message role from turn grouping; plans render only as assistant responses carrying versioned artifacts.
- 2026-07-21: Removed per-session working-directory drafts and event projections; conversation composers resolve only against the selected workspace root.
- 2026-07-14: Synchronized extension interaction state with the composer.
- 2026-07-20: Kept blank-conversation drafts visible and durable until the first assistant message publishes the Session.
