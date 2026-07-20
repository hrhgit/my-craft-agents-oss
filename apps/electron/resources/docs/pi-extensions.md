> Mortise can render GUI supplied by Pi extensions. Ask Pi to build one for your use case.

# Mortise GUI Extensions

Pi extensions can add persistent GUI to Mortise without shipping extension-specific code inside Mortise. Extensions publish serializable contributions; Mortise owns rendering, layout, validation, permissions, recovery, and fallback.

> **Placement and reload:** Mortise extensions must be declared with `targets: ["mortise"]` in a Pi package manifest. Put the package under `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local), then use **Settings > Extensions > Reload extensions**. Mortise reloads immediately when sessions are idle and asks before interrupting running sessions.

**Key capabilities:**
- **Host-rendered UI** - Compose text, Markdown, icons, badges, buttons, rows, and stacks with `ctx.ui.upsertContribution()`
- **Sandbox UI Apps** - Run self-contained HTML, CSS, and JavaScript inside a restricted iframe
- **Extension actions** - Connect buttons to commands owned by the same extension
- **Host capabilities** - Request explicitly declared desktop operations without using private Electron APIs
- **Manifest settings** - Declare settings that Mortise renders and validates generically
- **Safe composition** - Share host-allocated conversation, composer, sidebar, navigation, window, and workspace-content surfaces with other extensions

**Example use cases:**
- Build status above the composer
- Session badges and short sidebar or navigation entries
- Tool-specific controls and results attached to the matching tool call
- Interactive panels attached to the message, turn, or transcript tail that produced them
- A replacement composer with automatic fallback
- A persistent full tool opened as a universal-dock workspace content tab

The Quick Start below is a complete host-rendered example that you can install directly.

## Table of Contents

- [Quick Start](#quick-start)
- [Extension Locations](#extension-locations)
- [Package Manifest V1](#package-manifest-v1)
- [How Mortise GUI Extensions Work](#how-mortise-gui-extensions-work)
- [Writing a Contribution](#writing-a-contribution)
- [Surfaces](#surfaces)
- [Host-Rendered UI](#host-rendered-ui)
- [Sandbox UI Apps](#sandbox-ui-apps)
- [Layout and Conflicts](#layout-and-conflicts)
- [Manifest Settings](#manifest-settings)
- [Reloading](#reloading)
- [Error Handling](#error-handling)
- [Mode Behavior](#mode-behavior)
- [AI-Operable Validation](#ai-operable-validation)
- [Testing](#testing)
- [Examples Reference](#examples-reference)

## Quick Start

Create `~/.pi/agent/extensions/my-mortise-ui/package.json`:

```json
{
  "name": "my-mortise-ui",
  "type": "module",
  "pi": {
    "extensions": [
       {
         "id": "my-mortise-ui",
         "path": "./index.ts",
         "targets": ["mortise"],
         "manifest": {
           "schemaVersion": 1,
           "name": "My Mortise UI",
           "version": "1.0.0",
           "author": {
             "name": "Example Author",
             "url": "https://example.com"
           },
           "publisher": "example-author",
           "description": "Example Mortise GUI contribution.",
           "license": "MIT",
           "engines": {
             "mortise": "^0.1.0"
           },
           "capabilities": ["ui.contributions"],
           "permissions": []
         },
         "ui": {
          "schemaVersion": 1,
          "title": "My Mortise UI",
          "description": "Example Mortise GUI contribution.",
          "category": "ui"
        }
      }
    ]
  }
}
```

Create `~/.pi/agent/extensions/my-mortise-ui/index.ts`:

```typescript
import type { ExtensionAPI, ExtensionUIContext } from "@mortise/pi-coding-agent";

const contributionId = "my-mortise-ui.status";

function publish(ui: ExtensionUIContext, count: number): void {
  if (!ui.capabilities.contributions) return;

  ui.upsertContribution({
    schemaVersion: 1,
    id: contributionId,
    surface: "composer.above",
    priority: 10,
    collapse: "auto",
    overflow: "collapse",
    content: {
      type: "row",
      gap: "small",
      children: [
        { type: "icon", name: "sparkles", label: "Example extension" },
        { type: "text", text: `Updated ${count} time(s)` },
        {
          type: "button",
          label: "Update",
          action: { kind: "command", command: "my-mortise-ui-update" },
        },
      ],
    },
  });
}

export default function (pi: ExtensionAPI) {
  let count = 0;

  pi.on("session_start", (_event, ctx) => publish(ctx.ui, count));
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.clearContributions());

  pi.registerCommand("my-mortise-ui-update", {
    description: "Update the Mortise GUI example",
    handler: async (_args, ctx) => publish(ctx.ui, ++count),
  });
}
```

Open **Settings > Extensions** in Mortise and choose **Reload extensions**. The contribution appears above the composer.

## Extension Locations

> **Security:** Extension backend code runs in Pi's child process with your system permissions. Only install extensions from sources you trust. A sandbox UI App restricts its iframe; it does not sandbox the extension backend.

Mortise-target extensions use the same discovery locations as other Pi extensions:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/` | Global (all projects) |
| `.pi/extensions/` | Project-local |
| A package listed in Pi `settings.json` | Global or project-local, depending on the settings file |

Manifest target values:

- `mortise`: load in Mortise hosts.
- `pi`: load in Pi CLI hosts.
- `pi` and `mortise`: load in both; always check host capabilities before publishing GUI.

Package manifest entries require explicit `targets`. A GUI extension intended for Mortise must include `"mortise"`; use `["pi", "mortise"]` only when the same backend also supports Pi CLI hosts.

