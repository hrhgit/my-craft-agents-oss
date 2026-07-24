# Mortise Active Optimization Checklist

This is the active-only architecture ledger. Verified work is frozen in
[`optimization-completed-archive.md`](./optimization-completed-archive.md); externally delegable work is specified in
[`optimization-task-packets.md`](./optimization-task-packets.md). Do not put completed evidence or unplanned future ideas back into this file.

**Acceptance gate version:** `architecture-v2` (effective 2026-07-23). Every new or reopened item must use this version and the review-handoff evidence schema.

## Canonical convergence rule

- Migrate every current caller to one Mortise-owned implementation, then remove the replaced runtime, fallback, alias, reader, writer, field, adapter, fixture, and schema. Do not preserve former Craft/upstream compatibility.
- Current-version schema negotiation and capability fencing remain required. User-owned data is never deleted without an exact dated manifest and explicit confirmation.
- The repository `pi/` subtree is an embedded headless Mortise runtime. Independent Pi products, TUI/interactive behavior, standalone CLI identity, and an independent release surface are out of scope.

## Primary acceptance gate

An implementation is accepted only when all applicable checks pass:

1. Every changed file has exactly one routed module owner. Cross-module work declares one canonical authority for each state, protocol, and side effect, and retains a review receipt from every affected owner; joint or implicit ownership is rejected.
2. Positive, negative, and fault-injection tests cover the invariant at its owning boundary.
3. State, protocol, persistence, scheduling, runtime selection, and artifact production each have one authority, and manifest, build, and source-import graphs have an explicit acyclic dependency DAG.
4. Forbidden production symbols, imports, staged files, and packaged artifacts are zero.
5. No fallback, alias, compatibility reader, dual-read, dual-write, or silent migration remains.
6. A disposable checkout or immutable source snapshot at the reported final revision builds with isolated empty caches and no pre-existing outputs. The producer-to-bundle-to-stager-to-installer/runtime hash chain and a negative stale/ignored-artifact probe prove that no untracked or pre-existing input is consumed.
7. The real production bundle and its metafile prove the intended entrypoint and complete dependency graph; target-platform installer evidence is added where packaging is affected.
8. Runtime or physical evidence is proportional to the affected surface. Electron/native changes require Electron/native evidence; WebUI evidence is used only for supported WebUI behavior. A complete physical workflow may be executed by an external agent against a pinned build and isolated or explicitly approved state, but the primary independently reviews the action receipts, semantic/native snapshots, screenshots where visually relevant, logs, processes, persistence results, and cleanup before acceptance.
9. Baseline calibration may establish normal variance, but before observing the final candidate the primary approves and freezes a representative workload/data set, environment, warm/cold mode, metrics and statistics, baseline revision, absolute and relative budgets, and noise rule. Use at least ten independent samples for each non-deterministic base/final distribution; a deterministic exhaustive/static metric may use another pre-approved method with a sufficiency argument. Base and final retain raw samples under the same policy. Relaxing workload, samples, statistics, noise handling, or budget after candidate results are observed invalidates those results; a corrected policy requires fresh base and final runs.
10. For non-mechanical work, the primary freezes a bounded research scope before implementation and retains its queries/sources, candidate inventory, and elimination log. Research identifies the status quo and every materially plausible alternative found. Before evaluating final candidates, the primary also freezes hard constraints, comparison criteria, their priority/weight and tie-breakers. The selected design must satisfy every hard constraint and rank best under that frozen rule while recording disadvantages and uncertainty; omitting or eliminating a candidate requires concrete infeasibility or dominance evidence rather than a strawman assertion.
11. External work returns the complete review handoff defined in `optimization-task-packets.md`; decisive commands, scans, raw artifacts and SHA-256 hashes, revisions, and UI/runtime identities are independently reproducible by the primary reviewer.
12. Every external write is attributable to a primary-supplied clean base and a dedicated worktree, ends in an inspectable scoped commit range with an empty final status, and contains no unrelated commit or file. Shared dirty worktrees, uncommitted handoffs, and ownership claims that cannot be proven from `ASSIGNED_BASE..FINAL_COMMIT` are rejected before behavioral acceptance.

Hard reject any submission that starts from an unverified/shared/dirty worktree, lacks an inspectable scoped commit range, excludes relevant paths from scans, relies on ignored or stale artifacts, weakens/deletes a meaningful test, performs unrelated refactors, adds silent fallback, changes a contract without documenting and testing it, or relaxes a frozen performance/architecture rule after observing candidate results.

## Status vocabulary

- `needs-fix`: implementation or architecture work remains.
- `not-run`: static, architecture, owner-review, and applicable automated gates have found no known defect, but one explicitly named required runtime, installer, or physical gate has not run. No correctness or acceptance conclusion exists until it passes.
- `blocked`: an explicit prerequisite prevents useful progress; record it rather than weakening the invariant.

## Active ledger

