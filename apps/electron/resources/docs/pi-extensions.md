# Pi Extensions Development Guide

Pi extensions can change Craft's GUI without shipping code inside Craft. The extension owns the UI declaration and command handlers; Craft owns rendering, layout, validation, permissions, recovery, and fallback.

## Execution And Trust Boundary

Extensions execute in Pi's child process. They cannot access Craft's React tree, `window`, `document`, Electron IPC, credentials, global CSS, or the parent DOM. GUI communication is versioned JSONL through `ExtensionUIContext`.

Use native contributions for persistent GUI and existing dialog methods for modal interaction:

- `ctx.ui.upsertContribution(definition)` creates or replaces a stable contribution.
- `ctx.ui.removeContribution(id)` removes one contribution.
- `ctx.ui.clearContributions()` removes all contributions owned by the current extension runtime.
- `ctx.ui.select`, `confirm`, `input`, and `editor` request host-owned dialogs.
- `ctx.ui.notify` requests a host notification.

Always check `ctx.ui.capabilities.contributions`. It is `true` in the Craft RPC host and `false` in TUI/unsupported hosts.

## Minimal Native GUI

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.ui.capabilities.contributions) return
    ctx.ui.upsertContribution({
      schemaVersion: 1,
      id: 'build-status',
      surface: 'composer.above',
      priority: 20,
      collapse: 'auto',
      overflow: 'collapse',
      content: {
        type: 'row',
        gap: 'small',
        children: [
          { type: 'icon', name: 'loader', label: 'Building' },
          { type: 'text', text: 'Building workspace', tone: 'muted' },
          {
            type: 'button',
            label: 'Cancel',
            action: { kind: 'command', command: 'build-cancel' },
          },
        ],
      },
    })
  })

  pi.registerCommand('build-cancel', {
    description: 'Cancel the current build',
    handler: async (_args, ctx) => {
      // Cancel extension-owned work here.
      ctx.ui.removeContribution('build-status')
    },
  })
}
```

A complete example is distributed with Pi at `examples/extensions/craft-gui.ts`.

## Surfaces

Main conversation surfaces have the highest freedom:

| Surface | Intended use |
|---|---|
| `conversation.timeline.before/after` | Session-level content around the timeline |
| `conversation.turn.before/after/replace` | UI around a target assistant turn |
| `conversation.message.before/after/replace` | UI attached to a target message |
| `conversation.tool.before/after/replace` | UI attached to a target tool call |
| `composer.above/below` | Panels around the input composer |
| `composer.toolbar/status` | Compact actions and state |
| `composer.replace` | Full composer replacement, subject to host permission and fallback |
| `conversation.inline` | Transcript flow content near the active tail |
| `conversation.overlay` | Host-bounded overlay panel below core dialogs |

Shell surfaces are more constrained so extensions cannot destabilize navigation:

| Surface | Intended use |
|---|---|
| `sidebar.header/section/footer` | Sidebar additions |
| `navigation.item` | Compact command items in navigation |
| `session.badge` | Compact status attached to a running session |
| `window.topLeft/topRight` | Compact window-level actions |

For turn/message/tool surfaces, supply a `target` containing the corresponding stable ID. A contribution without a required target is rejected.

## Host-Rendered Primitives

Level 1 contributions use a bounded recursive node tree:

- `text`: `{ type: 'text', text, tone? }`
- `markdown`: `{ type: 'markdown', markdown }`
- `icon`: `{ type: 'icon', name, label }`
- `badge`: `{ type: 'badge', label, tone? }`
- `divider`: `{ type: 'divider' }`
- `button`: `{ type: 'button', label, icon?, action, disabled? }`
- `row` / `stack`: `{ type, children, gap? }`

Buttons may invoke registered extension commands. Do not put executable code, callbacks, HTML, CSS, React components, DOM nodes, or scripts in a contribution; the validator rejects them.

Icon names are deliberately bounded: `activity`, `alert-circle`, `check`, `chevron-right`, `circle`, `clock`, `info`, `loader`, `settings`, `sparkles`, and `x`.

## Layout And Conflict Rules

Extensions express placement intent, never coordinates. Craft owns flex/grid placement, reserved space, viewport adaptation, z-index, focus order, collapse, overflow, and exclusivity.

Optional fields:

| Field | Meaning |
|---|---|
| `priority` | Higher values win constrained capacity; range `-1000..1000` |
| `order` | Stable order after priority |
| `group` | Related contributions that may be presented together |
| `collapse` | `never`, `auto`, or `always` |
| `overflow` | `menu`, `collapse`, or `hide` |
| `exclusive` | Requests the only visible slot; host selects one deterministic winner |

Craft uses stable tie-breakers: host policy, priority, order, extension ID, contribution ID. Typical visible capacities are three composer panels, four toolbar/status actions, two actions per window corner, and five sidebar sections. Extra items enter a host-owned overflow control. Replace surfaces always have one winner and immediately fall back to built-in Craft UI if it disappears or fails.

Compact hotspots (`composer.toolbar`, `composer.status`, `window.topLeft`, and `window.topRight`) accept only text, icon, badge, button, and shallow row nodes. Markdown, stacks, dividers, deep trees, and text above 512 characters are rejected. Craft also clamps these slots to the top bar/composer height and a bounded width. `collapse: 'never'` raises visibility preference but cannot override host capacity or core controls.

This makes multiple extensions and multiple sandbox UI Apps safe on the same screen: each gets a host-assigned slot, so they cannot overlap the composer, cards, navigation, or window controls.

## Identity, Updates, And Recovery

- IDs are stable within one extension. Calling `upsertContribution` with the same ID replaces it.
- Pi assigns a monotonically increasing revision per extension runtime.
- Craft derives `extensionId`, `runtimeId`, and `sessionId` from the trusted route. Extensions cannot forge them.
- Repeated or stale deltas are ignored.
- Runtime state synchronization sends a snapshot.
- Extension reload, runtime close, client disconnect, session replacement, and process failure clear the affected registry scope.
- Invalid contributions fail independently and never replace core Craft UI.

Publish initial state from `session_start`, update only when state changes, and remove transient UI when work ends. Pi/Craft also clean it on lifecycle boundaries, but explicit removal makes intent clear.

## Actions And Host Capabilities

UI actions should reference commands registered by the same extension. Sensitive desktop functionality is separate from rendering and must use declared host capabilities:

```ts
pi.declareCapabilities([{ capability: 'files.pick', operations: ['open'] }])

