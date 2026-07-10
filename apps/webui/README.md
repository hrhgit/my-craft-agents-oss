# Craft WebUI

`apps/webui` is the browser shell for Craft's headless/server mode. The desktop
Electron app is still the primary Craft UI; this package exists so the server can
serve a browser UI when `CRAFT_WEBUI_DIR` points at a built `apps/webui/dist`.

The WebUI deliberately reuses the Electron renderer for the main app surface.
Its own code should stay thin: bootstrap i18n/theme state, create the browser
`ElectronAPI` adapter over WebSocket RPC, and provide browser-only shims for
modules that are bundled but not executed in the browser.

## Commands

- `bun run webui:typecheck` checks the WebUI TypeScript surface.
- `bun run lint:webui` checks the WebUI browser entry and shims.
- `bun run webui:build` builds the static assets consumed by `server:prod`.
- `bun run server:dev:webui` builds WebUI and starts the server with the assets enabled.

## Boundary

- WebUI talks to Craft through server RPC (`WsRpcClient`) and browser-safe shims.
- WebUI source must not import Electron, Node builtins, or Pi SDK packages directly.
- Shared renderer code that needs different browser behavior should use existing
  WebUI platform checks or move reusable contracts into shared packages.