Use a stable lowercase package entry `id`, such as `repo-memory` or `build-status`. Mortise uses this ID for settings, command ownership, diagnostics, and contribution routing.

## Package Manifest V1

Published and shared extensions should include a versioned `manifest` on every `pi.extensions` entry. A loose local script without `manifest` remains loadable for development, but Mortise marks it as legacy and cannot use it to satisfy a versioned dependency.

Manifest V1 is strict: unknown fields, invalid identifiers, invalid SemVer versions or ranges, and a missing engine range for any declared target reject the package entry before extension code runs.

```json
{
  "id": "deployment-tools",
  "path": "./index.ts",
  "targets": ["pi", "mortise"],
  "activation": "beforeFirstRequest",
  "manifest": {
    "schemaVersion": 1,
    "name": "Deployment Tools",
    "version": "2.3.1",
    "author": {
      "name": "Example Author",
      "url": "https://example.com"
    },
    "publisher": "example-author",
    "description": "Deployment inspection and release commands.",
    "homepage": "https://example.com/deployment-tools",
    "repository": "https://example.com/deployment-tools/source",
    "license": "MIT",
    "engines": {
      "pi": "^0.1.0",
      "mortise": "^0.1.0"
    },
    "dependencies": {
      "deployment-core": "^2.0.0"
    },
    "optionalDependencies": {
      "deployment-history": ">=1.4.0 <3.0.0"
    },
    "conflicts": {
      "legacy-deployer": "*"
    },
    "capabilities": ["commands.deploy", "ui.contributions"],
    "permissions": ["workspace.files.read"],
    "loadOrder": {
      "priority": 20,
      "after": ["deployment-core"],
      "before": ["deployment-history"]
    }
  }
}
```

| Field | Requirement and behavior |
|-------|--------------------------|
| `schemaVersion` | Required and exactly `1`. |
| `name` | Required display name, up to 256 characters. |
| `version` | Required exact SemVer version. Do not use tags such as `latest`. |
| `author` | Required object with `name` and optional HTTP(S) `url`. |
| `publisher` | Optional stable lowercase publisher identifier. Keep it unchanged when the display author name changes. |
| `description` | Optional catalog description, up to 2,000 characters. |
| `homepage`, `repository`, `license` | Optional provenance and license metadata. URLs must use HTTP(S). |
| `engines` | Required object. Every value in `targets` requires a matching valid SemVer range. |
| `dependencies` | Required extension IDs and compatible version ranges. Missing, disabled, blocked, or incompatible dependencies block this extension. Dependencies always load first. |
| `optionalDependencies` | Optional integration ranges. Missing or incompatible entries produce a warning but do not block loading. |
| `conflicts` | Extension IDs and version ranges that cannot load with this extension. A matching active conflict blocks the declaring extension. |
| `capabilities` | Stable feature identifiers advertised for catalog, tooling, and review. This does not grant privileged access. |
| `permissions` | Requested host-permission identifiers for review and future mediation. Backend extension code still runs with the Pi process permissions; sandbox app permissions remain separately enforced. |
| `loadOrder.priority` | Deterministic tie-breaker; higher values load first when no dependency or explicit ordering edge applies. |
| `loadOrder.after`, `loadOrder.before` | Optional ordering hints by extension ID. A hint-only cycle produces a warning and falls back to priority then ID order. A required-dependency cycle blocks every extension in the cycle. |

IDs used by `id`, dependency maps, conflicts, and load-order hints are lowercase stable identifiers containing letters, digits, dots, and hyphens. Dependency keys refer to extension entry IDs, not npm package names or display names.

Mortise exposes `compatible`, `warning`, `blocked`, or `legacy` manifest status plus structured diagnostics in the extension catalog. Blocked extensions do not execute. Settings shows the extension version, author, and first diagnostic. Fix the manifest or installed dependency set, then reload extensions.

The Developer Kit includes `schemas/extension-manifest-v1.schema.json` and a complete package under `examples/manifest-v1/`. Runtime validation remains authoritative.

## How Mortise GUI Extensions Work

Extensions execute in Pi's child process. They do not receive Mortise's React tree, `window`, `document`, global CSS, credentials, Electron IPC, or the parent DOM. GUI communication crosses the Pi RPC boundary as versioned JSON.

There are two rendering levels:

1. **Host-rendered UI** is the default. Mortise renders a bounded declarative node tree using its theme, accessibility, focus, and responsive behavior.
2. **Sandbox UI App** is for arbitrary application UI. Mortise creates an isolated iframe inside a host-assigned surface slot.

Use existing dialog methods for transient interaction:

- `ctx.ui.select()`
- `ctx.ui.confirm()`
- `ctx.ui.input()`
- `ctx.ui.notify()`

Use contributions for persistent GUI:

- `ctx.ui.upsertContribution(definition)` creates or replaces one contribution.
- `ctx.ui.removeContribution(id)` removes one contribution.
- `ctx.ui.clearContributions()` removes all contributions owned by the current extension runtime.

Always check `ctx.ui.capabilities.contributions`. It is `true` in the Mortise RPC host and `false` in Pi TUI and unsupported hosts.

## Writing a Contribution

Publish initial UI from `session_start`:

```typescript
pi.on("session_start", (event, ctx) => {
  if (!ctx.ui.capabilities.contributions) return;

  ctx.ui.upsertContribution({
    schemaVersion: 1,
    id: "build-status",
    surface: "composer.status",
    content: { type: "badge", label: `Ready (${event.reason})`, tone: "success" },
  });
});
```

### Updating and Removing

Contribution IDs are stable within one extension runtime. Calling `upsertContribution()` with the same ID updates the existing contribution.

