# Mortise Optimization Task Packets

These packets isolate externally executable work whose scope, architecture direction, acceptance, and recovery boundary are frozen. Delegation may cover substantial implementation, research, build, performance, or physical validation when it saves primary-agent context or token cost; difficulty alone is not an exclusion. The primary agent retains cross-owner integration, architecture decisions not already frozen by a packet, evidence audit, remediation, and all OPT status changes.

## R11 final closeout packets

The implementation packets below remain the requirement history, but they must not be redispatched merely because their
epic is still active. At the `7100b7a5d` handoff, the remaining work is organized by shared evidence boundary so a new
session can finish without repeating the same build or installer workflow per OPT ID.

| Packet | Covers | Prerequisite | Execution and evidence | Concurrency rule |
|---|---|---|---|---|
| `R11-C0` candidate stabilization | Global gate prerequisite | r11 worktree at `7100b7a5d` with only the recorded locale repair present | Review the three-file locale repair, run its focused tests and parity/sorted checks, refresh `shared-ui-i18n`, commit it, prove a clean worktree, and record the resulting `CODE_CANDIDATE`. | Sole `shared-ui-i18n` writer; no other tracked edits. |
| `R11-C1` canonical green | All five OPT IDs | `CODE_CANDIDATE` frozen | Run strict module validation and complete `bun run validate:monorepo`; retain command, environment, exit status, full log, and SHA-256. A failure returns to the sole owning module and creates a new candidate. | May prepare manifests in parallel; do not run performance sampling concurrently. |
| `R11-C2A` automation performance | `OPT-015` | `R11-C1` green and the pre-approved automation workload/policy unchanged | Run base/final indexed-query samples under the frozen workload, environment, sample count, statistics, baseline, budgets, and noise policy. Retain raw JSON/logs and hashes. | Run alone; no builds, packaging, or other benchmarks. |
| `R11-C2B` headless performance | `OPT-018` | `R11-C2A` complete and the pre-approved headless workload/policy unchanged | Run base/final process-to-handshake, RSS, first-turn, and artifact measurements; retain raw samples, teardown/process proof, budget result, and hashes. | Run alone; intentionally serial after `R11-C2A`. |
| `R11-C3` joint Windows installer acceptance | `OPT-011`, `OPT-014`, `OPT-017`, `OPT-018` | `R11-C1` green; performance sampling not active | Run `electron:dist:win` once from `CODE_CANDIDATE`. In one isolated install, prove manifest/hash provenance, runtime selection and tamper failures, clean dependency/build graph, optional Developer Kit selected/deselected behavior, one headless staged runtime, zero legacy artifacts, installed-app start/restart, logs/processes, uninstall, and cleanup. | One packaging owner and one isolated profile; evidence may be reviewed by each affected owner after collection. |
| `R11-C4` evidence and integration | All five OPT IDs | `R11-C1..C3` green | Generate raw-evidence SHA-256 manifests, perform affected-owner review, archive accepted items, remove all five from the active ledger, refresh named module digests, and integrate the scoped r11 commit range without overwriting user-owned primary-worktree changes. | Documentation/module updates may be prepared in parallel, but only the primary accepts and integrates. |

The critical path is `R11-C0 -> C1 -> C2A -> C2B -> C3 -> C4`. `C3` is one joint physical workflow, not four
independent installer runs. If `C1`, `C2A`, or `C2B` changes tracked implementation, discard all later candidate-bound
evidence and restart at `C1`; a documentation-only archive/digest commit after acceptance does not redefine
`CODE_CANDIDATE`.

## Delegation contract

Every delegated assignment must copy one packet unchanged and add only the assigned agent, dedicated worktree path, and primary-supplied `ASSIGNED_BASE` commit. Any reviewed prerequisite must already be committed into that base; do not hand an external writer an uncommitted prerequisite patch. Give each write packet one exclusive writer. The agent must route the task, read the sole owner module in full, edit only the listed files, and preserve unrelated changes.

Before reading implementation files or editing anything, the external writer must retain a preflight receipt containing `git rev-parse --show-toplevel`, `git rev-parse HEAD`, `git status --porcelain=v1 --untracked-files=all`, and `git worktree list --porcelain`. The reported root and `HEAD` must exactly match the assignment, the status output must be empty, and the worktree must not be the primary/shared integration worktree. If any check fails, return `blocked: invalid assignment worktree` without modifying files. A prose assurance that unrelated changes were left untouched is not a substitute for this receipt.

