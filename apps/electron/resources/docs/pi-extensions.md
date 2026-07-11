# Pi Extensions Development Guide

This guide describes how Pi extensions render widgets inside the Craft shell,
and the `renderFn` contract that keeps Pi and Craft decoupled.

> **Theme boundary:** Pi extensions render to a plain `string[]`. They never
> touch the Craft GUI theme, the DOM, or Electron APIs. For the full theme
> boundary, see [themes.md](./themes.md).

## Execution Model

Pi extensions run inside the `Pi RpcClient` **child process** — a separate
Node process spawned by the Craft main process. The child process wraps the
`@earendil-works/pi-coding-agent` SDK and communicates with the main process
using a line-delimited JSON (JSONL) protocol over stdio.

Because extensions run in the child process, they have **no access** to:

- The Craft Electron renderer (no `window`, no `document`, no React)
- `window.electronAPI.*` or any IPC channel
- The Craft GUI theme object (the 6-color OKLCH palette)
- Node APIs of the main process

They only see what Pi SDK passes them: the extension context `ctx`, whose `ui`
facet is a bridged `ExtensionUIContext`.

## Registering a Widget

An extension publishes a widget by calling:

```ts
ctx.ui.setWidget(key, renderFn, { placement })
```

## Calling Craft Host Capabilities

Craft-targeted extensions request desktop functionality through Pi's typed
capability client. Extensions never import Electron APIs or Craft IPC modules.

```ts
pi.declareCapabilities([
  { capability: 'files.pick', operations: ['open'] },
])

const result = await ctx.capabilities.invoke<{ paths: string[] }>(
  'files.pick',
  'open',
  { mode: 'file', extensions: ['md'] },
  { timeoutMs: 30_000, signal: ctx.signal },
)

if (result.status === 'success') {
  // Use result.output.paths
}
```

The initial Electron host providers are:

| Capability | Operation | Input |
|---|---|---|
| `system.notification` | `show` | `{ title, body }` |
| `files.pick` | `open` | `{ title?, mode?, multiple?, extensions? }` |
| `files.preview` | `read` | `{ path, maxBytes? }` (workspace-bounded, max 2 MiB) |
| `browser.open` | `navigate` | `{ url, focus? }` |
| `browser.control` | `back`, `forward`, `focus`, `hide`, `close` | `{ instanceId }` (session-owned instances only) |
| `browser.operate` | `snapshot`, `click`, `fill`, `type`, `select`, `screenshot`, `wait`, `key`, `scroll`, monitoring | Session-owned browser input; executable page evaluation is excluded |
| `oauth.flow` | `begin`, `status`, `cancel`, `revoke` | Host-managed flow references only |
| `credentials.keychain` | `has`, `remove` | Current-workspace source references only |
| `session.share` | `status`, `publish`, `refresh`, `revoke` | Current session only |
| `session.transfer` | `export-summary`, `import-summary` | Bounded summary DTO only |
| `messaging.session` | `status`, `list-bindings`, `pair`, `unbind` | Current session; no bot credentials |
| `automation.workspace` | `status`, `list`, `set-enabled` | Sanitized summaries and stable IDs |
| `scheduler.workspace` | `status`, `list`, `set-enabled` | Sanitized scheduler summaries |
| `webhook.workspace` | `status`, `list`, `set-enabled` | No URL, request body, test, replay, or execution access |

The Craft host owns authorization, workspace/session routing, timeout,
cancellation, audit logging, and platform support. A provider can return
`denied`, `cancelled`, `unsupported`, or `failed`; extensions must handle these
statuses without falling back to direct host access. Session and workspace
identity always come from the host route and cannot be supplied in `input`.

Host authorization is fail-closed and operation-specific. An extension must
declare each capability and operation before invoking it; declarations are
bound to the current session, runtime, and extension and are cleared when the
runtime exits. Provider registration and declaration alone do not grant
mutating operations: Host policy can still deny or prompt the user. OAuth token
reads, page script evaluation, clipboard access, arbitrary file upload, and raw
webhook execution are not part of the capability policy.

Extension UI contributions use the versioned `ExtensionContributionV1` side
channel. Contributions are declarative text/Markdown/JSON blocks, actions,
prompts, or inspector panels. React components, DOM nodes, HTML, scripts, and
executable renderer code are rejected by the Host validator.