```typescript
ctx.ui.upsertContribution({
  schemaVersion: 1,
  id: "build-status",
  surface: "composer.status",
  content: { type: "badge", label: "Building", tone: "warning" },
});

ctx.ui.removeContribution("build-status");
```

Publish only when state changes. Remove transient UI when work ends. Mortise also clears contributions on reload, runtime close, disconnect, session replacement, and process failure.

### Targeted Contributions

Turn, message, and tool surfaces require a stable target ID:

```typescript
ctx.ui.upsertContribution({
  schemaVersion: 1,
  id: `tool-note:${toolCallId}`,
  surface: "conversation.tool.after",
  target: { toolCallId },
  content: { type: "text", text: "Validated by my extension", tone: "success" },
});
```

Use the stable ID supplied by the relevant runtime event. Do not derive a target from display text or array position.

## Surfaces

Choose a surface by what owns the UI, not by a screen coordinate:

| UI meaning | Preferred surface | Do not use |
|------------|-------------------|------------|
| Tool execution, progress, or result | Matching `conversation.tool.*` target | Window corner, sidebar, or global overlay |
| Message annotation, source, review finding, or preview | Matching `conversation.message.*` target | Unrelated timeline or shell slot |
| Turn-wide status or controls | Matching `conversation.turn.*` target | Persistent workspace tab for compact status |
| Session-tail content that still belongs in the transcript | `conversation.inline` | Fixed right-side viewer |
| Short-lived, host-bounded urgent UI | `conversation.overlay` | Full editor, dashboard, or persistent tool |
| Controls that change or describe the next message | `composer.*` | Second composer chrome or unrelated status center |
| Compact discovery or status outside the transcript | `sidebar.*`, `navigation.item`, `session.badge`, or `window.top*` | Full extension application |
| Long-lived viewer, editor, dashboard, or full extension tool | `workspace.content` | `workbench.right` or any fixed-side assumption |

Conversation-owned surfaces provide the most freedom:

| Surface | Intended use |
|---------|--------------|
| `conversation.timeline.before/after` | Session-level content around the timeline |
| `conversation.turn.before/after/replace` | UI around a target turn |
| `conversation.message.before/after/replace` | UI attached to a target message |
| `conversation.tool.before/after/replace` | UI attached to a target tool call |
| `conversation.inline` | Transcript-flow content near the active tail |
| `conversation.overlay` | Short-lived content inside a host-bounded overlay region |
| `composer.above/below` | Panels around the composer |
| `composer.toolbar/status` | Compact actions and state |
| `composer.replace` | Full composer replacement with built-in fallback |
| `workspace.content` | A persistent tool or sandbox app available to open as an ordinary tab in the workspace's universal dock |

```ts
ctx.ui.upsertContribution({
  schemaVersion: 1,
  id: "deployment-inspector",
  surface: "workspace.content",
  workspaceContent: {
    title: "Deployments",
    icon: "activity",
    scope: "workspace",
    instancePolicy: "singleton",
    preferredGroup: "adjacent",
  },
  content: {
    type: "sandbox-app",
    appId: "deployment-inspector",
    title: "Deployments",
    html: '<main id="app"></main>',
    script: 'document.querySelector("#app").textContent = "Ready";',
    permissions: ["theme", "storage", "commands", "validation"],
    minHeight: 240,
    maxHeight: 1600,
    preferredHeight: 720,
  },
});
```

`workspaceContent` is required on `workspace.content` so Mortise can expose, create, and restore a stable host-owned tab:

| Field | Meaning |
|-------|---------|
| `title` | Required tab label, up to 256 characters |
| `icon` | Required host icon from the contribution icon set |
| `scope` | `session` (default), `workspace`, or `global` |
| `instancePolicy` | `singleton` (default) deduplicates matching extension/contribution IDs; `multiple` keeps each publishing runtime as a separate tab |
| `preferredGroup` | Initial placement intent: `active` (default) opens in the current group; `adjacent` creates a neighboring group when first opened |

Publishing `workspace.content` makes the tool available from the workspace content picker; it does not force-open a tab or steal focus. A previously opened tab can be restored from the workspace layout. `preferredGroup` affects only the first user-driven open: `active` uses the current group and `adjacent` requests a neighboring group. It is not a persistent direction or position. After that, the tab follows the user's move, split, group, detach, and saved-layout choices.

The host injects trusted workspace identity; extensions cannot route workspace content into another workspace. Scope controls visibility and deduplication, not runtime lifetime: removing, resetting, reloading, or terminating the publishing runtime removes its contribution. A restored tab whose publishing runtime is unavailable may show the host fallback until the contribution is hydrated again. Mortise invokes commands through the runtime that published the selected tab.

`workbench.right` is not a compatibility alias. Mortise rejects it as an unsupported surface; publish `workspace.content` instead.

Shell surfaces are compact, host-controlled entry and status slots. They are not alternate homes for full tools:

| Surface | Intended use |
|---------|--------------|
| `sidebar.header/section/footer` | Short sidebar additions inside host-owned allocation |
| `navigation.item` | Compact command or discovery entry; not a custom navigation shell |
| `session.badge` | Compact status attached to a session |
| `window.topLeft/topRight` | Compact window-level action or status; the corner is a host slot, not extension-owned coordinates |

Replace surfaces have one deterministic winner. If the winning contribution disappears, is invalid, or fails to become ready, Mortise restores its built-in UI.

## Host-Rendered UI

Host-rendered contributions use a bounded recursive node tree.

### Node Reference