Every write packet finishes as an inspectable commit, preferably one task commit, with no unrelated commits in `ASSIGNED_BASE..FINAL_COMMIT`. Before handoff, retain `git diff --name-status ASSIGNED_BASE..FINAL_COMMIT`, `git diff --stat ASSIGNED_BASE..FINAL_COMMIT`, `git diff --check ASSIGNED_BASE..FINAL_COMMIT -- <exact write files>`, and a final empty `git status --porcelain=v1 --untracked-files=all`. Uncommitted working-tree output, a shared dirty worktree, a final revision equal to an unrelated moving branch tip, or a mixed diff is `not ready for review` even when tests pass.

External agents do not edit `.agents/modules/*.md`, refresh scope digests, change OPT status, or integrate another owner's patch unless a packet explicitly lists that file. They report semantic/module-record impact; the primary performs affected-owner review, atomic cross-owner integration, module-history updates, and digest refresh after final contents settle.

The primary reviewer applies the acceptance gate in the active checklist. Passing tests alone is insufficient. Reject changes that expand file scope without approval, invent compatibility, alter a public schema, consume ignored artifacts, weaken tests, or make unrelated refactors.

Physical validation may be assigned externally when the packet pins the source/build identity, isolated profile or explicitly approved state, platform/viewport, complete action sequence, expected invariants, teardown, and required semantic/native/screenshot/log/process evidence. The external agent executes the complete workflow and collects evidence; the primary reviews it and makes the acceptance decision. Never use real user data or destructive operations merely to save review effort.

Minimal dispatch prompt:

```text
Execute <PACKET_IDS> from docs/architecture/optimization-task-packets.md. Work only in <ASSIGNED_WORKTREE> at <ASSIGNED_BASE>. Run the mandatory worktree preflight before reading implementation files; stop without edits if it fails. Follow the packet unchanged, commit only its scoped files, leave a clean worktree, and return the required handoff plus raw evidence. Do not self-accept or refresh module records.
```

## Required review handoff

Return one concise Markdown report plus referenced raw artifacts. A missing section, an unexplained scope change, or a claimed gate without reproducible evidence means `not ready for review`; the implementing agent never marks its own packet accepted.

### 1. Identity and state

Report the packet ID, assigned owner module, `completed` / `partial` / `blocked` implementation state, exact `ASSIGNED_BASE`, exact `FINAL_COMMIT` for write packets, dedicated branch/worktree, preflight-receipt path, final-clean-status receipt, relevant build/profile identity, and environment details needed to reproduce runtime or performance results. Follow with a 2-5 bullet change summary and the retained `ASSIGNED_BASE..FINAL_COMMIT` name-status/stat. Evidence-only packets may report `no implementation commit`. Separate implementation state from validation state; do not paste a full diff when the commit range is directly inspectable.

### 2. Requirement-to-change map

Use a table with these columns:

| Packet requirement | What changed | Final file + symbol/current line | Direct evidence |
|---|---|---|---|

List every changed file, including tests, generated manifests, and lockfiles. Use symbol names plus current final-revision line anchors; do not substitute a diff-stat or prose summary for precise locations. Report any required module-history/digest update for the primary without modifying the module record. State `no implementation change` for evidence-only packets.

### 3. Architecture and flow

- Name the canonical authority before and after the change, the permitted dependency direction, the removed authority/fallback/alias/dual path, and any intentionally unchanged boundary.
- Confirm separately that the packet did not introduce a second store, scheduler, runtime, reader/writer, migration path, compatibility adapter, or hidden artifact input.
- For cross-process, cross-module, asynchronous, persistence, concurrency, or failure-path changes, include one compact Mermaid flow showing owners, calls/data, commit or settlement points, and error/rollback edges. A pure rename, manifest declaration, or isolated fixture cleanup may state `diagram not applicable` with one reason.
- External packets follow the canonical direction already stated in the packet. If implementation requires a new architecture choice or a public-contract change, stop and escalate instead of selecting an alternative.

### 4. Reproducible evidence ledger

Use a table with these columns:

| Gate | Exact command or action sequence | Result + counts/duration | Raw artifact/log path | Unrun reason |
|---|---|---|---|---|

Include all applicable positive, negative, fault-injection, caller/zero-reference, architecture, clean-build, production bundle/metafile, runtime/physical, and performance gates. For scans, record every root and exclusion. For clean-build or packaging claims, use a disposable checkout/source snapshot with isolated empty caches and no pre-existing outputs; record source revision, producer/input/bundle/staged/installed artifact SHA-256 hashes, ignored/untracked-input checks, a stale-input negative probe, and generated inventory. Record each retained artifact's SHA-256 in the ledger. Keep full logs or machine-readable receipts at stable paths; quote only the decision-relevant excerpt in the report. Never hide a failed, flaky, skipped, timed-out, unsupported, or not-run gate.

