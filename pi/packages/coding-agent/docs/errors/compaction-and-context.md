# Compaction and Context Errors

These errors usually mean the conversation is too large for the active model, or pi failed while trying to summarize and compact prior context.

## Common messages

- `Context overflow recovery failed after one compact-and-retry attempt`
- `Context overflow recovery failed: ...`
- `Summarization failed: ...`
- `Turn prefix summarization failed: ...`
- `Auto-compacting...`

## What they usually mean

### Context overflow

The active model cannot fit the current conversation, tool output, and attachments into its context window.

Typical causes:
- long session history
- large tool outputs
- many attachments or pasted files
- using a smaller-context model

pi treats context overflow differently from transient provider errors. It attempts compaction instead of plain retry.

### Summarization failed

Compaction itself needs a model call. If that summarization call fails, compaction can fail too.

Typical causes:
- provider error during summarization
- context still too large even after trimming
- temporary upstream failure during compaction

## What to check first

1. Manually run `/compact`.
2. Reduce very large tool outputs or restart from a new session.
3. Switch to a larger-context model.
4. Check whether auto-compaction is enabled.
5. If compaction itself keeps failing, inspect provider stability.

## Operational guidance

- Use `/tree` or `/fork` to continue from an earlier message.
- Start a fresh session if the current one has too much irrelevant history.
- Avoid sending huge command outputs when they are not needed.

## Related files

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/src/core/compaction/branch-summarization.ts`
- `packages/coding-agent/docs/compaction.md`
- `packages/coding-agent/docs/settings.md`