| Node | Shape |
|------|-------|
| Text | `{ type: "text", text, tone? }` |
| Markdown | `{ type: "markdown", markdown }` |
| Icon | `{ type: "icon", name, label }` |
| Badge | `{ type: "badge", label, tone? }` |
| Divider | `{ type: "divider" }` |
| Button | `{ type: "button", label, icon?, action, disabled? }` |
| Row or stack | `{ type: "row" | "stack", children, gap? }` |

Text tones: `default`, `muted`, `success`, `warning`, `danger`.

Badge tones: `default`, `info`, `success`, `warning`, `danger`.

Container gaps: `none`, `small`, `medium`.

Icon names: `activity`, `alert-circle`, `check`, `chevron-right`, `circle`, `clock`, `info`, `loader`, `settings`, `sparkles`, `x`.

Do not put callbacks, HTML, CSS, React components, DOM nodes, or executable code in a host-rendered contribution. Use a sandbox UI App when host-rendered primitives are not sufficient.

### Commands

Buttons invoke commands registered by the same extension:

```typescript
pi.registerCommand("build-cancel", {
  description: "Cancel the current build",
  hidden: true,
  handler: async (_args, ctx) => {
    // Cancel extension-owned work here.
    ctx.ui.removeContribution("build-status");
  },
});

ctx.ui.upsertContribution({
  schemaVersion: 1,
  id: "build-status",
  surface: "composer.above",
  content: {
    type: "button",
    label: "Cancel",
    icon: "x",
    action: { kind: "command", command: "build-cancel" },
  },
});
```

Command `args` must be a string. Mortise verifies extension ownership before invocation.

Set `hidden: true` for commands whose user entry point is a contribution button, sandbox control, or validation action. Hidden commands stay directly invokable by their owning contribution and validation contract, but Pi omits them from slash autocomplete, `pi.getCommands()`, and RPC `get_commands`. Use a visible command only when the capability has no equivalent Mortise GUI entry.

## Sandbox UI Apps

Use a `sandbox-app` top-level node for arbitrary HTML, CSS, and JavaScript:

```typescript
pi.on("session_start", (_event, ctx) => {
  if (!ctx.ui.capabilities.contributions) return;

  ctx.ui.upsertContribution({
    schemaVersion: 1,
    id: "counter-app",
    surface: "conversation.inline",
    content: {
      type: "sandbox-app",
      appId: "counter",
      title: "Counter",
      html: `
        <main>
          <strong>Count: <span id="count">0</span></strong>
          <button id="increment" type="button">Increment</button>
        </main>
      `,
      css: `
        :root { color-scheme: light dark; }
        body { margin: 0; font: 13px system-ui; }
        main { display: flex; align-items: center; gap: 12px; padding: 12px; }
        button { font: inherit; }
      `,
      script: `
        const count = document.querySelector("#count");
        const increment = document.querySelector("#increment");

        window.addEventListener("mortiseready", async () => {
          count.textContent = String((await window.mortise.storage.get("count")) ?? 0);
          await window.mortise.resize(document.body.scrollHeight);
        });

        increment.addEventListener("click", async () => {
          const next = Number(count.textContent) + 1;
          count.textContent = String(next);
          await window.mortise.storage.set("count", next);
        });
      `,
      minHeight: 80,
      maxHeight: 240,
      preferredHeight: 96,
      permissions: ["storage", "resize"],
    },
  });
});
```

A sandbox UI App must be the contribution's top-level node. It cannot be nested inside a row or stack.

### Host Bridge

The iframe receives `window.mortise`:

| API | Required permission | Purpose |
|-----|---------------------|---------|
| `mortise.ready` | None | Resolves after the private message channel is connected |
| `mortise.invokeCommand(command, args?)` | `commands` | Invoke a command owned by the extension |
| `mortise.getTheme()` | `theme` | Read a bounded set of Mortise theme tokens |
| `mortise.storage.get/set/delete(key)` | `storage` | Use bounded session/runtime-scoped storage |
| `mortise.resize(height)` | `resize` | Request a clamped iframe height |

The iframe receives `mortiseready` after initialization. Its event detail includes the declared `initialState`, granted permissions, and host identity metadata.

Omitted permissions deny all bridge access. Request only the permissions the app uses.

### Isolation and Limits

Sandbox UI Apps run in opaque-origin iframes with CSP and a private `MessageChannel`. They do not receive:

- Parent DOM or global CSS
- Credentials or raw Electron IPC
- Raw network APIs
- Workers, nested frames, or unrestricted navigation
- Arbitrary filesystem access

HTML and script are each limited to 512 KiB, CSS to 256 KiB, and the combined bundle to 1 MiB. `initialState` must be JSON-serializable and at most 64 KiB. Heights are clamped to `80..1600` pixels.

Multiple sandbox apps may run at once. Each remains inside the rectangle assigned by Mortise.

## Layout and Conflicts

Extensions express placement intent, not coordinates. Do not use host-level absolute positioning or global z-index.

Optional contribution fields:

| Field | Meaning |
|-------|---------|
| `priority` | Higher values win constrained capacity; integer `-1000..1000` |
| `order` | Stable order after priority; integer `-10000..10000` |
| `group` | Related-content metadata; current V1 does not allocate or collapse by group |
| `collapse` | `never`, `auto`, or `always` |
| `overflow` | `menu`, `collapse`, or `hide` |
| `exclusive` | Requests the only visible slot; Mortise chooses one winner |
| `workspaceContent` | Required metadata for `workspace.content`; rejected on other surfaces |