Every write packet records `git diff --check ASSIGNED_BASE..FINAL_COMMIT -- <exact write files>` as an unconditional gate with its exit code and complete summary, even when the packet-specific command list does not repeat it. Running working-tree `git diff --check` against an untracked file does not satisfy this gate.

For performance evidence, baseline calibration may measure variance, but the primary approves and freezes the representative workload/data, machine and environment, warm/cold mode, metrics and statistics, baseline revision, absolute and relative budgets, and noise policy before observing the final candidate. The assignment must include the baseline revision and retained raw baseline artifacts; an external agent may not invent, reconstruct, or quote an undocumented baseline after seeing the candidate. Use at least ten independent samples for each non-deterministic base/final distribution; another method is allowed only for a deterministic exhaustive/static metric with a pre-approved sufficiency argument. Compare base and final with the same method and retain raw samples. Clear only transient cache explicitly owned by the measured workload; do not flush operating-system caches, allocate memory to pressure caches, or relabel a failed cache-clearing attempt as a cold sample. If the supplied baseline cannot be reproduced, stop as `blocked` before measuring the final candidate. If any rule is relaxed after candidate results are seen, discard those samples and rerun fresh base and final measurements under a newly frozen policy.

### 5. UI and actual-operation proof

For UI packets, report the actual user/agent action sequence and the isolated run/profile/build identity. Behavioral or state claims require bounded semantic snapshots or structure trees plus action/result receipts. Visual composition claims require before/after screenshots with viewport and surface identity; native claims require native evidence. A screenshot alone does not prove state, persistence, accessibility, process, or protocol behavior. Report an unavailable evidence surface explicitly rather than substituting WebUI evidence for Electron or native behavior.

### 6. Residual risk and handback

List unresolved dependencies, assumptions, deliberate omissions, remaining matching symbols/artifacts and why each is valid, failed/unrun gates, performance deltas, and unrelated dirty-worktree files left untouched. End with `ready for primary review`, `partial`, or `blocked`, not `accepted`. The primary independently reroutes the diff, inspects the dependency and lifecycle boundaries, reproduces decisive evidence, and records the accept/reject reason.

## Execution order

1. Prepare `EXT-BR-01-HSC`, then let `EXT-BR-01-BR` generate the Electron manifest and lockfile in a private integration worktree containing the HSC patch; the primary publishes all three files atomically. `EXT-BR-02` is otherwise independent.
2. For the V2 automation entry, run `AUT-E1-MSG` as the caller/interface preflight. The primary then freezes `executeAutomationPromptAction` as the canonical V3 replacement and assigns `AUT-E1-HSC` and `AUT-E1-SL` against the same base. Those two removal patches are integrated atomically; neither agent may design a bridge or merge a temporarily incompatible interface.
3. Run `AUT-P1`; then `AUT-P2` and `AUT-P4` may proceed in parallel; run `AUT-P3` after their contracts settle. Run `AUT-E3` only after all three `AUT-E1` packets, `AUT-E2`, and `AUT-P1..P4` are integrated.
4. Resolve `OPT-017`'s canonical binary producer and clean-checkout build defect before `EXT-BR-03`; otherwise installer evidence can accidentally certify a stale ignored executable.
5. Run the pre-split half of `HEAD-E1` before `HEAD-P1`. Complete `HEAD-P1`, then `HEAD-P2`, then `HEAD-P3`. After the OPT-017 producer is integrated, run the post-split half of `HEAD-E1`, followed by `HEAD-E2` and finally `HEAD-E3`. Only one `build-release-observability` writer may modify shared build entrypoints at a time.
6. The primary agent runs route/impact review, clean-checkout production gates, surface-proportional runtime acceptance, and the active checklist audit after each epic converges.
7. In the current recovery pass, `EXT-BR-04` is evidence-only and leaves source unchanged.

## Assignment queue

The queue assumes the primary has first frozen a base revision and assigned isolated worktrees. “Ready” means the packet has no unresolved architecture choice, not that the current dirty worktree is safe to share.

| Queue | Packets | Release condition |
|---|---|---|
| Ready for current external execution | `EXT-BR-04` | Use the exact primary-frozen base and dedicated worktree. This evidence-only packet returns no source commit and leaves its worktree clean. |
| Awaiting a new primary-frozen packet or prerequisite | `AUT-E1-MSG`, `AUT-E2`, pre-split `HEAD-E1` | Do not reuse an older assignment implicitly. The primary must confirm the current base, exact scope, and evidence inputs before dispatch. |
| Evidence blocked by primary architecture | `AUT-E1-HSC`, `AUT-E1-SL`, `AUT-E3`, post-split `HEAD-E1`, `HEAD-E2`, `HEAD-E3` | Primary freezes the V3/headless/producer boundaries and completes the listed sequencing before dispatch. |
| Evidence blocked by clean binary producer | `EXT-BR-03` | OPT-017 producer is integrated and a clean source-built runtime is available; no ignored executable is accepted as evidence. |