| ID | Priority | Status | Canonical authority and required outcome | Remaining proof / exit condition |
|---|---|---|---|---|
| OPT-011 | P1 | blocked | The runtime resolver is the sole binary-selection authority; the build pipeline is the sole producer/stager. Packaged/runtime resolution accepts exactly one compiled, version-compatible Mortise Pi binary and rejects legacy JS candidates and runtime-selection escape hatches. | Resolver/afterPack implementation and 12/12 focused tests exist, but installer proof is blocked by OPT-017's stale/ignored binary input risk. After OPT-017, run `EXT-BR-03` with isolated installer smoke, `runtime.log` path/version evidence, retired-variable rejection, and missing/tampered-binary failure. JS staging and TUI ownership belong to OPT-018. |
| OPT-014 | P1 | needs-fix | Workspace manifests are the sole dependency declarations and the canonical graph validator enforces manifest, build, and source-import DAGs. `session-tools-core` is intentionally host-neutral and may be consumed by `shared`; the forbidden edge is `session-tools-core -> shared`. Do not extract another package. | Manifest, lockfile, and bounded graph changes are present but prior delivery evidence was mixed or baseline-inadmissible; complete `EXT-BR-04` from the frozen clean base and retain the reverse-edge guard, production bundle/metafile, monorepo, and source-development initialization evidence. Installer evidence remains separately blocked by OPT-017. |
| OPT-015 | P1 | needs-fix | `automations`: V3 host/store/protocol is the sole scheduler, occurrence, history, idempotency, import, and dispatch authority. | Primary completes `AUT-P1..P4`; delegates complete `AUT-E1-MSG`, then the atomically integrated `AUT-E1-HSC` + `AUT-E1-SL`, plus `AUT-E2` and final `AUT-E3`. Pass protocol, fault, restart/replay, production-only legacy scan, runtime delivery, and indexed-query performance evidence. |
| OPT-017 | P0 | needs-fix | `build-release-observability`: one canonical producer owns the compiled Pi binary and immutable source/build identity; every production gate builds what packaging consumes. | Repair `bootstrap:ci`/build composition so `copyPiRuntime` cannot consume ignored `pi/packages/coding-agent/dist/pi(.exe)`. Prove disposable-checkout production bundles, full artifact hash provenance, stale-input rejection, concurrent source/build isolation, equivalent-build deduplication, per-run build pinning, bounded retention/GC, packaged smoke, and platform installer generation. |
| OPT-018 | P1 | needs-fix | `pi-coding-runtime` owns a UI-neutral Agent/RPC core; packaging stages only that headless runtime. No TUI, interactive mode, standalone CLI, terminal extension surface, updater, JS fallback, or separate Pi product artifact remains. | Primary completes `HEAD-P1..P3`; delegates run `HEAD-E1..E3`. Preserve Agent Loop, Session, tools, compaction, extension lifecycle, and RPC contract tests; pass import/metafile/staged-artifact guards and before/after performance budgets. |

## Primary-only architecture decisions

- `OPT-017`: choose the canonical Pi binary producer, immutable source snapshot, build identity, concurrent isolation, equivalent-build cache/deduplication, per-run pinning, and bounded retention/GC model.
- `OPT-014`: review the existing contract direction and graph guard. Do not solve it by re-extracting host-neutral contracts from `session-tools-core`.
- `AUT-P1`: make V3 host injection mandatory; no dispatcher-created or fallback host.
- `AUT-P2`: make resource import a host-owned atomic store operation.
- `AUT-P3`: define one canonical V3 renderer DTO and bounded batch protocol.
- `AUT-P4`: define the scheduler/store indexed-query boundary and its complexity budget.
- `HEAD-P1`: define the headless entrypoint and split core from TUI/interactive presentation.
- `HEAD-P2`: separate extension core contracts from terminal APIs and route GUI contributions through versioned host/RPC contracts.
- `HEAD-P3`: integrate the new headless artifact into production staging and removal sequencing.

## Architecture comparison record

For each non-mechanical packet, the primary first freezes and records a bounded discovery scope, including searched sources/queries and stop conditions, then inventories the status quo and every materially plausible alternative surfaced. Before final-candidate results are examined, the primary freezes hard constraints and the priority/weight and tie-breakers for canonical authority and ownership/DAG, state duplication, failure and rollback semantics, concurrency and idempotency, extensibility, performance/resource cost, migration/deletion cost, testability, and observability. The review record retains the discovery and elimination log; links code, trace, prototype, benchmark, or failure evidence; records the selected design's disadvantages and uncertainty; and shows why it ranks best under the frozen rule. The primary independently checks this after the external agent returns.

## Audit procedure

1. Require the structured review handoff, route the task independently, confirm sole file ownership, compare the submitted diff with its task packet, and integrate interdependent owner patches atomically before running cross-owner tests.
2. Verify every claimed caller removal with a production-only scan and inspect exclusions. Inspect ignored/untracked build inputs separately.
3. Run packet-specific positive, negative, fault, architecture, clean-build, bundle/metafile, runtime, and performance evidence in that order.
4. Review architecture independently using the frozen research scope, candidate/elimination log, hard constraints, priorities/weights, and tie-breakers. Confirm that the bounded search did not omit a materially plausible alternative without evidence and that the selected design ranks best overall while its disadvantages remain explicit.
5. Reject partial compatibility, hidden fallbacks, stale artifacts, weakened tests, unrelated cleanup, self-approval, or evidence that cannot be reproduced from the reported revision and identities. Only the primary agent changes an OPT status and archives an item after all evidence is retained.
