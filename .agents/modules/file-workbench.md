---
schema: module-agent/v1
id: file-workbench
name: File Workbench
summary: Workspace file tree, previews, rich documents, code and diff viewers, and safe fallbacks.
status: active
keywords: [file, preview, markdown, diff, pdf, document, tree]
owns:
  - packages/ui/src/components/code-viewer/**
  - packages/ui/src/components/markdown/**
  - packages/ui/src/components/overlay/**
  - packages/ui/src/pdfjs-worker.d.ts
  - apps/electron/src/renderer/components/files/**
  - apps/electron/src/renderer/components/markdown/**
  - apps/electron/src/renderer/components/preview/**
  - apps/electron/src/renderer/components/right-workbench/**
  - apps/electron/src/renderer/components/session-files/**
  - apps/electron/resources/docs/data-tables.md
  - apps/electron/resources/docs/html-preview.md
  - apps/electron/resources/docs/image-preview.md
  - apps/electron/resources/docs/markdown-preview.md
  - apps/electron/resources/docs/mermaid.md
  - apps/electron/resources/docs/pdf-preview.md
related: [packages/server-core/src/handlers/rpc/files.ts, apps/electron/resources/scripts/**]
depends_on: [workspace-state, shared-ui-i18n]
collaborates_with: [universal-layout]
validation:
  - { id: file-workbench-regression, kind: unit, command: "bun test packages/ui/src/components/markdown packages/ui/src/components/overlay apps/electron/src/renderer/components/right-workbench", description: "Run file preview and workbench regressions.", triggers: [owned-change], required: true, evidence: "Bun test exit status and output." }
  - { id: file-workbench-physical, kind: physical, command: "bun run test:ui-validation:electron", description: "Exercise file workbench behavior through the shared Developer Kit host.", triggers: [ui-change, release], required: false, evidence: "Developer Kit run output and retained UI evidence." }
scope_digest: b54d3c602b2c80484bbdccd71fe029fed8782f98
---

## Purpose
Inspect workspace files in a safe, workspace-scoped content tab.

## Specialist mandate
Own file-tree interaction, format classification, code/diff/Markdown/rich previews, internal navigation, and preview fallback behavior.

## Responsibilities
Maintain file selection and watch state, preview renderers, export actions, annotations, draft queues, and safe HTML/link policy.

## Non-goals
Do not create a global file sidebar, own filesystem RPC authorization, or treat every binary format as renderable.

## Contracts and invariants
The file tree is internal to its content surface; selected files render in the main area; unsupported files use a safe fallback.

## Architecture and entry points
Reusable viewers live in `packages/ui`; Electron file and workbench components bind them to workspace file RPC.

## Collaboration
Workspace state validates paths and watches files; universal layout hosts file tabs without a dedicated right-panel architecture.

## Validation
Run file classification, raw HTML policy, rich block parity, workbench state, draft queue, and watcher tests.

## Known risks
Untrusted file content can trigger unsafe links or resource loads; large files can block renderer responsiveness.

## Semantic history
- 2026-07-18: Moved files into workspace-scoped universal dock content with an internal navigator.