const result = await ctx.capabilities.invoke<{ paths: string[] }>(
  'files.pick',
  'open',
  { mode: 'file', extensions: ['md'] },
  { timeoutMs: 30_000, signal: ctx.signal },
)
if (result.status === 'success') {
  // Use result.output.paths.
}
```

Craft owns authorization, routing, timeout, cancellation and audit. Extensions must handle `denied`, `cancelled`, `unsupported`, and `failed` without reaching for private Electron or filesystem APIs.

## Legacy Widgets

`ctx.ui.setWidget(key, string[], { placement })` remains a compatibility path. Craft normalizes it into a text contribution. It is intentionally limited and should not be used for new GUI. TUI component factories never cross JSONL.

Migrate legacy widgets by:

1. Choosing an explicit surface.
2. Replacing formatted terminal strings with host primitives.
3. Registering commands for every button action.
4. Using a stable contribution ID and explicit removal.
5. Testing multiple extensions, narrow viewport overflow, reset and reconnect snapshot behavior.

## Sandbox UI Apps

Arbitrary application UI uses a `sandbox-app` top-level node with self-contained `html`, optional `css` and optional `script`. It runs in an opaque-origin iframe with CSP, a bounded private message channel, session/runtime-scoped storage and explicitly declared `commands`, `theme`, `storage`, and `resize` permissions. Omitted permissions deny all bridge access. It does not receive parent DOM, global CSS, raw Electron IPC, credentials, workers, raw network APIs or unrestricted filesystem access.

Multiple sandbox apps may run at once. Craft still assigns each app a surface slot and resolves capacity/conflicts; sandbox freedom applies inside the allocated rectangle, not to the host page.

## Manifest Settings

Declare settings under the Craft-target extension entry's `ui.settings`. Supported field types are `boolean`, `string`, `textarea`, `number`, `select`, and `model`. Values live under `extensionConfig.<extension-id>`; Craft rejects unknown keys and invalid values before writing, and reloads extensions only for fields marked `requiresReload`.

## Common Mistakes

| Mistake | Correct approach |
|---|---|
| Importing Craft React components | Publish serializable primitives |
| Using absolute positioning or z-index | Pick a surface and let Craft allocate it |
| Encoding a click callback in JSON | Register a command and reference it |
| Reusing another extension's command | Actions must target commands owned by this extension |
| Assuming contribution support in TUI | Check `capabilities.contributions` |
| Depending on event replay after reconnect | Publish initial state at `session_start`; Craft also requests snapshots |
| Using `setWidget` for new GUI | Use `upsertContribution` |

## See Also

- `docs/architecture/pi-extension-gui.md` in the Craft repository for protocol, layout and migration architecture.
- [themes.md](./themes.md) for TUI and GUI theme boundaries.
- [skills.md](./skills.md) for Craft workspace skills, which are separate from Pi extensions.