| Argument | Type | Description |
|----------|------|-------------|
| `key` | `string` | Stable widget identifier (e.g. `'plan-todos'`, `'repo-memory'`). Re-calling with the same `key` replaces the widget; calling with `content === undefined` removes it. |
| `renderFn` | `(width: number, theme: PiTheme) => string[]` | Pure render function. See [renderFn Contract](#renderfn-contract). |
| `placement` | `'aboveEditor' \| 'belowEditor'` | Where the widget appears. `'belowEditor'` (default) renders between the editor and the input box. `'aboveEditor'` is reserved. |

To remove a widget, call `ctx.ui.setWidget(key, undefined)`.

## renderFn Contract

```ts
type renderFn = (width: number, theme: PiTheme) => string[]
```

### Parameters

#### `width: number`

Terminal width in **characters** (columns). Provided by the child process at
render time. Use it to wrap/align output so the widget fits the available
horizontal space. Do not assume a fixed width.

#### `theme: PiTheme`

The **Pi TUI theme object** — terminal-oriented colors and text styles. Owned
and populated by Pi. Use it (not the Craft GUI theme) for any color/style
decisions inside the render function.

`theme` is supplied by the child process; extension authors should treat it as
opaque/read-only and only read the documented fields.

### Return Value

A plain `string[]` — **one string per rendered line**.

```ts
// OK
return ['☑ step one', '☐ step two', '2 tasks total']

// Wrong — do not return a single multi-line string
return ['☑ step one\n☐ step two\n2 tasks total']
```

### Rules

1. **Return only plain strings.** Each array element is one visual line. The
   child process forwards the array verbatim as `extension_widget.content`.

2. **ANSI escape codes are allowed** for color/style (the Craft renderer
   downgrades them to plain text). Do **not** emit other control characters
   (cursor movement, `\r`, `\b`, terminal bell, etc.) — they will not render
   correctly in the GUI.

3. **Do not depend on the Craft GUI theme.** The 6-color OKLCH palette
   (`~/.craft-agent/theme.json`) is not visible to extensions. Use the `theme`
   argument for all color/style decisions.

4. **Do not access the DOM, `window`, or Electron APIs.** Extensions run in the
   child process; none of these exist there. Any interactive UI (select,
   editor, confirm) must go through `ctx.ui.*` / `pi.events.emit('remoteui:request')`,
   which the child process bridges to the renderer.

5. **Keep `renderFn` pure and synchronous.** It must produce the `string[]`
   from `(width, theme)` alone — no fetches, no IPC, no reads from the Craft
   config. Side effects will be lost (the renderer only sees the returned
   array).

## How the `string[]` Reaches the GUI

The end-to-end flow (for reference; extension authors do not need to implement
any of this):

1. Extension calls `ctx.ui.setWidget(key, renderFn, { placement })`.
2. The child process's bridged `ExtensionUIContext` (built on Pi SDK's
   `createHeadlessUIContext`) invokes `renderFn(width, theme)` and resolves it
   to `string[]`.
3. The child process emits a JSONL message:
   `{ type: 'extension_widget', key, content: string[], placement, source }`.
4. The Craft main process relays the message to the renderer over IPC
   (`extensions:event` channel).
5. The renderer's generic `ExtensionWidgetZone` surfaces render each string as
   a line. Structured Craft features can define a separate versioned custom
   message protocol instead. **The Pi `theme` object never leaves the child
   process.**

## Example

```ts
// A minimal widget that shows a todo list, themed via the Pi TUI theme.
export function activate(ctx) {
  ctx.ui.setWidget('my-todos', (width, theme) => {
    const done = '☑'
    const pending = '☐'
    const lines = [
      `${done} write docs`,
      `${pending} ship feature`,
    ]
    // Respect width: truncate overly long lines.
    return lines.map(l => l.length > width ? l.slice(0, width - 1) + '…' : l)
  }, { placement: 'belowEditor' })
}
```

## Common Mistakes

| Mistake | Why it breaks | Do this instead |
|---------|---------------|-----------------|
| Returning a multi-line string instead of `string[]` | The renderer treats each element as one line | Split into one element per line |
| Reading `window.electronAPI.getTheme()` | No `window` in the child process | Use the `theme` argument |
| Emitting cursor-control ANSI codes | Renderer only supports color/style ANSI | Emit color/style ANSI only, or plain text |
| Calling `fetch`/IPC inside `renderFn` | `renderFn` must be pure/synchronous | Compute state before calling `setWidget` |
| Importing Craft GUI theme types | Breaks the decoupling contract | Treat `theme` as the only theme source |

## See Also

- [themes.md](./themes.md) — TUI vs GUI theme boundary and the `string[]` decoupling protocol
- [skills.md](./skills.md) — Craft workspace skills (separate from Pi extensions)

## Host OAuth and Credential Capabilities

Desktop extensions can request OAuth through `ctx.capabilities` without ever
receiving OAuth codes or credential values:

```ts
const flow = await ctx.capabilities.invoke('oauth.flow', 'begin', {
  sourceSlug: 'github',
})
// flow: { flowId, status: 'pending', userAction: 'open_authorization' }

const current = await ctx.capabilities.invoke('oauth.flow', 'status', {
  flowId: flow.flowId,
})
```

`begin` and `revoke` require Host confirmation. The Electron Host opens the
system browser, owns PKCE/state/callback handling, exchanges the code, and
writes credentials. Extensions may only receive a flow reference, status,
safe account label, or stable error code. `complete`, raw authorization URLs,
OAuth state, codes, tokens, client secrets, and credential values are not part
of the capability protocol.

`credentials.keychain/has` and `credentials.keychain/remove` operate only on
source credential references in the active session workspace. They return
booleans and cannot read or write secret values. Removal requires Host
confirmation.