The current V1 resolver is deterministic. It sorts `collapse: "never"` before `auto` before `always`, then uses descending priority, ascending order, extension ID, and contribution ID. Replace surfaces and `exclusive: true` choose one winner. Extensions cannot override core controls or request focus by raising priority.

Current fixed capacities are:

| Surface class | Visible capacity |
|---------------|------------------|
| Composer above or below | 3 |
| Composer toolbar or status | 4 |
| Window top-left or top-right | 2 |
| Sidebar header / section / footer | 2 / 5 / 2 |
| Workspace content | 4 admitted sandbox apps per renderer; host-rendered content is not subject to the sandbox budget |
| Replace surfaces | 1 |

Extra contributions enter host-owned overflow unless `overflow: "hide"` removes them from it. Current V1 renders `menu` and `collapse` through the same host overflow container; extensions must not depend on a visual distinction between those two values yet. A shared surface runs at most four mounted sandbox apps at once. `workspace.content` uses one renderer-wide sandbox admission budget even when several dock groups are visible; excess sandbox apps remain unmounted.

Compact surfaces (`composer.toolbar`, `composer.status`, `navigation.item`, `session.badge`, `window.topLeft`, `window.topRight`) accept only text, icon, badge, button, and shallow rows. They reject Markdown, stacks, dividers, sandbox apps, deep trees, and long text.

`collapse: "never"` is a visibility preference. It cannot displace core Mortise controls.

Responsive capacity changes and explicit cross-contribution focus arbitration are still host-side V1 gaps. Today the host keeps deterministic DOM order and clamps compact content, but it does not recompute every surface capacity from viewport width. Keep content flexible, accessible, and safe at narrow widths; do not compensate with fixed/absolute positioning, global z-index, or focus stealing.

## Manifest Settings

Declare extension settings on the Mortise-target manifest entry:

```json
{
  "pi": {
    "extensions": [
      {
        "id": "my-mortise-ui",
        "path": "./index.ts",
        "targets": ["mortise"],
        "ui": {
          "schemaVersion": 1,
          "title": "My Mortise UI",
          "description": "Configurable GUI example.",
          "category": "ui",
          "settings": {
            "schemaVersion": 1,
            "groups": [
              { "id": "display", "title": "Display" }
            ],
            "fields": [
              {
                "key": "visible",
                "type": "boolean",
                "label": "Show panel",
                "group": "display",
                "default": true,
                "requiresReload": true
              },
              {
                "key": "density",
                "type": "select",
                "label": "Density",
                "group": "display",
                "default": "compact",
                "options": [
                  { "value": "compact", "label": "Compact" },
                  { "value": "comfortable", "label": "Comfortable" }
                ]
              }
            ]
          }
        }
      }
    ]
  }
}
```

Supported categories: `ui`, `automation`, `agent`, `shell`, `diagnostics`, `memory`, `search`, `other`.

Supported field types: `boolean`, `string`, `textarea`, `number`, `select`, `model`, `model-reference`.

Use `model-reference` when an extension launches an agent and should follow runtime model choices. Mortise renders the current Session model as the default, followed by the configured ordered global defaults and explicit provider-qualified models. Values are semantic references: `current-session`, `default:<positive-index>`, or `model:<provider>/<model-id>`. Resolving a global default also applies that preset's thinking level.

Resolve the stored value when the agent starts so later Session or default-slot changes take effect:

```typescript
import { resolveModelReference } from "@mortise/pi-coding-agent";

const selected = resolveModelReference(config?.model as string | undefined, {
  currentModel: ctx.model,
  cwd: ctx.cwd,
});
```

Manifest validation rules:

- Field keys must be unique stable identifiers beginning with a letter.
- Boolean fields require a boolean `default`.
- Select fields require `1..128` unique options. A select `default` must use a declared option value.
- A field `group` must name a group declared in the same settings schema.
- `visibleWhen.key` must name another declared field; `equals` must be a string, number, or boolean.
- Number bounds must be finite and `min` cannot exceed `max`.
- Settings schemas support at most 128 fields and 32 groups.

Values are stored under `extensionConfig.<extension-id>` in Pi `settings.json`. Mortise validates unknown keys, types, ranges, and select options before writing.

Read settings through Pi's `SettingsManager`:

```typescript
import { SettingsManager, getAgentDir } from "@mortise/pi-coding-agent";

const settings = SettingsManager.create(process.cwd(), getAgentDir());
const config = settings.getExtensionConfig("my-mortise-ui");
const visible = config?.visible !== false;
```

Fields marked `requiresReload` reload active extension runtimes after a successful write. Streaming runtimes may defer that settings-triggered reload until they settle.

## Reloading

Use **Settings > Extensions > Reload extensions** to reload extension code and GUI:

1. Mortise reloads immediately when all sessions are idle.
2. If any session is running, Mortise lists the active sessions and asks for confirmation.
3. Confirming interrupts every session that is still running, then reloads all active Pi runtimes.
4. Cancelling leaves running sessions and extensions unchanged.

Pi emits `session_shutdown` with `reason: "reload"`, rebuilds the extension runtime, then emits `session_start` with `reason: "reload"`.

Treat reload as a new extension instance:

- Republish initial GUI from `session_start`.
- Do not rely on module-local state surviving.
- Persist extension state with Pi session entries or settings when needed.
- Sandbox DOM and runtime-scoped `mortise.storage` are recreated. Persist durable state through Pi settings or session entries, then provide it again through `initialState`.

## Error Handling

Invalid contributions fail independently. They do not hide core Mortise UI or contributions from other extensions.

Handle host capability results explicitly:

```typescript
const result = await ctx.capabilities.invoke(
  "files.pick",
  "open",
  { mode: "file", extensions: ["md"] },
  { timeoutMs: 30_000, signal: ctx.signal },
);

if (result.status !== "success") {
  ctx.ui.notify(`File selection ${result.status}`, "warning");
  return;
}
```

Extensions must handle `denied`, `cancelled`, `unsupported`, and `failed`. Do not fall back to private Electron APIs or unvalidated parent-window access.

For runtime failures, check `%USERPROFILE%\.mortise\logs\runtime.log` and filter for `scope == "pi-rpc"`. Manifest and catalog errors also appear on **Settings > Extensions**.

## Mode Behavior

| Host | Mortise contributions | Dialog UI | Notes |
|------|---------------------|-----------|-------|
| Mortise Electron | Yes | Yes | Full Mortise GUI host |
| Mortise WebUI | Yes | Yes | Shares the renderer; native desktop capabilities may be unavailable |
| Pi TUI | No | Yes | Use Pi TUI APIs instead of Mortise contributions |
| Headless or print mode | No | No | Keep non-UI behavior functional |

For extensions targeting both Pi and Mortise, check `ctx.ui.capabilities.contributions` rather than inferring the host from `ctx.hasUI`.

## AI-Operable Validation

Mortise GUI extensions must remain readable, operable, and verifiable through Mortise's source-development UI validation framework. This is an authoring requirement for extension GUI, not an optional test-only convention.

Validation protocol V1 is an optional development capability. It never makes the extension GUI loadable and it is not a substitute for `upsertContribution()`. A production host, Pi TUI, headless host, or an older linked Pi SDK can expose no validation API at all; the extension must continue normally in that case.

### Capability Detection

Current Pi SDK versions expose the development capability directly on `ctx.ui.validation`. Treat `available: false` and a missing value from an older host as the same safe no-op condition:

```typescript
const validation = ctx.ui.validation;
if (!validation?.available || !validation.protocolVersions.includes(1)) {
  // Normal extension behavior continues. Do not emit private RPC events.
  return;
}
```

The host enables this RPC channel only for a source-development Test Host. Pi TUI, production Mortise, headless hosts, and older SDKs keep it disabled and all methods degrade safely. Never infer validation support from `ctx.hasUI`, `capabilities.contributions`, Electron, or a development environment variable.

### Validation Definition V1

Publish one definition per independently testable contribution, and set `contributionId` to the contribution's real stable ID. Re-publish the same validation `id` when its signals, disabled actions, or semantic snapshot change. Mortise applies monotonically increasing runtime revisions and clears definitions on runtime reset, reload, disconnect, or process failure. V1 validates both records independently, so a matching string is an author invariant rather than a substitute for a real renderer check.

```typescript
type ValidationDefinitionV1 = {
  schemaVersion: 1;
  id: string;
  contributionId: string;
  verificationLevel: "semantic" | "physical";
  readyWhen?: string[];
  signals?: Array<{
    id: string;
    label: string;
    status: "pending" | "busy" | "ready" | "error";
    detail?: string;
  }>;
  actions?: Array<{
    id: string;
    label: string;
    command: string;
    inputSchema?: Record<string, unknown>;
    disabled?: boolean;
  }>;
  scenarios?: Array<{
    id: string;
    label: string;
    command: string;
    inputSchema?: Record<string, unknown>;
    teardownCommand?: string;
    teardownInputSchema?: Record<string, unknown>;
  }>;
  snapshot?: SemanticNodeV1;
};

type SemanticNodeV1 = {
  id: string;
  role: string;
  label?: string;
  state?: Record<string, string | number | boolean | null>;
  children?: SemanticNodeV1[];
};
```

Example:

```typescript
validation.upsertDefinition({
  schemaVersion: 1,
  id: "build-status.contract",
  contributionId: "build-status",
  verificationLevel: "semantic",
  readyWhen: ["build.ready"],
  signals: [
    { id: "build.ready", label: "Build status loaded", status: state.phase === "loading" ? "busy" : "ready" },
  ],
  actions: [
    {
      id: "refresh",
      label: "Refresh build",
      command: "build-status:refresh",
      inputSchema: { type: "object", additionalProperties: false },
      disabled: state.phase === "loading",
    },
  ],
  scenarios: [
    {
      id: "failed-build",
      label: "Failed build",
      command: "build-status:test-failed-build",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", maxLength: 200 } },
        additionalProperties: false,
      },
      teardownCommand: "build-status:test-reset",
      teardownInputSchema: { type: "object", additionalProperties: false },
    },
  ],
  snapshot: {
    id: "build-status",
    role: "region",
    label: "Build status",
    state: { phase: state.phase },
    children: [{ id: "refresh", role: "button", label: "Refresh build", state: { disabled: state.phase === "loading" } }],
  },
});

// Replace dynamic readiness/snapshot fields without redeclaring actions.
validation.updateState("build-status.contract", {
  readyWhen: ["build.ready"],
  signals: [{ id: "build.ready", label: "Build status loaded", status: "ready" }],
});

// On teardown (runtime disposal also clears definitions automatically):
validation.removeDefinition("build-status.contract");

// Or clear every validation definition owned by this extension runtime:
validation.clearDefinitions();
```

Action, scenario setup, and scenario teardown command values must be registered by the same extension. Mortise passes the trusted extension owner into Pi's command registry and rejects cross-extension command names even when another extension declares them. Actions must use the same production command handlers as visible controls. A scenario command is development-only setup: it may select fixtures or feed typed events through the extension's production reducer, but it must not evaluate code, mutate Mortise renderer state, query private DOM, write real user data, or invent a state that production cannot reach. Declare `teardownCommand` whenever setup changes persistent extension state; teardown must be idempotent and restore the state captured before setup. The development host can refuse all scenario commands outside an isolated validation profile.

