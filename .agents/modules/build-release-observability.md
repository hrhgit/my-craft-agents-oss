---
schema: module-agent/v1
id: build-release-observability
name: Build Release and Observability
summary: Monorepo configuration, CI, packaging, installers, resources, logging, versioning, and release metadata.
status: active
keywords: [build, release, ci, package, installer, log, version]
owns:
  - .claude-plugin/plugin.json
  - .codex/config.toml
  - .dockerignore
  - .env.example
  - .github/**
  - .gitignore
  - .mortise-config.sync
  - .portmux.json
  - bun.lock
  - bunfig.toml
  - build-developer-kit.cmd
  - build-package.cmd
  - CODE_OF_CONDUCT.md
  - config.json
  - CONTRIBUTING.md
  - Dockerfile.server
  - LICENSE
  - NOTICE
  - package.json
  - 'path.resolve(workspace'
  - README.md
  - SECURITY.md
  - start-quick-test.cmd
  - tsconfig.base.json
  - tsconfig.json
  - UPSTREAM-TRADEMARK.md
  - apps/electron/*.json
  - apps/electron/*.yml
  - apps/electron/*.md
  - apps/electron/*.ts
  - apps/electron/.gitignore
  - apps/electron/.portmux.json
  - apps/electron/build/**
  - apps/electron/eslint-rules/**
  - apps/electron/eslint.config.mjs
  - apps/electron/scripts/**
  - apps/electron/resources/*
  - apps/electron/resources/bin/**
  - apps/electron/resources/icon.icon/**
  - apps/electron/resources/docs/permissions.md
  - apps/electron/resources/docs/themes.md
  - apps/electron/resources/docs/tool-icons.md
  - apps/electron/resources/release-notes/**
  - apps/electron/resources/scripts/**
  - apps/electron/resources/themes/**
  - apps/electron/resources/tool-icons/**
  - packages/shared/src/docs/**
  - packages/shared/src/resources/**
  - packages/shared/src/version/**
  - packages/shared/src/interceptor-common.ts
  - packages/shared/src/interceptor-request-utils.ts
  - packages/shared/src/unified-network-interceptor.ts
  - packages/shared/src/__tests__/**
  - packages/shared/eslint-rules/**
  - packages/shared/eslint.config.mjs
  - packages/shared/src/search/**
  - packages/shared/tests/content-validators.test.ts
  - packages/shared/tests/mode-manager.test.ts
  - packages/shared/tests/persistence-queue.test.ts
  - packages/shared/tests/session-validation.test.ts
  - docs/architecture/logging-candidates.json
  - docs/architecture/legacy-cleanup-inventory.md
  - docs/architecture/optimization-acceptance-checklist.md
  - docs/architecture/optimization-completed-archive.md
  - docs/architecture/optimization-evidence/**
  - docs/architecture/optimization-task-packets.md
  - docs/architecture/pi-session-sidecar-cleanup-manifest-*.md
  - docs/architecture/user-data-cleanup-manifest-*.md
  - docs/architecture/red-line.md
  - docs/future-todo.md
  - scripts/build/**
  - scripts/build-developer-kit.ps1
  - scripts/build-developer-kit.ts
  - scripts/build-package.ps1
  - scripts/build-server.ts
  - scripts/build-source-snapshot.ts
  - scripts/build-wa-worker.ts
  - scripts/docker-smoke-test.sh
  - scripts/electron-build-*.ts
  - scripts/electron-clean.ts
  - scripts/electron-dev.ts
  - scripts/electron-start.ts
  - scripts/e2e/electron-chat/**
  - scripts/generate-dev-cert.sh
  - scripts/install-app.ps1
  - scripts/install-app.sh
  - scripts/install-server.sh
  - scripts/mortise-logs/**
  - scripts/run-isolated-tests.ts
  - scripts/shared-backend-discovery*.ts
  - scripts/start-quick-test.ps1
  - scripts/smoke-developer-kit.ps1
  - scripts/stage-developer-kit-for-installer.ts
  - pi/.gitattributes
  - pi/.github/**
  - pi/.gitignore
  - pi/.husky/**
  - pi/.npmrc
  - pi/.pi/**
  - pi/AGENTS.md
  - pi/*.ps1
  - pi/*.bat
  - pi/*.sh
  - pi/biome.json
  - pi/CONTRIBUTING.md
  - pi/dev/**
  - pi/LICENSE
  - pi/package-lock.json
  - pi/package.json
  - pi/README.md
  - pi/scripts/**
  - pi/tsconfig*.json
related: [apps/electron/src/main/logger.ts, packages/shared/src/utils/runtime-log.ts]
depends_on: [shared-contracts]
collaborates_with: [module-agent-system, ui-validation-developer-kit]
validation:
  - { id: diff-check, kind: unit, command: "git diff --check", description: "Reject malformed working-tree patches.", triggers: [owned-change], required: true, evidence: "Git exit status and whitespace diagnostics." }
  - { id: production-node-bundles, kind: unit, command: "bun run validate:production-node-bundles", description: "Compile production workspace-server, Electron-main, and preload bundles in memory through the production protocol entry.", triggers: [owned-change], required: true, evidence: "Per-target in-memory esbuild completion and elapsed time." }
  - { id: monorepo-contract, kind: contract, command: "bun run pi:build && bun run pi:check", description: "Build the embedded Pi workspaces and verify their package, import, shrinkwrap, and browser-smoke contracts.", triggers: [contract-change], required: true, evidence: "Pi workspace build and contract-check exit status and diagnostics." }
  - { id: pi-workspace-regression, kind: integration, command: "bun run pi:test", description: "Run the embedded Pi workspace regression suites without composing a second CI run.", triggers: [release, runtime-change], required: true, evidence: "Pi package regression exit status and output." }
  - { id: production-bundles, kind: integration, command: "bun run validate:production-bundles", description: "Run the complete production Electron build consumed by packaging.", triggers: [ci-change, release], required: true, evidence: "Production main, workspace server, preload, renderer, and resource build exit status." }
  - { id: ci-integration, kind: integration, command: "bun run validate:ci", description: "Run the repository CI validation composition.", triggers: [release, ci-change], required: true, evidence: "CI validation exit status and output." }
scope_digest: 7dc5d8c5160d0196c679c4de040c14c92e595b45
---

## Purpose
Build, validate, package, diagnose, and release the independently versioned Mortise monorepo.

## Specialist mandate
Own workspace manifests, CI, build scripts, packaging metadata, bundled resources, installers, runtime logging, and version lineage.

## Responsibilities
Maintain reproducible builds, package boundaries, audit workflows, source snapshots, installers, release notes, log sinks, and validation entry points.

## Non-goals
Do not import former upstream changes without explicit direction or own feature behavior merely because it is packaged.

## Contracts and invariants
Mortise owns its version line; source builds are immutable and isolated; generated artifacts stay outside live inputs; runtime failures use structured logs.

## Architecture and entry points
Root scripts orchestrate Bun and Pi workspaces; Electron scripts package desktop assets; CI runs repository validation and audits. `validate:production-node-bundles` is the non-writing high-frequency production compile, `validate:production-bundles` runs the complete Electron build, and `electron:dist:win`, `electron:dist:mac`, and `electron:dist:linux` own target-platform installer generation.

## Collaboration
Feature owners define their validation commands; developer-kit packaging remains version-matched and separately installable.

## Validation
Run the in-memory production Node bundle gate frequently, retain the complete production Electron build in canonical CI, run target-platform packaging separately, and include strict module validation, monorepo build/check/tests, and `git diff --check` where applicable.

## Known risks
Bundled binaries and lockfiles are large shared surfaces; concurrent regeneration can overwrite another build's artifacts.

## Semantic history
- 2026-07-25: Made source identity derive from an empty temporary Git index populated only by declared build inputs, so unrelated tracked files and commit-state transitions cannot enter the immutable capsule or change its identity.
- 2026-07-25: Converged production validation, target packaging, Developer Kit staging, and UI validation on one build-owned immutable Electron producer with closed Bun/Pi dependency capsules, verified external-toolchain caching, SHA-256 artifact manifests, lease-held staging, and no live-checkout fallback; decomposed the full module gate into separately attributed Pi contract, Pi regression, production, and CI commands instead of nesting a duplicate CI run inside one timeout-bound command.
- 2026-07-24: Made the non-writing production Node bundle gate resolve declared Pi workspace exports from their source entries, so a frozen clean checkout compiles every production boundary without pre-existing generated `dist` files.
- 2026-07-24: Replaced the CI package-graph gate's full TypeScript AST traversal with deterministic concurrent source pre-reading, structured dependency preprocessing, and constant-time workspace package resolution, restoring the frozen scan budget without weakening supported import forms.
- 2026-07-24: Archived OPT-010 after current-owner contracts and isolated Electron runs proved workspace-root authority, assistant-backed publication, rejection recovery, restart persistence, and complete cleanup.
- 2026-07-24: Added durable architecture-v2 acceptance manifests so archived optimization claims bind code revisions, routed ownership, reproducible commands, and hashed local evidence without treating ignored output paths as the acceptance record.
- 2026-07-24: Reconciled the legacy cleanup inventory with the completed canonical contracts and kept future user-owned data deletion outside runtime acceptance behind fresh exact-path confirmation.
- 2026-07-24: Removed ownership declarations for the deleted Craft user-data migration scripts and made the packaged workspace thinking default a current Mortise value.
- 2026-07-23: Reframed the active recovery queue as two independently recoverable external packets for a host-neutral schema fix and clean-checkout build/source-start evidence; retained isolated Electron acceptance with the primary because the typed fixture does not seed reserved workspace skill metadata.
- 2026-07-23: Expanded external delegation beyond low-judgment work when scope, architecture direction, acceptance, and recovery are frozen, including complete isolated physical-validation workflows with primary evidence review.
- 2026-07-23: Made external write delegation fail closed on invalid assignment worktrees: primary-supplied clean bases, dedicated worktrees, scoped final commits, clean handoffs, and pre-candidate raw performance baselines are now mandatory acceptance inputs.
- 2026-07-23: Split the optimization program into an active-only ledger, concise grandfathered archive, and owner-bounded delegation packets with reproducible external evidence handoffs and primary architecture-comparison gates.
- 2026-07-23: Recorded OPT-018 as the confirmed Mortise-only headless-runtime architecture: repository-local Pi will shed its independent TUI/CLI product surface while UI-neutral Agent and RPC semantics remain canonical.
- 2026-07-23: Completed the Mortise-only data-root cutover in product documentation and regenerated the packaged Session MCP resource so shipped helpers resolve only `.mortise` roots; independent Pi retains `.pi` defaults.
- 2026-07-23: Added a confirmation-gated exact-path manifest for removing Mortise Session sidecars from the independent Pi Session root without deleting Pi JSONL history.
- 2026-07-23: Verified OPT-008 end to end with deterministic indexed search, bounded renderer metrics, current-build physical deep links, production bundles, and retained evidence.
- 2026-07-23: Made incremental Session search delete through turn-owned segment keys, normalize NFKC by Unicode grapheme cluster for exact equivalent source ranges, and expose structural deletion diagnostics instead of timing-only complexity coverage.
- 2026-07-23: Verified OPT-007 with asynchronous renderer/main layout coordinators, zero storage work on the interaction hot path, foreground narrow resize and drag evidence, and same-profile two-group restart recovery.
- 2026-07-23: Verified OPT-006 after bounded async Pi Session and runtime/specialized log writers passed shutdown, backpressure, concurrency, rotation, event-loop responsiveness, and representative throughput evidence.
- 2026-07-22: Recorded awaited compaction sidecar settlement and settlement-only recovery as automated OPT-005 evidence while retaining the physical five-timeline gate before verification.
