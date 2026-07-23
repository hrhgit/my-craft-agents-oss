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
| `packages/core/src/types/plan-artifact.ts` legacy marker and `createLegacyPlanArtifact` | Reads historical plan-shaped messages | Delete marker, reader, and mapper fallback without stored-session migration | Move current callers/fixtures to the canonical artifact contract; add removed-marker rejection coverage |
| `packages/session-tools-core/src/tool-defs.ts` legacy tool prefixes | Removed; only canonical tool names are accepted | Complete | Current callers use canonical names and retired prefixes are rejected |
| `packages/session-tools-core` `workingDirectory` compatibility input | Ignores a former session-level cwd authority | Delete from DTOs, handlers, and all import/disposal parsers | Keep workspace root as the sole authority and add removed-field rejection coverage for `OPT-010` |
| `apps/cli/src/index.ts` `providerType: 'pi_compat'` | Legacy provider classification | Delete branch, stored-value reader, and fixtures without migrating old references | Keep canonical `pi` selection only and verify typed rejection of the retired value |
| `packages/messaging-gateway/src/binding-store.ts` JSON migration reader and legacy fields | Reads older binding/config files into canonical storage | Delete JSON fallback and legacy fields without importing old configuration | Verify SQLite is the sole authority, current callers use its schema, and startup ignores unsupported legacy files |
| `packages/shared/src/config/storage.ts` global `config.json` / `drafts.json` mirrors and `.sync` baselines | Removed; `state.sqlite` is the sole global configuration and draft authority | Complete | Old files are ignored and preserved; SQLite CAS, capability fencing, validators, and profile cloning use the current record contract |
| `packages/shared/src/workspaces/storage.ts` workspace `config.json` mirror, import, alias normalization, and `.mortise-config.sync` | Removed; workspace records live only in `state.sqlite` | Complete | Current records are strictly validated, retired aliases are rejected without rewriting their record, and old workspace-local files remain untouched |
| Extension `remoteui_request`, `extension_widget`, scalar responses, and `legacy-widget:*` adapters | Removed; Interaction V1 and Contribution V1 are the only extension UI protocols | Complete | Cross-boundary tests and renderer/native `mortise-ui` evidence cover the current protocol |
| `packages/messaging-gateway/src/gateway.ts` legacy transcript event filter | Suppresses historical event names | Delete filter after current producers use canonical Pi projection events; do not retain historical ingress compatibility | Add source/contract guards proving current producers emit only canonical events |
| `packages/server-core/src/sessions/SessionManager.ts` `pickCraftSessionMetadata` and legacy `think` normalization | Historical naming/field normalization in session restore | Delete compatibility reader and normalization without session corpus migration | Move current fixtures/callers to canonical fields and reject retired fields at the contract boundary |
| `packages/server-core/src/bootstrap/headless-start.ts` legacy lock sentinel handling | Protects concurrent old backend instances | Delete legacy sentinel branch; retain only current Mortise protocol negotiation and capability fencing | Verify supported current Mortise versions negotiate/fence incompatible writes without the former-backend sentinel |
| `docs/architecture/red-line.md` and migration sections in protocol docs | Architecture history and current migration policy | Keep documentation; not runtime compatibility | Update wording after deletion decisions, do not treat historical text as active code scope |
| Local former Craft/upstream artwork, configuration, session, `.mortise/`, `.pi/`, and workspace data paths | User-owned runtime data, some of which may still be current Mortise data | No compatibility or migration requirement; never touch automatically; only exact confirmed paths are eligible for cleanup | Generate a dated manifest with absolute paths, ownership/category, and estimated size; review it and obtain explicit confirmation before manual delete/archive |

## Required Evidence Before Deletion

1. `rg` reference scan shows no active production import or ingress for the candidate.
2. Current callers, fixtures, and supported current-Mortise data use the canonical contract; disposable former Craft/upstream data need not be exported or migrated.
3. `bun run validate:monorepo`, affected module tests, production bundle validation, and a clean-install smoke run pass with the candidate absent and unsupported legacy data ignored or rejected as specified.
4. For user-owned filesystem cleanup, exact absolute paths, ownership/category, and estimated sizes are recorded in a dated deletion manifest.
5. The user explicitly confirms that manifest; only then may a destructive cleanup command be run. Code deletion never substitutes for this confirmation.