Sandbox contributions receive the same methods through `window.mortise.validation`: `publish`, `updateState`, `clear`, and `clearAll`. The API is present but reports `available: false` unless both the sandbox contribution requests the `validation` permission and Mortise is running under the source-development Test Host. A sandbox validation route keeps a synthetic renderer identity, while command execution remains bound to the trusted owning Pi extension.

Definitions are bounded: at most 64 signals, 64 actions, 32 scenarios, 256 semantic nodes, and eight semantic tree levels. IDs must be stable and unique in their local collection. `readyWhen` may reference only declared signal IDs. Input schemas and state must be JSON-serializable and bounded. Unknown fields or protocol versions fail closed for validation only; they do not remove the contribution.

### Sandbox App Bridge

A sandbox app must request the separate `validation` permission in addition to any production permissions it needs:

```typescript
content: {
  type: "sandbox-app",
  appId: "build-dashboard",
  title: "Build dashboard",
  html,
  script,
  permissions: ["commands", "validation"],
}
```

Add that permission only after the host-side validation capability check succeeds. When validation is unavailable, publish the same sandbox contribution without `validation`; older contribution V1 hosts reject unknown permissions by design.

The iframe receives `window.mortise.validation`:

```typescript
const { capabilities } = window.mortise.validation;
if (capabilities.available && capabilities.protocolVersions.includes(1)) {
  await window.mortise.validation.publish(definition);
  await window.mortise.validation.updateState(definition.id, {
    readyWhen: ["build.ready"],
    signals: [{ id: "build.ready", label: "Build ready", status: "ready" }],
  });
  // Remove one definition, or clear all definitions owned by this sandbox app:
  await window.mortise.validation.clear(definition.id);
  await window.mortise.validation.clearAll();
}
```

The bridge is enabled only when both conditions hold: the app requested `validation`, and the source-development host advertised validation V1. Otherwise `capabilities.available` is false and publish/update/clear calls are rejected. Messages use the iframe's private nonce-bound `MessageChannel`, existing size and rate limits, and the same shared validator as host-rendered definitions. Sandbox definitions receive a synthetic registry owner so their revisions cannot collide with backend-published definitions. Closing, reloading, timing out, encountering a message-channel error, or failing the iframe resets its definitions.

The sandbox bridge accepts semantic definitions only. It exposes no DOM query, JavaScript evaluation, coordinate injection, direct scenario state setter, Electron IPC, filesystem, credentials, or network access. Scenario setup remains an extension-owned command and should re-enter the sandbox through normal `initialState` or production state events.

### Host Behavior and Compatibility

Mortise validates at every available boundary: Pi owns the runtime revision; the server replaces payload route identity with the host-owned session/runtime/extension identity; the renderer rejects stale revisions and clears a failed runtime; command dispatch verifies extension ownership. Invalid validation is isolated from normal GUI rendering.

WebUI and Electron share the renderer registry and sandbox protocol. Pi TUI and headless hosts do not support Mortise validation. Extension packages should ship one normal GUI implementation and conditionally add validation metadata, not fork their UI by host.

Host-rendered contributions inherit baseline semantics from Mortise's primitives. Extension authors must still:

- Use stable contribution and target IDs that do not depend on display text, array position, or rendered DOM structure.
- Give every interactive control a concise accessible label and expose disabled, selected, busy, ready, and error state through the contribution model.
- Route actions through commands owned by the extension so semantic and physical validation exercise the same production state transitions.
- Publish state changes when they occur instead of requiring fixed-delay waits.

Contribution V1 does not accept a per-node `semanticId`. Use stable IDs in the validation snapshot for declared semantics and concise accessible labels for real renderer discovery. Do not target `data-extension-*`, DOM ancestry, generated refs, or visual coordinates; those are host implementation details. The Test Host can inspect a declared extension snapshot and a real renderer snapshot, but it does not automatically prove that a declared semantic node is the same DOM control.

When the development host advertises versioned validation capabilities, GUI extensions must declare host-validated readiness signals, typed actions, and bounded scenario primitives through those capabilities. Agents may compose registered scenarios and event flows, but extensions must not expose arbitrary renderer-state mutation or states that cannot occur in production.

Sandbox UI Apps must provide equivalent semantics through the sandbox bridge. Do not make essential state or actions discoverable only through pixels, coordinates, private DOM structure, animation timing, or unstructured console output.

Validation support must degrade safely: production packages and hosts without the development validation capability ignore validation declarations, while the extension's normal GUI and non-GUI behavior continue to work.

### Verification Levels

The validation definition's `verificationLevel` describes the strongest kind of evidence the contribution needs. It is distinct from the result reported by a test run:

| Evidence | What it proves | Result label |
|----------|----------------|--------------|
| Scenario | A declared extension command or typed scenario reached a production-valid state and published its semantic contract. | `scenario-verified` |
| Renderer | A real host-rendered or sandbox control was found and used in the production renderer. | `renderer-verified` |
| Native | The operating system's native accessibility/input adapter operated the Mortise window, menu, or dialog. | `native-verified` |

Use `verificationLevel: "semantic"` when command-backed semantic evidence is sufficient. Use `"physical"` when the contribution also needs renderer interaction evidence. This field declares the required evidence; it does not turn a command invocation into physical proof. A physical acceptance flow must still find and operate the real accessible control in the renderer. Native verification is an additional host/platform capability, not a value extension authors declare. When a platform has no native adapter, the only correct native result is `UNSUPPORTED`.

