---
schema: module-agent/v1
id: shared-ui-i18n
name: Shared UI and Internationalization
summary: Reusable UI primitives, icons, themes, localization, styling, and platform-neutral presentation helpers.
status: active
keywords: [ui, component, i18n, locale, theme, icon, accessibility]
owns:
  - packages/ui/package.json
  - packages/ui/tsconfig.json
  - packages/ui/eslint.config.mjs
  - packages/ui/eslint-rules/**
  - packages/ui/src/index.ts
  - packages/ui/src/components/icons/**
  - packages/ui/src/components/terminal/**
  - packages/ui/src/components/tooltip.tsx
  - packages/ui/src/components/ui/**
  - packages/ui/src/context/**
  - packages/ui/src/lib/**
  - packages/ui/src/styles/**
  - packages/shared/src/colors/**
  - packages/shared/src/i18n/**
  - packages/shared/src/icons/**
  - apps/electron/src/renderer/components/icons/**
  - apps/electron/src/renderer/components/ui/**
  - apps/electron/src/renderer/components/shiki/**
  - apps/electron/src/renderer/assets/**
  - apps/electron/src/renderer/index.css
  - apps/electron/src/renderer/utils/**
  - scripts/check-i18n-parity.ts
  - scripts/sort-locales.ts
related: [apps/electron/src/renderer/components/**, packages/ui/src/components/chat/**]
depends_on: [shared-contracts]
collaborates_with: [conversation-ui]
validation:
  - { id: shared-ui-regression, kind: unit, command: "bun test packages/ui", description: "Run shared UI regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: i18n-contract, kind: contract, command: "bun run lint:i18n:parity && bun run lint:i18n:sorted", description: "Verify locale parity and deterministic sorting.", triggers: [locale-change, contract-change], required: true, evidence: "Lint exit status and diagnostics." }
scope_digest: 56bf33e5d6e9a97c364f2ac037015581922f8962
---

## Purpose
Keep shared presentation coherent, accessible, themeable, and translated across supported clients.

## Specialist mandate
Own generic primitives, visual tokens, icons, localization catalogs, terminal rendering, and non-feature-specific UI helpers.

## Responsibilities
Maintain public component exports, dismiss behavior, focus semantics, theme tokens, locale parity and sorting, and reusable controls.

## Non-goals
Do not own feature workflows, transcript semantics, rich file previews, or workspace layout policy.

## Contracts and invariants
Primitives expose stable accessible identity and actions; locale keys remain in parity; shared UI stays platform-neutral.

## Architecture and entry points
`@mortise/ui` provides reusable React surfaces; shared i18n and icon packages supply product data to clients.

## Collaboration
Feature specialists compose primitives and contribute translations without duplicating generic controls.

## Validation
Run package tests, ESLint rules, type checking, locale parity, and locale ordering checks.

## Known risks
Primitive changes have a wide visual blast radius; translation drift and focus regressions are easy to miss in unit tests.

## Semantic history
- 2026-07-12: Consolidated reusable renderer presentation for Electron and WebUI use.
- 2026-07-14: Added stable semantic identities to UI primitives for validation.
- 2026-07-20: Removed the Data Sources locale contract and narrowed mention-menu copy to files and skills.