## External packets

### EXT-BR-01-HSC - Declare the server-core test-only Pi dependency

- **Epic / class:** OPT-014 / manifest-only dependency repair.
- **Prerequisite / order:** First manifest packet; prepare an owner-only patch against the primary's frozen base. Do not publish it alone. The primary supplies it to `EXT-BR-01-BR` in a private integration worktree and publishes all three manifest/lockfile changes atomically.
- **Sole owner module:** `headless-server-cli`.
- **Exact files:** `packages/server-core/package.json`; read-only witness `packages/server-core/src/sessions/sendmessage-durability.test.ts`.
- **Objective:** Declare `@mortise/pi-coding-agent` as the server-core test/build-only dependency required by the witness import.
- **Canonical direction:** Use the existing workspace package identity and the manifest section that expresses test/build-only use; preserve the production dependency DAG.
- **Forbidden deviations:** Do not edit `bun.lock`, Electron manifests, production imports, graph-test exclusions, or add a runtime dependency.
- **Commands / evidence:** Server manifest/import scan; focused `sendmessage-durability.test.ts`; server type check; record the expected integrated lockfile gate as pending rather than changing another owner's file; `git diff --check`.
- **Primary acceptance:** After atomic integration, the server test import is declared in the correct non-runtime section, the frozen install is green, and the manifest diff contains no other dependency churn.
- **Stop / escalate:** Stop if the package manager cannot express a test-only workspace edge without changing the production graph; ask the primary agent to decide the package boundary.

### EXT-BR-01-BR - Declare the Electron test dependency and freeze the lockfile

- **Epic / class:** OPT-014 / manifest and lockfile integration.
- **Prerequisite / order:** Use the primary's private integration worktree containing the reviewed `EXT-BR-01-HSC` patch; do not publish that intermediate state. The primary lands server manifest, Electron manifest, and lockfile atomically after this packet returns.
- **Sole owner module:** `build-release-observability`.
- **Exact files:** `apps/electron/package.json`; `bun.lock`; read-only witness `apps/electron/src/main/ui-validation/__tests__/session-validation-backend.test.ts`.
- **Objective:** Declare `@mortise/pi-coding-agent` as Electron's test/build-only dependency and regenerate the frozen lockfile for the approved Electron and server-core manifest changes.
- **Canonical direction:** Use the existing workspace package identity and established test/build-only manifest section; preserve the production dependency DAG and one canonical lockfile.
- **Forbidden deviations:** Do not edit server-core files, move witness imports into production, add runtime coupling, suppress graph diagnostics, or accept unrelated lockfile churn.
- **Commands / evidence:** Frozen `bun install --lockfile-only`; focused Electron witness and server witness tests; package-graph test; manifest/lockfile semantic diff; `git diff --check`.
- **Primary acceptance:** Both approved imports are declared, runtime manifests remain free of unnecessary Pi edges, all three graphs are acyclic, and the lockfile contains only the two intended workspace edges.
- **Stop / escalate:** Stop if install resolves unrelated versions, rewrites unrelated lockfile sections, or changes the production graph; return the semantic diff without normalizing it away.

### EXT-BR-02 - Bound package-graph execution and diagnostics

- **Epic / class:** OPT-014 / test-infrastructure hardening.
- **Prerequisite / order:** Independent; land before using the graph test as final evidence.
- **Sole owner module:** `build-release-observability`.
- **Exact files:** `scripts/build/__tests__/workspace-package-graph.test.ts` only.
- **Objective:** Replace Bun's accidental 5-second ceiling with an explicit bounded budget and report the slow/failing phase, package, and file.
- **Canonical direction:** Keep one AST-based canonical graph test covering manifest runtime, manifest build/dev, and source imports. Prefer deterministic sorted diagnostics and elapsed phase timings.
- **Forbidden deviations:** Do not use an unbounded timeout, skip source files, downgrade assertions, add retry-on-failure, or split into divergent graph implementations.
- **Commands / evidence:** On base and final revisions, run one warmup plus at least ten warm measured samples and three samples after clearing only the test's own transient cache; run `bun run test:build-validation`; retain raw wall/phase timings and the predeclared budget.
- **Primary acceptance:** The budget is at least 2x the base warm p95 but remains finite, failures name the responsible phase/path, and final warm/cold distributions have no more than 5% unexplained regression from the recorded baseline.
- **Stop / escalate:** Stop if scans exhibit nonlinear growth, exceed the proposed budget, or require a root command change; report profiling evidence or request a separately approved `package.json` expansion instead of hiding the problem.

