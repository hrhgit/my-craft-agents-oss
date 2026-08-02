---
schema: project-module/v1
id: file-workbench
name: File Workbench
summary: Workspace file tree, previews, rich documents, code and diff viewers, and safe fallbacks.
status: active
when_to_read:
  - workspace file trees, previews, rich documents, code, diff, or safe fallback changes
tags:
  - file
  - preview
  - markdown
  - diff
  - pdf
  - document
  - tree
entrypoints:
  - packages/ui/src/components/code-viewer/index.ts
  - packages/ui/src/components/markdown/index.ts
  - packages/ui/src/components/overlay/index.ts
depends_on:
  - workspace-state
  - shared-ui-i18n
related:
  - universal-layout
frontend_impact:
  affects: true
  areas:
    - workspace file tree, preview, editor, diff, and file-action states
validation:
  - >-
    bun test packages/ui/src/components/markdown packages/ui/src/components/overlay
    apps/electron/src/renderer/components/right-workbench
  - bun run test:ui-validation:electron
---

# Purpose

Inspect workspace files in a safe, workspace-scoped content tab.

# Boundary

Maintain file selection and watch state, preview renderers, export actions, annotations, draft queues, and safe HTML/link policy.

Do not create a global file sidebar, own filesystem RPC authorization, or treat every binary format as renderable.

# Capabilities

Own file-tree interaction, format classification, code/diff/Markdown/rich previews, internal navigation, and preview fallback behavior.

Reusable viewers live in `packages/ui`; Electron file and workbench components bind them to workspace file RPC.

# Invariants

The file tree is internal to its content surface; selected files render in the main area; unsupported files use a safe fallback.

# Change Impact

Workspace state validates paths and watches files; universal layout hosts file tabs without a dedicated right-panel architecture.

Untrusted file content can trigger unsafe links or resource loads; large files can block renderer responsiveness.

# Validation

Run file classification, raw HTML policy, rich block parity, workbench state, draft queue, and watcher tests.