### Compatibility and Authority

Mortise-specific authoring rules in this guide take precedence for Mortise surfaces, sandboxing, reload, and validation. Pi's extension guide is the authority for the underlying extension lifecycle and `ctx.ui` API.

Always capability-check `ctx.ui.capabilities.contributions` and `ctx.ui.validation.available`. Do not pin behavior to a Mortise version, an Electron/WebUI check, `ctx.hasUI`, or an environment variable: linked Pi SDKs and hosts may be older and must receive a safe no-op path.

## Testing

During development, mount the package directly from its working directory. Mortise resolves the Manifest V1 entries from that directory into the disposable Pi profile; it does not copy the extension source or its dependencies into the profile.

From a Mortise source checkout:

```bash
bun run mortise-ui -- start --label extension-contribution --surface electron --profile fixture \
  --extension /absolute/path/to/my-mortise-extension --json
```

From an installed Mortise Developer Kit on Windows:

```powershell
.\bin\mortise-ui.exe start --label extension-contribution --surface electron --profile fixture `
  --extension D:\Projects\my-mortise-extension --json
```

`--extension` is repeatable. Each directory must contain `package.json` with Manifest V1 `pi.extensions` entries targeting `mortise`. Mounted entries override cloned profile entries with the same extension ID for that run, while duplicate mounted IDs fail before the host starts. Use **Settings > Extensions > Reload extensions** after editing extension code; the next runtime is loaded from the same development directory.

Before publishing a Mortise GUI extension, verify:

1. The extension entry includes a stable `id`, `targets: ["mortise"]`, and Manifest V1 with version, author, and `engines.mortise`.
2. Initial GUI is published from `session_start`.
3. Repeated upserts use stable contribution IDs.
4. Buttons reference commands owned by the same extension.
5. Targeted surfaces use stable turn, message, or tool IDs.
6. Multiple extensions share the surface without overlap and deterministic overflow remains reachable.
7. Narrow viewports keep core controls usable; do not assume the current fixed capacity is a responsive placement API.
8. Replace surfaces restore built-in UI when the contribution fails or disappears.
9. Reload removes old GUI and republishes the new version.
10. TUI and headless modes continue without Mortise contribution support.
11. Structured snapshots expose stable semantic IDs, labels, actions, and current state without relying on private DOM selectors.
12. Ready, busy, completion, and failure transitions are observable without fixed sleeps.
13. Registered scenarios use typed, production-valid state primitives and cannot mutate arbitrary renderer internals.
14. Fast semantic validation and representative real renderer interaction both pass at their declared verification level.
15. `workspace.content` is opened through the content picker, can move/split/detach without extension coordinate assumptions, restores through the host layout, and never mixes workspace-owned content.

The repository's `mortise-gui.ts` example is the executable reference. Its E2E creates a real temporary Manifest V1 development package, mounts that package through the same `--extension` profile path, creates a real Mortise session, runs the declared count scenario and command action, physically clicks the host-rendered button, performs the platform-native window check, captures evidence, and tears the scenario down:

```bash
bun run test:ui-validation:extension
```

Passing this flow proves `scenario-verified` and `renderer-verified` on every supported source surface, plus `native-verified` where the native driver is available. `UNSUPPORTED` is the only valid result when a platform has no native adapter; never replace it with a manual step or report a lower-level action as native verification.

For sandbox apps, also verify:

1. The app requests only required permissions.
2. Loading, ready, error, and retry states are visible.
3. Height requests remain within declared bounds.
4. Stored and initial state are JSON-serializable and bounded.
5. Multiple sandbox apps remain isolated on the same surface.
6. The validation bridge exposes meaningful controls and state without requiring coordinate-only interaction.

## Legacy Widgets

`ctx.ui.setWidget(key, string[], { placement })` remains a compatibility path. Mortise normalizes it into a text contribution. Do not use it for new GUI.

Migrate a legacy widget by:

1. Choosing an explicit surface.
2. Replacing formatted terminal strings with host-rendered nodes.
3. Registering commands for button actions.
4. Using stable contribution IDs and explicit removal.
5. Testing reload, reconnect, overflow, and multiple extensions.

TUI component factories never cross the Pi RPC boundary.

## Examples Reference

| Example | Description | Key APIs |
|---------|-------------|----------|
| Quick Start above | Mortise-target package manifest and update lifecycle | `targets`, `session_start`, `session_shutdown` |
| Sandbox example above | Self-contained interactive iframe | `sandbox-app`, `mortise.storage`, `mortise.resize` |
| Manifest settings above | Generic settings UI | `ui.settings`, `SettingsManager` |
| [Pi `mortise-gui.ts` example](https://github.com/hrhgit/mortise/blob/main/packages/coding-agent/examples/extensions/mortise-gui.ts) | Complete contribution, validation contract, scenario teardown, and sandbox bridge | `ctx.ui.validation`, `upsertContribution` |

## See Also

- [Pi extensions](https://github.com/hrhgit/mortise/blob/main/packages/coding-agent/docs/extensions.md) for the complete Pi extension lifecycle and API.
- [Pi host-mediated UI validation](https://github.com/hrhgit/mortise/blob/main/packages/coding-agent/docs/extensions.md#host-mediated-ui-validation) for the SDK-level validation contract.
- [Pi Extension GUI Architecture](../../../../docs/architecture/pi-extension-gui.md) for protocol, layout, isolation, and migration rationale.
- [Themes](./themes.md) for TUI and GUI theme boundaries.
- [Skills](./skills.md) for Mortise workspace skills, which are separate from Pi extensions.