### EXT-BR-03 - Isolated compiled-runtime installer evidence

- **Epic / class:** OPT-011 / evidence-only packaging acceptance.
- **Prerequisite / order:** Blocked until OPT-017 builds the Pi binary from the pinned clean source identity. Run after resolver and afterPack tests are green.
- **Sole owner module:** `build-release-observability`.
- **Exact files (read/execute only):** `packages/shared/src/agent/backend/internal/runtime-resolver.ts`; `packages/shared/src/agent/backend/__tests__/runtime-resolver.test.ts`; `apps/electron/scripts/copy-assets.ts`; `apps/electron/scripts/validate-assets.ts`; `apps/electron/scripts/afterPack.cjs`; `apps/electron/scripts/afterPack.test.ts`; `apps/electron/electron-builder.yml`; generated target-platform installer and isolated `%MORTISE_CONFIG_DIR%/logs/runtime.log`.
- **Objective:** Prove an installed clean build starts only the compiled, version-compatible runtime and fails explicitly when it is absent or invalid.
- **Canonical direction:** Build installer from a clean immutable source/build identity; install into an isolated target/profile; record executable hashes, packaged path, version/capabilities handshake, and structured runtime selection log.
- **Forbidden deviations:** Do not copy a local ignored binary, reuse the user's profile, set a hidden fallback path, accept a JS candidate, or edit product code to make the smoke pass.
- **Commands / evidence:** Focused resolver and afterPack tests; target-platform installer command; artifact inventory/hash; isolated installed launch with retired resolver variables set and unset; filtered `runtime.log`; clean process/profile teardown.
- **Primary acceptance:** The installer contains exactly one compiled runtime, logs its expected path/version, ignores retired selectors, exposes no JS candidate, and missing/tampered binary tests fail explicitly.
- **Stop / escalate:** Stop if provenance cannot be tied to the clean build identity, signing/install authority is unavailable, or the installer consumes any pre-existing runtime.

### EXT-BR-04 - Clean-checkout dependency, bundle, and source-start acceptance

- **Epic / class:** OPT-014 / evidence-only clean-build acceptance.
- **Prerequisite / order:** Run from the exact primary-frozen revision in a dedicated clean worktree with no pre-existing dependencies or build outputs. Installer certification remains blocked by OPT-017.
- **Sole owner module:** `build-release-observability`.
- **Exact source scope (read/execute only):** root and workspace manifests; `bun.lock`; `pi/package-lock.json`; canonical build/graph/production-bundle entrypoints; source-only `mortise-ui` initialization path. Retained logs and inventories may be written only to ignored output or an external evidence directory.
- **Objective:** Produce attributable clean-revision evidence that dependency declarations, the canonical package graph, build validation, production Node bundles, monorepo validation, and a source-development Electron initialization all operate from declared inputs without source edits or stale checkout artifacts.
- **Required sequence:** Retain the clean preflight and ignored/untracked inventory; run `npm --prefix pi ci --ignore-scripts` and `bun install --frozen-lockfile`; audit both lockfiles and the manifest/lockfile edges for the Electron/server-core Pi test dependency while proving `session-tools-core` has no `@mortise/shared` edge; run `bun run test:build-validation`; run `bun run validate:production-node-bundles`; run `bun run validate:monorepo`; start one background fixture Electron run with source `mortise-ui`, retain its immutable build identity/status/semantic-ready snapshot, then stop it and verify process/profile cleanup.
- **Evidence:** Exact commands, exit codes, durations, complete logs, source revision, environment/tool versions, pre/post ignored/untracked inventories, lockfile hashes, produced Node bundle/metafile hashes and provenance, package-graph diagnostics, monorepo sub-gate counts, `mortise-ui` build/run identity, startup logs, semantic readiness receipt, cleanup/process receipt, and final empty tracked/untracked Git status.
- **Primary acceptance:** Frozen installs make no lockfile/source change; both manifest graphs and source-import graph are acyclic; intended test-only edges are declared without runtime coupling; production Node bundles originate from the assigned revision; monorepo validation and source-development initialization are green; no stale ignored input is silently accepted for any claim made by this packet.
- **Forbidden deviations:** No source/manifest/lockfile edits, lockfile regeneration, test weakening, cache substitution, reuse of another worktree's dependencies/output, ignored binary claimed as source-built installer evidence, WebUI substitution for Electron startup, or unreported skipped/failed gate.
- **Known blocked gate:** Do not claim installer or packaged-runtime acceptance while OPT-017 still permits an ignored/stale Pi binary input. Record installer evidence as `blocked by OPT-017` unless the assigned base already contains a separately accepted canonical source-pinned producer.
- **Stop / escalate:** Stop the affected gate and retain diagnostics if a frozen install changes files, a build consumes unowned/stale output, source initialization cannot identify its pinned build, or cleanup leaves a process/profile behind. Continue only independent gates whose evidence remains valid.

