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
  - apps/electron/resources/bridge-mcp-server/**
  - apps/electron/resources/icon.icon/**
  - apps/electron/resources/docs/permissions.md
  - apps/electron/resources/docs/themes.md
  - apps/electron/resources/docs/tool-icons.md
  - apps/electron/resources/release-notes/**
  - apps/electron/resources/scripts/**
  - apps/electron/resources/themes/**
  - apps/electron/resources/tool-icons/**
  - packages/shared/src/docs/**
  - packages/shared/src/release-notes/**
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
  - scripts/migrate-legacy-craft-user-data.ts
  - scripts/migrate-legacy-craft-user-data.test.ts
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
  - { id: monorepo-contract, kind: contract, command: "bun run validate:monorepo", description: "Verify monorepo package and dependency contracts.", triggers: [contract-change], required: true, evidence: "Validation exit status and diagnostics." }
  - { id: production-bundles, kind: integration, command: "bun run validate:production-bundles", description: "Run the complete production Electron build consumed by packaging.", triggers: [ci-change, release], required: true, evidence: "Production main, workspace server, preload, renderer, and resource build exit status." }
  - { id: ci-integration, kind: integration, command: "bun run validate:ci", description: "Run the repository CI validation composition.", triggers: [release, ci-change], required: true, evidence: "CI validation exit status and output." }
scope_digest: c0cc88cfb38acacd9068a359eb6ec2e12857e74e
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
- 2026-07-20: Layered production validation into a fast non-writing Node bundle gate, a complete Electron build in canonical CI, and target-platform installer commands outside ordinary cross-platform validation.
- 2026-07-20: Removed the retired Data Sources bridge server and source-specific OAuth build inputs from application and server packaging while retaining the generic session MCP server.
- 2026-07-18: Integrated Pi history and completed monorepo CI runtime setup.
- 2026-07-19: Established independent Mortise product and release lineage.
