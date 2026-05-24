# Tools and Filesystem Errors

These errors usually come from built-in tools such as `bash`, `read`, `write`, `edit`, or `web_fetch`.

## Common messages

### Shell and command execution

- `Command aborted`
- `Command timed out after ... seconds`
- `Command exited with code ...`
- `... terminated by signal ...`

Typical causes:
- command is wrong
- process hung
- timeout too small
- missing executable
- shell environment mismatch

### File reading and editing

- `Offset ... is beyond end of file (... lines total)`
- `Operation aborted`
- `Unknown tool name: ...`

Typical causes:
- invalid `read` offset
- cancelled operation
- tool name typo or unavailable tool

### Web fetch

- `Invalid URL: ...`
- `Redirect response missing Location header from ...`
- `Too many redirects while fetching ...`
- `Failed to fetch ...`
- `Operation aborted`

Typical causes:
- malformed URL
- redirect loop
- blocked or unavailable target
- network interruption

## What to check first

1. Re-run the tool with smaller input.
2. Confirm file path, URL, offset, and command syntax.
3. Increase timeout if the operation is valid but slow.
4. Check whether the target file or URL still exists.
5. If the operation was user-cancelled, `Operation aborted` is expected.

## Relevant file paths

- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/tools/read.ts`
- `packages/coding-agent/src/core/tools/write.ts`
- `packages/coding-agent/src/core/tools/edit.ts`
- `packages/coding-agent/src/core/tools/web-fetch.ts`
- `packages/coding-agent/src/core/tools/index.ts`

## Notes

For shell problems, also inspect the terminal environment, current working directory, and custom shell configuration.