### AUT-E1-MSG - Prove messaging no longer depends on the V2 prompt entry

- **Epic / class:** OPT-015 / interface preflight and owner-local cleanup.
- **Prerequisite / order:** First AUT-E1 packet. Its evidence is the prerequisite for the primary to authorize interface removal.
- **Sole owner module:** `messaging`.
- **Exact files:** `packages/messaging-gateway/src/registry.ts` only.
- **Objective:** Prove messaging does not call `executePromptAutomation` or consume `ExecutePromptAutomationInput`, and update stale owner-local comments to the current V3 delivery/binder terminology.
- **Canonical direction:** Messaging is a typed ingress/client of the injected V3 automation host; it does not own a prompt compatibility dispatcher.
- **Forbidden deviations:** Do not edit server interfaces/SessionManager, add an adapter, or choose a replacement API. Escalate any real caller.
- **Commands / evidence:** Messaging production scan for both symbols; focused messaging automation/topic tests; messaging type check; `git diff --check`.
- **Primary acceptance:** Zero messaging callers, owner-local comments name the current boundary, and behavior tests remain unchanged.
- **Stop / escalate:** Stop immediately if another messaging production caller exists or topic binding is not represented by V3; return its exact location so the primary can issue a separate owner-bounded packet.

### AUT-E1-HSC - Remove the V2 server interface contract

- **Epic / class:** OPT-015 / headless interface removal.
- **Prerequisite / order:** After `AUT-E1-MSG` and explicit primary confirmation that `executeAutomationPromptAction` is the frozen canonical V3 contract. Prepare against the same base as `AUT-E1-SL`; primary integrates both atomically.
- **Sole owner module:** `headless-server-cli`.
- **Exact files:** `packages/server-core/src/handlers/session-manager-interface.ts`.
- **Objective:** Remove `ISessionManager.executePromptAutomation`, `ExecutePromptAutomationInput`, and its compatibility documentation.
- **Canonical direction:** The server contract exposes the current V3 action boundary only. This packet does not design or modify that boundary.
- **Forbidden deviations:** No temporary alias, optional legacy method, overload, adapter type, or changes outside the interface owner.
- **Commands / evidence:** Export/caller scan; headless-server contract tests; expected cross-owner compile dependency recorded for atomic integration; `git diff --check`.
- **Primary acceptance:** Interface/export scans contain no V2 symbol after atomic integration, and current V3 interface tests pass.
- **Stop / escalate:** Stop if the primary has not frozen the replacement interface or another production implementer/caller appears.

### AUT-E1-SL - Remove the V2 Session implementation

- **Epic / class:** OPT-015 / Session implementation removal.
- **Prerequisite / order:** After `AUT-E1-MSG` and the same primary interface confirmation as `AUT-E1-HSC`. Prepare against the same base; primary integrates both atomically.
- **Sole owner module:** `session-lifecycle`.
- **Exact files:** `packages/server-core/src/sessions/SessionManager.ts`; `packages/server-core/src/sessions/automation-prompt-delivery.test.ts`.
- **Objective:** Remove the `ExecutePromptAutomationInput` import, `executePromptAutomation` implementation, and only its V2-specific tests.
- **Canonical direction:** Preserve `executeAutomationPromptAction` and its new/fixed/trigger/isolated V3 delivery semantics. Keep ordinary new-Session mechanics private.
- **Forbidden deviations:** Do not expose `executeNewAutomationSession`, create an alias, route old inputs silently, or weaken V3 tests.
- **Commands / evidence:** Session caller scan; focused automation prompt/session tests; server type check after atomic integration with `AUT-E1-HSC`; zero-symbol scan; `git diff --check`.
- **Primary acceptance:** V2 implementation/import/tests are absent, V3 behavior remains covered, and removed input shapes are not adapted.
- **Stop / escalate:** Stop if any current production caller exists or V2-only behavior lacks a primary-approved V3 equivalent.

### AUT-E2 - Replace the deleted automation test mock

