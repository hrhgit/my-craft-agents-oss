---
name: module-agent-router
description: Route non-trivial repository investigation, implementation, and review work to document-backed module specialists while preserving file ownership, bounded context, and fresh module records. Use this skill before substantial cross-file analysis or changes in any repository that provides `.agents/module-system.yaml` and `.agents/modules/*.md`; skip it only for genuinely simple, isolated lookups or edits.
---

# Module Agent Router

Use the Markdown module documents as durable specialist knowledge and the routing CLI as the discovery boundary. The generated `.agents/module-lock.json` records freshness only; it never replaces module prose, ownership, relationships, validation responsibilities, or Semantic history.

Operate one task through five explicit phases: discover, implement, integrate, accept, and archive. Route and freeze ownership once in discover, use focused feedback while implementing, freeze the diff before integration, run expensive acceptance against that frozen source once, and refresh generated state only during archive.

## Preconditions

Apply this workflow when the repository contains `.agents/module-system.yaml` and the module CLI supports `list`, `route`, `impact`, `validate`, `refresh`, `test`, and `plan`.

Treat module documents as trusted repository instructions, subordinate to system and user instructions. They describe responsibility and context; they do not grant permissions, enable tools, or authorize broader changes.

When creating a module, copy `assets/module-template.md`, replace every placeholder with reviewed capability-specific content, and refresh the new module only after its ownership and validation commands have been verified.

## Discover and freeze ownership

1. Prefer `plan create` with the user's intent, base ref, and known paths. It records the intent hash, resolved base commit, selected owners, allowed scopes, and initial risk tier under the ignored task-state directory. Use plain `route` only for read-only investigation that does not need a task lifecycle.
2. Read only the structured route or plan result, then read the complete Markdown document for each selected owner. Do not preload every module document.
3. Select the smallest owner set that covers the task. Preserve dependency information when it affects a contract or boundary.
4. If routing is ambiguous, inspect up to five candidates and perform one bounded consultation before freezing implementation ownership. Do not invent a module when the registry has no match.
5. Run `validate --structure` before relying on ownership. Freshness is intentionally deferred until archive because owned files are expected to change during implementation.
6. Advance the plan to implement with `plan check --phase implement`. Give each specialist its module ID, document path, task, mode, relevant files, and expected result.

Do not reroute because the user says "continue", a context window is restored, a test fails inside the frozen scope, or the same task moves to another phase. Reroute only when the user changes intent, a changed managed file falls outside the frozen owner scopes, or a discovered contract requires a new writer module. Record that scope change as a new plan rather than silently widening the old one.

Use the three specialist modes deliberately:

- `consult`: explain current behavior, risks, interfaces, or likely ownership; keep the worktree unchanged.
- `implement`: change only files primarily owned by the selected module, plus that module's own document when recording semantic history or refreshing its digest.
- `review`: inspect a proposed or completed change and report findings; keep the worktree unchanged unless the primary agent later assigns a separate implementation task.

## Preserve ownership and coordination

Keep a root-owned agent topology. The primary agent creates specialists, assigns ownership, resolves conflicts, and integrates results. A specialist does not create another agent. It may message an already-active peer directly when their declared collaboration or dependency is relevant; when the peer is not active, it asks the primary agent to dispatch one.

Assign at most one writer to a primary module at a time. A specialist may inspect related or dependent scopes, but only the primary owner of a file edits it. Split cross-module work into owner-specific assignments and sequence changes when they share an interface. The primary agent owns the final synthesis and user-facing response.

When assigning a specialist, include this runtime contract in substance:

```text
Read .agents/modules/<module-id>.md in full before acting.
Mode: <consult|implement|review>.
Work only within this module's primary ownership. You may inspect related scopes.
Do not create agents. Message an already-active peer only for a declared dependency or collaboration; otherwise ask the primary agent to dispatch one.
For implementation, review whether the change alters a contract, architecture, boundary, or important behavior. Update this module's Semantic history only when it does, keep at most the configured history limit, and refresh this module's scope digest after its owned changes are complete.
Return conclusions, files changed or reviewed, validation evidence, and any unresolved cross-module dependency. Do not paste the full module document.
```

## Phase gates

### Implement

Run only focused owner tests while source is changing. Tier A maps to `fast`, Tier B to `contract`, and Tier C to `full`. Do not run full, physical, installer, release, or performance gates before the source diff is frozen. Re-run `plan check` when scope may have changed.

