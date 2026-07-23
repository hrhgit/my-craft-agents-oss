# Legacy Cleanup Inventory

This is an inventory and decision record for the Mortise full-migration work. The final choice for every unresolved former Craft/upstream compatibility question is option A: converge current callers on canonical Mortise behavior and remove the replaced compatibility code. This is not a deletion script. No user data or local configuration is removed until the path is re-scanned, the runtime reference check is green, a dated absolute-path manifest exists, and the user explicitly confirms that manifest.

Completed cleanup record: [`user-data-cleanup-manifest-2026-07-23.md`](./user-data-cleanup-manifest-2026-07-23.md). The frozen 135-path manifest was explicitly confirmed and removed with post-delete protection checks; the older 2026-07-21 snapshot remains an unapproved historical inventory only.

## Decision Rules

- Former Craft/upstream readers, writers, aliases, fallbacks, fields, adapters, schemas, fixtures, artwork, configuration formats, and migration runtimes are not product requirements.
- Current callers must move to the canonical Mortise contract before the replaced implementation is deleted; do not preserve dual-read, dual-write, or offline import paths solely for disposable legacy data.
- Current Mortise versioned schema negotiation and capability fencing remain required.
- Local user directories such as `.mortise`, `.pi`, and workspace data are never deleted by repository tests, build scripts, migrations, or application startup.
- Destructive cleanup requires a dated manifest containing exact absolute paths and explicit user confirmation. Repository code removal does not grant permission to delete matching user-owned files.

## Candidate Inventory

| Path or symbol | Current role | Decision | Required follow-up |
|---|---|---|---|
| Former Craft user-data migration script and test | Removed; legacy data has no import path | Complete | Production reference scan is empty; clean Mortise startup remains part of final runtime evidence |
| `packages/core/src/types/plan-artifact.ts` legacy marker and `createLegacyPlanArtifact` | Removed; only the versioned `PlanArtifactV1` contract is projected and the retired marker is rejected | Complete | Canonical artifact and Session projection tests cover current behavior without stored-session migration |
| `packages/session-tools-core/src/tool-defs.ts` legacy tool prefixes | Removed; only canonical tool names are accepted | Complete | Current callers use canonical names and retired prefixes are rejected |
| `packages/session-tools-core` `workingDirectory` compatibility input | Removed; current Session create and metadata mutation boundaries reject the retired field | Complete | Workspace root is the sole authority and negative contract coverage remains required |
| `apps/cli/src/index.ts` `providerType: 'pi_compat'` | Removed; current CLI setup emits only canonical `pi` or `pi_custom` classifications | Complete | CLI regression coverage locks the current provider contract without migrating old references |
| `packages/messaging-gateway/src/binding-store.ts` JSON migration reader and legacy fields | Removed; the messaging SQLite record store is the sole authority and old JSON remains untouched | Complete | SQLite authority tests cover absent, edited, and non-materialized compatibility files |
| `packages/shared/src/config/storage.ts` global `config.json` / `drafts.json` mirrors and `.sync` baselines | Removed; `state.sqlite` is the sole global configuration and draft authority | Complete | Old files are ignored and preserved; SQLite CAS, capability fencing, validators, and profile cloning use the current record contract |
| `packages/shared/src/workspaces/storage.ts` workspace `config.json` mirror, import, alias normalization, and `.mortise-config.sync` | Removed; workspace records live only in `state.sqlite` | Complete | Current records are strictly validated, retired aliases are rejected without rewriting their record, and old workspace-local files remain untouched |
| Extension `remoteui_request`, `extension_widget`, scalar responses, and `legacy-widget:*` adapters | Removed; Interaction V1 and Contribution V1 are the only extension UI protocols | Complete | Cross-boundary tests and renderer/native `mortise-ui` evidence cover the current protocol |
| `packages/messaging-gateway/src/gateway.ts` legacy transcript event filter | Removed; the gateway consumes canonical Pi projection events without historical ingress filtering | Complete | Messaging projection regressions and the production source scan lock the current event path |
| `packages/server-core/src/sessions/SessionManager.ts` `pickCraftSessionMetadata` and legacy `think` normalization | Removed; current restore, JSONL ingress, and explicit Session creation reject retired thinking values | Complete | Canonical metadata readers and negative create/restore tests remain the only supported path |
| `packages/server-core/src/bootstrap/headless-start.ts` legacy lock sentinel handling | Removed; live registrations require the current versioned server-registry protocol | Complete | Current registration, unsupported-version cleanup, and PID-reuse tests cover the supported concurrency boundary |
| `docs/architecture/red-line.md` and migration sections in protocol docs | Architecture history and current migration policy | Keep documentation; not runtime compatibility | Update wording after deletion decisions, do not treat historical text as active code scope |
| Local former Craft/upstream artwork, configuration, session, `.mortise/`, `.pi/`, and workspace data paths | User-owned data outside the runtime compatibility contract | No compatibility or migration requirement; never touch automatically; only exact confirmed paths are eligible for cleanup | This is not an active code blocker; any future deletion still requires a fresh dated absolute-path manifest and explicit confirmation |

## Required Evidence Before Deletion

1. `rg` reference scan shows no active production import or ingress for the candidate.
2. Current callers, fixtures, and supported current-Mortise data use the canonical contract; disposable former Craft/upstream data need not be exported or migrated.
3. `bun run validate:monorepo`, affected module tests, production bundle validation, and a clean-install smoke run pass with the candidate absent and unsupported legacy data ignored or rejected as specified.
4. For user-owned filesystem cleanup, exact absolute paths, ownership/category, and estimated sizes are recorded in a dated deletion manifest.
5. The user explicitly confirms that manifest; only then may a destructive cleanup command be run. Code deletion never substitutes for this confirmation.