- **Epic / class:** OPT-015 / test-fixture repair.
- **Prerequisite / order:** The Session fixture prerequisite is complete. Confirm the current V3 host fixture API; complete before AUT-E3.
- **Sole owner module:** `native-desktop`.
- **Exact files:** `apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts`.
- **Objective:** Remove mock exports for deleted `AutomationSystem`, `AUTOMATIONS_CONFIG_FILE`, and `automations.json`; supply only the minimal V3 host surface the branch test actually loads.
- **Canonical direction:** Prefer the real current module for unrelated exports and a narrowly typed deterministic V3 host fixture for the tested boundary.
- **Forbidden deviations:** Do not resurrect deleted names, add broad `any` compatibility, skip module initialization, or change branch-production behavior.
- **Commands / evidence:** Isolated branch rollback test; Electron type check; source scan proving the retired names remain only in explicit negative architecture tests.
- **Primary acceptance:** The test fails when its required V3 contract changes, passes without legacy exports, and production imports are untouched.
- **Stop / escalate:** Stop if the test requires a large replica of the V3 scheduler/store; refactor the test seam with the primary owner instead of building a shadow runtime.

### AUT-E3 - Production-only legacy automation guard

- **Epic / class:** OPT-015 / architecture regression guard.
- **Prerequisite / order:** Last automation packet, after `AUT-E1-MSG`, `AUT-E1-HSC`, `AUT-E1-SL`, `AUT-E2`, and AUT-P1..P4.
- **Sole owner module:** `automations`.
- **Exact files:** new `packages/shared/src/automations/legacy-production-architecture.test.ts` only.
- **Objective:** Fail when retired automation scheduler/store/export/filename/dispatcher-fallback symbols re-enter production.
- **Canonical direction:** Scan parsed production source and the production bundle/metafile. Explicit negative-test fixtures may contain denylisted strings; generated and test files must not satisfy production absence.
- **Forbidden deviations:** Do not blanket-exclude directories, scan only hand-picked files, snapshot a stale bundle, or treat comments/tests as production violations.
- **Commands / evidence:** Focused guard; V3 runtime/store/host suites; `validate:production-node-bundles`; zero-hit report with enumerated roots/exclusions.
- **Primary acceptance:** A mutation probe demonstrates every denylist category fails; canonical V3 symbols remain allowed; production bundle and source both pass.
- **Stop / escalate:** Stop if the denylist would encode an unresolved architecture choice or the canonical gate does not discover this test; primary must finalize the contract or dispatch the build-release owner instead of editing `package.json` from this packet.

### HEAD-E1 - Reproducible headless performance baseline

- **Epic / class:** OPT-018 / benchmark harness and evidence.
- **Prerequisite / order:** Capture pre-split evidence before HEAD-P1 and post-split evidence after HEAD-P3 using the same host and fixture.
- **Sole owner module:** `pi-coding-runtime`.
- **Exact files:** new `pi/packages/coding-agent/scripts/measure-headless-runtime.mjs`; `pi/packages/coding-agent/package.json`; generated JSON evidence outside committed source.
- **Objective:** Emit machine-readable artifact size, cold process-to-RPC-handshake time, idle RSS, active RSS, and deterministic first-turn latency for the production headless entrypoint.
- **Canonical direction:** Pin source/build identity, executable hash, OS/CPU, sample count, warmup, fixture, and timeout; report raw samples plus median/p95. Use a deterministic provider/fixture already supported by Mortise validation.
- **Forbidden deviations:** No live-user profile, network-dependent baseline, mixed entrypoints, hidden warm process, single-sample conclusion, or post-hoc metric omission.
- **Commands / evidence:** Run at least one warmup and ten measured samples on both base and final revisions; retain JSON and stderr; verify teardown and no child processes; compare each metric against the predeclared active-checklist budget.
- **Primary acceptance:** Harness failures are explicit and bounded, results are reproducible, post-split behavior is functionally equivalent, and every metric meets its frozen budget (default relative ceiling 5%). A different budget was frozen after baseline calibration but before the final-candidate run; no post-result exception is accepted.
- **Stop / escalate:** Stop if no deterministic first-turn fixture exists or OS process metrics are unreliable; primary chooses a supported fixture/metric substitute before data collection.

### HEAD-E2 - Headless import and production-metafile guard

- **Epic / class:** OPT-018 / post-split architecture guard.
- **Prerequisite / order:** After HEAD-P1..P3 establish the final headless entrypoint and after the OPT-017 producer/build-entrypoint changes are integrated; before packaging cleanup acceptance. No other `build-release-observability` writer may edit `package.json` concurrently.
- **Sole owner module:** `build-release-observability`.
- **Exact files:** new `scripts/build/__tests__/headless-runtime-boundary.test.ts`; `scripts/build/__tests__/production-bundle-validation.test.ts`; `package.json` only to include the guard in the canonical build-validation gate.
- **Objective:** Prove the headless source closure and real production metafile contain no TUI, interactive, standalone CLI, terminal theme/session picker, updater, or legacy JS runtime module.
- **Canonical direction:** Derive reachability from the canonical entrypoint and production metafile, using normalized module identities and an explicit denylist. Test both clean success and injected forbidden-edge failure.
- **Forbidden deviations:** Do not rely on filename substring scans alone, omit dynamic imports, inspect a test-only bundle, or exclude Pi source wholesale.
- **Commands / evidence:** Focused guard with mutation fixture; `bun run test:build-validation`; `bun run validate:production-node-bundles`; retained dependency-path diagnostics for injected failures.
- **Primary acceptance:** Zero forbidden reachable modules/artifacts, deterministic diagnostics show the full offending path, and the allowed UI-neutral Agent/RPC contracts remain in the graph.
- **Stop / escalate:** Stop if the canonical entrypoint or denylist is still unsettled; HEAD-P1/P2 must decide those boundaries.

