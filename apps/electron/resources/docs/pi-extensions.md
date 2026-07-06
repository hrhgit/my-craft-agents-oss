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
5. The renderer (`ExtensionWidgetZone`, `PlanProgressWidget`, etc.) renders
   each string as a line. **The Pi `theme` object never leaves the child
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
