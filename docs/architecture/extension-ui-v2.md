# Extension UI V2

Extension UI V2 is Mortise's browser-style frontend contract. One extension package can contain a Pi backend entry and one or more renderer frontend entries. V1 host-rendered contributions and sandbox applications remain supported.

## Manifest

```json
{
  "ui": {
    "schemaVersion": 2,
    "compatibility": { "uiApi": "^2.0.0", "mortise": ">=0.1.0 <0.2.0" },
    "frontends": [{
      "id": "toolbar",
      "entry": "./dist/ui/toolbar.js",
      "styles": ["./dist/ui/toolbar.css"],
      "surface": "composer.toolbar",
      "mode": "append",
      "scope": "session"
    }]
  }
}
```

Frontend IDs are stable within a package. Production entries and styles use package-relative `./` paths, stay inside the package after symlink resolution, and must be built JavaScript or CSS files. A `settings.page` frontend also declares `page.id`, `page.title`, optional description/icon, and order.

The host checks the UI API and Mortise version ranges independently from the Pi backend. A frontend compatibility or asset error disables only the affected frontend and appears in extension diagnostics.

## Runtime

The renderer receives host-generated module and style URLs. Electron serves these through `mortise-extension://`; WebUI serves authenticated same-origin `/api/extensions/ui/` routes. Frontends do not derive filesystem paths.

The lifecycle is `import -> mount -> ready -> dispose`. `mount(context)` can be asynchronous and returns nothing, a cleanup function, or an object with `dispose()`. Route changes, revisions, runtime reset, and component removal abort the signal, dispose the module, then remove host-owned roots and styles. A `replace` surface retains its host fallback until mount succeeds. DOM changes outside `context.root` must be restored by the extension's disposer.

The context contains the root, declared surface/mode/scope, workspace and session route, `AbortSignal`, theme tokens, locale, notifications, semantic registration, and backend channels. Extensions may use `window`, `document`, and host DOM. Only documented surface names and context contracts are stable; other host DOM dependencies must be bounded by the manifest Mortise range.

## Channels

The Pi entry registers a channel with `registerFrontendChannel(id, { scope, snapshot, onMessage })` and publishes complete serializable snapshots through `ctx.ui.publishFrontendState(id, state)`. The frontend uses `context.backend.channel(id, { scope })` with `getSnapshot()`, `subscribe()`, and `send()`; the optional scope selects a workspace/global channel when the frontend surface scope differs from the backend channel scope. Workspace/global sends are routed through the active Workspace runtime even when a settings page has no session route.

Snapshots carry monotonically increasing revisions. The renderer drops stale revisions and clears exact and route-only state when a runtime resets. Session and workspace routes are validated before messages reach Pi.

## React and development

`@mortise/extension-ui` exposes `defineExtensionUI`; `@mortise/extension-ui/react` exposes `defineReactSurface`. React is an adapter and is bundled by the extension.

Development directories are mounted with `mortise-ui start --extension <directory>`. Built asset fingerprints produce frontend revisions; a debug renderer refreshes the catalog and performs complete dispose/import/mount without restarting Mortise. A loopback dev server can replace package URLs with `--ui-dev-server <extension-id=http://127.0.0.1:port/>`. `registerExtensionUIHotReload(import.meta.hot, ids)` connects accepted HMR updates to the same lifecycle; if HMR is unavailable, changing built assets uses complete reload.

The bundled `extension-ui-v2-lab` is the reference implementation for a React toolbar, native DOM settings page, direct host DOM cleanup, independent CSS, locale/theme context, and session/workspace channels.