### HEAD-E3 - Final legacy staging removal

- **Epic / class:** OPT-018 / mechanical packaging cleanup.
- **Prerequisite / order:** Last; only after the headless artifact exists, HEAD-P3 selects it, and HEAD-E2 is green.
- **Sole owner module:** `build-release-observability`.
- **Exact files:** `scripts/build/common.ts`; `scripts/build-server.ts`; `scripts/build/__tests__/production-bundle-validation.test.ts`.
- **Objective:** Remove `stagePiRuntime` JS staging, interactive/TUI file lists, and the server call that copies them; retain only canonical headless staging owned by HEAD-P3.
- **Canonical direction:** Delete the replaced staging path completely and strengthen production asset tests to reject its files.
- **Forbidden deviations:** Do not leave a compatibility function, environment switch, alias, dual staging, fallback copy, or delete source TUI code before the owning Pi split has migrated required semantics.
- **Commands / evidence:** Zero-reference scan; focused production-build tests; production Node bundle/metafile; staged server/Electron asset inventory from a clean source build; `git diff --check`.
- **Primary acceptance:** No legacy staging symbol or staged TUI/JS artifact remains, the headless runtime is the only Pi artifact, and both server and Electron production entrypoints start through it.
- **Stop / escalate:** Stop if any production entrypoint still consumes the old staged layout; HEAD-P3 must migrate that caller first.

## Primary-only work

External agents may collect evidence or review a proposal, but they must not choose or implement these boundaries without a new owner-specific packet from the primary agent.

| ID | Affected owner modules | Canonical decision and non-negotiable boundary |
|---|---|---|
| AUT-P1 | automations | Inject one mandatory workspace V3 host into dispatchers. No dispatcher constructs, discovers, or silently falls back to another host. |
| AUT-P2 | automations | Import extension/resource definitions through one host-owned atomic store transaction with validation, optimistic concurrency, idempotent operation identity, and no secondary reader/writer. |
| AUT-P3 | automations | Define one versioned renderer DTO and bounded batch/change protocol; renderer state is a projection, never another scheduler/store. |
| AUT-P4 | automations | Define indexed scheduler/store queries for due occurrences, workspace definitions, and run history, with explicit cardinality and latency budgets. |
| HEAD-P1 | pi-coding-runtime + pi-agent-engine | Establish the dedicated headless Agent/RPC entrypoint and move TUI/interactive presentation outside its dependency closure without reinterpreting Agent Loop semantics. |
| HEAD-P2 | pi-coding-runtime + extension-runtime + extension-ui | Keep extension lifecycle/tools host-neutral; remove terminal component/render APIs from the embedded contract and use versioned host-rendered GUI contributions. |
| HEAD-P3 | pi-coding-runtime + build-release-observability | Sequence production staging so the new headless artifact becomes canonical before any legacy entrypoint or asset is removed. No dual-runtime steady state. |
| OPT-017 producer | build-release-observability + pi-coding-runtime | Select one source-pinned binary producer and immutable build identity; clean CI/bootstrap must build it before packaging, and no ignored `dist/pi(.exe)` may be an input. |
| OPT-014 review | shared-contracts + session-tooling + build-release-observability | Keep `session-tools-core` host-neutral. `shared -> session-tools-core` is allowed; `session-tools-core -> shared` is forbidden. Enforce acyclicity without another package extraction. |

## Primary review record

For every returned packet, record: acceptance-gate version; base/final revision; routed owner per file; canonical authority per state/protocol/side effect; files and symbols changed; caller scan; positive/negative/fault evidence; frozen architecture research scope and discovery/elimination log; candidate set plus frozen hard constraints/priorities and comparison result; clean-build provenance and artifact hashes; production bundle/metafile result; runtime/physical evidence; pre-approved frozen performance policy, raw samples and delta; rejected deviations; affected-module review receipts; raw evidence manifest path/hash; and final accept/reject reason. An accepted packet may still leave its epic open until all primary-only work and end-to-end evidence are complete.