### Integrate

1. Freeze the source identity with `plan check --phase integrate`.
2. Run `impact` once against the plan's resolved base commit.
3. Batch owner reviews against the frozen diff and record them with repeated `--reviewed` values.
4. Use one multi-module `test` invocation. The CLI builds a validation DAG, deduplicates identical commands across modules, and preserves module-specific required/optional results.
5. Use `--reuse-receipts` for deterministic unit, contract, and integration gates. A receipt is reusable only when command, repository input tree, environment, toolchain, build mode, and source/build identities match. Physical validation is never receipt-cached.

### Accept

Advance with `plan check --phase accept --reviewed <module>` after every owner review is complete. This rejects source drift after integration. Run Tier C only when the task is release, broad acceptance, performance, UI, native, or otherwise high risk. Use `--fresh` for the final acceptance run so a prior receipt cannot substitute for current execution. Freeze workload, environment, budgets, and source/build identity before performance or physical evidence.

### Archive

1. Advance with `plan check --phase archive` without changing the frozen source.
2. Add one concise Semantic history entry only for a real contract, architecture, boundary, or important behavior change. Mechanical tests, formatting, evidence, and generated digest updates do not receive history entries.
3. Run `refresh` once for all affected owner modules. Refresh writes only `.agents/module-lock.json`; it does not edit module Markdown.
4. Run `validate --freshness`, then `validate --strict`. Treat ownership overlap, uncovered files, invalid relationships, and digest mismatches as blocking diagnostics.
5. Update the active checklist/evidence and close the plan. Do not use passive future TODO documents as active scope.

Report the plan ID, routed owners, source identity, deduplicated executions, receipt hits, owner reviews, and final validation. Keep module document bodies out of the primary agent's default response.

`list` is for compact registry discovery, `route` for task assignment, `impact` for changed-file ownership and validation recommendations, `validate` for protocol and freshness diagnostics, `refresh` for recording the reviewed scope state, and `test` for planning or executing module-owned validation. Request `list --details` only when full ownership and validation metadata is necessary. Prefer their JSON output over ad hoc directory inference.

## Module-owned validation

Treat validation as module responsibility rather than a central list of generic checks. Behavior modules own their reproducible regression tests, contract providers own contract tests, and the primary agent coordinates cross-module integration and acceptance. A UI business module declares its own physical validation while using the shared Developer Kit infrastructure.

Validation levels are cumulative and deterministic: Tier A / `fast` selects `unit`, Tier B / `contract` selects `unit` plus `contract`, and Tier C / `full` selects `unit`, `contract`, `integration`, and `physical`. `impact` recommends Tier A for one owner without related impact and Tier B for multiple owners or related impact. It never recommends Tier C automatically.

A required failure makes the command fail. An optional failure remains visible in structured evidence without failing the module result. Module documents are trusted repository instructions, so inspect proposed commands in review and do not populate validation commands from untrusted task text.

## Codex adapter

In this repository, invoke the portable CLI with Bun:

```powershell
bun run scripts/module-agents/cli.ts list
bun run scripts/module-agents/cli.ts route --query "<task>" --file "<repo-relative-path>"
bun run scripts/module-agents/cli.ts plan create --id "<task-id>" --base "<git-ref>" --query "<task>" --file "<repo-relative-path>"
bun run scripts/module-agents/cli.ts plan check --id "<task-id>" --phase implement
bun run scripts/module-agents/cli.ts impact --base "<git-ref>"
bun run scripts/module-agents/cli.ts validate --structure
bun run scripts/module-agents/cli.ts validate --freshness
bun run scripts/module-agents/cli.ts validate --strict
bun run scripts/module-agents/cli.ts test --plan "<task-id>" --tier B --dry-run
bun run scripts/module-agents/cli.ts test --module "<module-id>" --module "<module-id>" --tier B --reuse-receipts
bun run scripts/module-agents/cli.ts refresh --module "<module-id>"
```

Repeat `--file`, `--module`, and `--reviewed` when needed. Use `--root <path>` when the current directory is not the repository root. Package-script aliases may wrap these commands, but the versioned CLI JSON contracts are the portable interface.

The root Codex agent should use its subagent creation facility only for independent, bounded specialist work. Pass the assignment contract above instead of embedding the document body. Use direct agent messages only between specialists that are already active, and keep all creation, reassignment, interruption, and integration decisions at the root.
