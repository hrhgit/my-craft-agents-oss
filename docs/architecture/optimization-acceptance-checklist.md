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
6. A disposable checkout or immutable source snapshot at the reported final revision builds with empty dependency views and no pre-existing outputs. A network download cache may be reused only when the frozen lockfile supplies cryptographic package integrity and the installer materializes every dependency view inside the source capsule; mutable dependency views and build-output caches remain forbidden. The producer-to-bundle-to-stager-to-installer/runtime hash chain and a negative stale/ignored-artifact probe prove that no untracked or pre-existing input is consumed.
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
| _None_ | | | R11 items were accepted and moved to [`optimization-completed-archive.md`](./optimization-completed-archive.md). | Reopen only when a changed contract or failing current gate invalidates a recorded invariant. |

## Frozen architecture decisions

The following choices are integrated and are not open for redesign during r11 closeout. Reopen the smallest owning packet
only when a retained gate demonstrates a concrete defect.

- `OPT-017`: one source-pinned compiled Pi producer, immutable source/build identity, per-run pinning, and bounded retention/GC.
- `OPT-014`: `session-tools-core` remains host-neutral; `shared -> session-tools-core` is allowed and the reverse edge is forbidden.
- `OPT-015`: one mandatory V3 host/store, atomic import authority, canonical renderer DTO/batch protocol, and indexed query boundary.
- `OPT-018`: one UI-neutral Agent/RPC entrypoint and one headless production artifact; terminal/TUI and standalone Pi product surfaces remain absent.

## Architecture comparison record

For each non-mechanical packet, the primary first freezes and records a bounded discovery scope, including searched sources/queries and stop conditions, then inventories the status quo and every materially plausible alternative surfaced. Before final-candidate results are examined, the primary freezes hard constraints and the priority/weight and tie-breakers for canonical authority and ownership/DAG, state duplication, failure and rollback semantics, concurrency and idempotency, extensibility, performance/resource cost, migration/deletion cost, testability, and observability. The review record retains the discovery and elimination log; links code, trace, prototype, benchmark, or failure evidence; records the selected design's disadvantages and uncertainty; and shows why it ranks best under the frozen rule. The primary independently checks this after the external agent returns.

## Audit procedure

1. Require the structured review handoff, route the task independently, confirm sole file ownership, compare the submitted diff with its task packet, and integrate interdependent owner patches atomically before running cross-owner tests.
2. Verify every claimed caller removal with a production-only scan and inspect exclusions. Inspect ignored/untracked build inputs separately.
3. Run packet-specific positive, negative, fault, architecture, clean-build, bundle/metafile, runtime, and performance evidence in that order.
4. Review architecture independently using the frozen research scope, candidate/elimination log, hard constraints, priorities/weights, and tie-breakers. Confirm that the bounded search did not omit a materially plausible alternative without evidence and that the selected design ranks best overall while its disadvantages remain explicit.
5. Reject partial compatibility, hidden fallbacks, stale artifacts, weakened tests, unrelated cleanup, self-approval, or evidence that cannot be reproduced from the reported revision and identities. Only the primary agent changes an OPT status and archives an item after all evidence is retained.
