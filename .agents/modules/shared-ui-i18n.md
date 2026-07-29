---
schema: project-module/v1
id: shared-ui-i18n
name: Shared UI and Internationalization
summary: Reusable UI primitives, icons, themes, localization, styling, and platform-neutral presentation helpers.
status: active
when_to_read:
  - shared UI primitives, icons, themes, localization, accessibility, or presentation helpers
tags:
  - ui
  - component
  - i18n
  - locale
  - theme
  - icon
  - accessibility
entrypoints:
  - packages/ui/src/index.ts
  - packages/shared/src/colors/index.ts
  - packages/shared/src/i18n/index.ts
depends_on:
  - shared-contracts
related:
  - conversation-ui
validation:
  - bun test packages/ui
  - bun run lint:i18n:parity && bun run lint:i18n:sorted
---

# Purpose

Keep shared presentation coherent, accessible, themeable, and translated across supported clients.

# Boundary

Maintain public component exports, dismiss behavior, focus semantics, theme tokens, locale parity and sorting, and reusable controls.

Do not own feature workflows, transcript semantics, rich file previews, or workspace layout policy.

# Capabilities

Own generic primitives, visual tokens, icons, localization catalogs, terminal rendering, and non-feature-specific UI helpers.

`@mortise/ui` provides reusable React surfaces; shared i18n and icon packages supply product data to clients.

# Invariants

Primitives expose stable accessible identity and actions; locale keys remain in parity; shared UI stays platform-neutral.

# Change Impact

Feature specialists compose primitives and contribute translations without duplicating generic controls.

Primitive changes have a wide visual blast radius; translation drift and focus regressions are easy to miss in unit tests.

# Validation

Run package tests, ESLint rules, type checking, locale parity, and locale ordering checks.
