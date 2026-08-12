---
schema: project-module/v1
id: build-release-observability
name: Build Release and Observability
summary: Monorepo configuration, CI, packaging, installers, resources, logging, versioning, and release metadata.
status: active
when_to_read:
  - builds, CI, packaging, installers, runtime logging, versioning, or release metadata changes
tags:
  - build
  - release
  - ci
  - package
  - installer
  - log
  - version
entrypoints:
  - package.json
  - scripts/build/dependency-view-cache.ts
  - scripts/build/validate-production-bundles.ts
  - apps/electron/src/main/logger.ts
depends_on:
  - shared-contracts
related:
  - project-modules
  - ui-validation-developer-kit
frontend_impact:
  affects: true
  areas:
    - application startup, update, About, release-note, and diagnostic surfaces
validation:
  - git diff --check
  - bun run module:lint
  - bun run validate:production-node-bundles
  - bun run pi:build && bun run pi:check
  - bun run pi:test
  - bun run typecheck:all
  - bun run test:shared:all
  - bun run test:doc-tools
  - bun run test:build-validation
  - bun run validate:production-bundles
  - bun run test:ui-validation:fast
  - bun run lint:i18n:parity
  - bun run lint:i18n:sorted
---

# Purpose

Build, validate, package, diagnose, and release the independently versioned Mortise monorepo.

# Boundary

Maintain reproducible builds, package boundaries, audit workflows, source snapshots, installers, release notes, log sinks, and validation entry points.

Do not import former upstream changes without explicit direction or own feature behavior merely because it is packaged.

# Capabilities

Own workspace manifests, CI, build scripts, packaging metadata, bundled resources, installers, runtime logging, and version lineage.

Isolated source builds reuse immutable dependency views addressed independently from ordinary source files. Root Bun and embedded Pi npm views are identified by lockfiles, workspace manifests, install configuration, toolchain, platform, and architecture; source-only changes rematerialize the matching view instead of reinstalling dependencies.

Root scripts orchestrate Bun and Pi workspaces; Electron scripts package desktop assets; CI runs repository validation and audits. `validate:production-node-bundles` is the non-writing high-frequency production compile, `validate:production-bundles` runs the complete Electron build, and `electron:dist:win`, `electron:dist:mac`, and `electron:dist:linux` own target-platform installer generation.

### Runtime diagnostics
The primary local diagnostic file is `%MORTISE_CONFIG_DIR%\logs\runtime.log` when `MORTISE_CONFIG_DIR` is set, otherwise `%USERPROFILE%\.mortise\logs\runtime.log`. It is JSONL and rotates to `runtime.log.1` at about 5 MB. `scope: "pi-rpc"` records Pi subprocess startup, capability handshake, lifecycle failures, and captured stderr; `scope: "session"` records Session chat failures with Session, Workspace, model, and structured error context. Check this file first for `Pi Process Exited`, `get_capabilities`, or Windows `EPERM` startup failures.

`messaging-gateway.log`, `auto-update.log`, and the non-packaged debug-only `interceptor.log` remain specialized logs. Workspace `events.jsonl` is automation history, and Mortise/Pi Session JSONL files are Session state rather than main-process diagnostics.

# Invariants

Mortise owns its version line; source builds are immutable and isolated; generated artifacts stay outside live inputs; runtime failures use structured logs.

# Change Impact

Feature owners define their validation commands; developer-kit packaging remains version-matched and separately installable.

Bundled binaries and lockfiles are large shared surfaces; concurrent regeneration can overwrite another build's artifacts.

# Validation

Run the in-memory production Node bundle gate frequently, retain the complete production Electron build in canonical CI, run target-platform packaging separately, and include lightweight project-module lint, monorepo build/check/tests, and `git diff --check` where applicable.
