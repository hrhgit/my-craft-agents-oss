# Testing

Craft Agent uses Bun for TypeScript tests and Python `unittest` for the bundled document-tool smoke tests.

## Layout

- Unit tests belong in the nearest `__tests__/` directory and use the name `<subject>.test.ts` (or `.test.tsx`). Keep the production module beside that directory.
- Tests that exercise a package boundary may live in `<package>/tests/`. `packages/shared/tests/` is the existing example.
- End-to-end flows belong under `scripts/e2e/`.
- Bundled document-tool smoke tests stay in `apps/electron/resources/scripts/tests/`; they validate packaged wrappers rather than source modules.
- `*.isolated.ts` files are standalone process tests. Do not rename them to `.test.ts`; they are run after the normal Bun discovery pass.

Existing colocated tests are valid legacy exceptions. Move them only with their package's related tests, updating relative imports and any explicit test command in the same change.

## Commands

```bash
# All TypeScript tests, including standalone isolated tests
bun run test

# Bun-discovered TypeScript tests only
bun run test:unit

# Standalone process tests only
bun run test:isolated

# Bundled document-tool smoke tests
bun run test:doc-tools
```

`validate:dev` deliberately runs a smaller, fast validation set. Run `bun run test` before broad test-related changes; expanding CI coverage is a separate decision because it changes validation time and flake exposure. The isolated-test runner is a Bun script so the command works on Windows as well as POSIX shells.

## Typed AppShell UI Scenarios

The source-only UI Test Host includes a controlled production-component surface named `app-shell-scenario-host`. Open that playground component before applying AppShell scenarios. The renderer installs `__CRAFT_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__` only when the Electron Test Host capability or WebUI validation bootstrap is present.

The fixed bridge exposes `list()`, `snapshot()`, `apply(request)`, `reset()`, `clock.advance(ms)`, `fault.set(request)`, and `fault.clear(id?)`. It does not expose atoms, React state, DOM queries, JavaScript evaluation, or arbitrary service replacement. `apply` accepts the shared `UiValidationScenarioApplyRequest` and rejects `fixture` for these fixed scenarios.

Initial AppShell scenarios are:

- `app.loading`, `transport.reconnect`, `transport.error`
- `session.empty`, `session.streaming`, `tool.approval`
- `extension.loading`, `extension.ready`, `extension.error`, `extension.reload`
- `settings.permissions`, `settings.app`

The host renders the production AppShell and production components for transport status, session transcript streaming, approval, extension contributions, permission tables, settings layout, and the application splash. Scenario definitions can only compose registered typed state primitives and registered service operations. The session projection adapter is the sole boundary allowed to update production renderer projections; definitions never receive atoms, a Jotai store, React setters, or arbitrary fixtures.

The frozen clock virtualizes the registered application `timer`, `debounce`, `retry`, and `scheduler` domains. Snapshot, apply, and evidence results report those domains explicitly and always report OS and network clocks as not virtualized. Reset disposes pending work so an old scenario timeline cannot mutate the next scenario. Registered fault points are `transport.connect`, `session.stream`, and `extension.reload`; each is wired through its named service operation, validates its scope, consumes an exact bounded count, and gives `delay`, `error`, `disconnect`, and `drop` distinct observable behavior.

## Source UI Validation Control Plane

`craft-ui` is source-only and is excluded from production/package module graphs. It exposes a versioned JSON control plane; callers do not use Playwright, CDP, selectors, renderer evaluation, or Electron objects directly.

```bash
bun run craft-ui -- start --surface electron --profile isolated --json
bun run craft-ui -- status --json
bun run craft-ui -- capabilities list --kind route --json
bun run craft-ui -- capabilities describe --kind scenario --id session.streaming --json
bun run craft-ui -- open --params '{"route":{"surface":"settings","section":"extensions"}}' --json
bun run craft-ui -- snapshot --json
bun run craft-ui -- wait --params '{"predicate":{"kind":"semantic-ready"}}' --json
bun run craft-ui -- evidence --params '{"label":"manual-check"}' --json
bun run craft-ui -- stop --json
```

`start` returns only after both the application state and its semantic UI are ready. Route, session, transport, extension, and native waits are event-driven. Do not add fixed sleeps to validation flows.

Use `capabilities list` before composing a flow and `capabilities describe` to obtain the bounded input schema, supported surfaces, modes, and expected verification level for one route, scenario, or action. The catalog is protocol V1 data and never exposes Playwright, CDP, selectors, JavaScript evaluation, or renderer state. Its `runtimeDiscovery.extensionDefinitions` entry also describes the dynamic extension discovery call. Read extension identities from the `scope: "extension"` entries returned by `status`, then call `snapshot --params '{"target":{"kind":"extension","sessionId":"...","extensionId":"..."}}'`. The result contains the host-validated readiness signals, actions, scenarios, and input schemas contributed by that running extension; callers do not inspect extension or renderer source.

Use `isolated` unless real configuration is required. Clone mode requires both source paths explicitly and redirects every write into temporary directories:

```bash
bun run craft-ui -- start --surface electron --profile clone \
  --source-craft-profile /explicit/craft/profile \
  --source-pi-profile /explicit/pi/agent --json
```

Verification levels are cumulative evidence, not interchangeable labels:

- `scenario-verified`: real production components and command/state-machine actions with controlled dependencies.
- `renderer-verified`: real renderer plus physical mouse, keyboard, clipboard, composition, rich-text, shortcut, or drag input.
- `native-verified`: Electron/native window, application menu, or platform dialog operation.

Run the focused and real-host suites with:

```bash
bun run test:craft-ui
bun run test:ui-validation:electron
bun run test:ui-validation:extension
bun run test:ui-validation:recovery
bun run test:ui-validation:runtime-contract
bun run test:ui-validation:surface-parity
CRAFT_UI_STABILITY_SURFACES=webui,electron CRAFT_UI_STABILITY_ITERATIONS=10 bun run test:ui-validation:stability
bun run test:ui-validation:raw-host-smoke
```

`runtime-contract` drives the public fault, frozen-clock, physical retry, and idempotent reset APIs against a real Electron renderer. `surface-parity` applies the same real AppShell scenario to WebUI and Electron and compares stable semantic roles, actions, and state. They are explicit source-development acceptance checks and are not part of the fast unit suite.

`test:electron:chat-real` now uses only `craft-ui`. It deliberately refuses implicit access to a home profile:

```bash
CRAFT_E2E_SOURCE_CRAFT_PROFILE=/explicit/craft/profile \
CRAFT_E2E_SOURCE_PI_PROFILE=/explicit/pi/agent \
bun run test:electron:chat-real
```

Every failed host command captures a redacted evidence bundle. Electron and WebUI bundles have a stable full/incremental snapshot pair, screenshot, state/event interval, console and page errors, network summary, runtime log, driver data, route/scenario/seed/viewport, and verification level. Electron also includes fixed main-process diagnostics without an evaluation API.
