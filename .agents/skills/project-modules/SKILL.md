---
name: project-modules
description: Discover Mortise capability modules through a compact generated catalog, then load only the module documents needed to locate code, reuse existing capabilities, trace related changes, and choose focused validation.
---

# Project Modules

Use this skill for non-trivial repository investigation, implementation, or review. Module documents are a progressive-disclosure knowledge map, not task definitions, agent identities, ownership permissions, or workflow gates.

## Workflow

1. Run `bun run module:catalog` from the repository root.
2. Let the current model select the smallest relevant module set from the summaries, `when_to_read` triggers, and frontend-impact summaries. Do not assign scores or assume that multiple matches require task decomposition.
3. Read each selected `.agents/modules/<id>.md` document in full. Use its entry points, reusable capabilities, invariants, dependencies, consumers, frontend areas, change-impact notes, and validation guidance to bound repository exploration.
4. Prefer existing module capabilities and public entry points over parallel implementations. Search the actual code when the document is incomplete or stale, and report the gap without inventing module facts.
5. After editing, revisit the selected modules' dependencies, consumers, related modules, and validation commands so cross-module effects are not missed.

## Exploration And Delegation

The primary agent performs normal tightly coupled work. A read-only exploration agent is useful only for one independent, evidence-verifiable question whose report will materially reduce primary context; it does not need a writer worktree. Delegate implementation only after interfaces, files, and acceptance are frozen and assignments can proceed without affecting one another. Module selection alone never authorizes delegation.

## Commands

```powershell
bun run module:catalog
bun run module:lint
```

`module:catalog` is read-only and generates the current compact Markdown catalog from module frontmatter. `module:lint` checks only the module knowledge itself: schema, unique IDs, document names, module references, and entrypoint existence. It does not require repository file ownership and writes no lock, digest, plan, receipt, or generated index. If path-to-module lookup later proves useful, generate it as a separate mechanical JSON index rather than expanding the Markdown context.
