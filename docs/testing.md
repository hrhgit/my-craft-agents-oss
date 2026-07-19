# Testing

Mortise Agent uses Bun for TypeScript tests and Python `unittest` for the bundled document-tool smoke tests.

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

The source-only UI Test Host includes a controlled production-component surface named `app-shell-scenario-host`. Open that playground component before applying AppShell scenarios. The renderer installs `__MORTISE_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__` only when the Electron Test Host capability or WebUI validation bootstrap is present.

The fixed bridge exposes `list()`, `snapshot()`, `apply(request)`, `reset()`, `clock.advance(ms)`, `fault.set(request)`, and `fault.clear(id?)`. It does not expose atoms, React state, DOM queries, JavaScript evaluation, or arbitrary service replacement. `apply` accepts the shared `UiValidationScenarioApplyRequest` and rejects `fixture` for these fixed scenarios.

Initial AppShell scenarios are:

- `app.loading`, `transport.reconnect`, `transport.error`
- `session.empty`, `session.streaming`, `tool.approval`
- `extension.loading`, `extension.ready`, `extension.error`, `extension.reload`
- `settings.permissions`, `settings.app`

The host renders the production AppShell and production components for transport status, session transcript streaming, approval, extension contributions, permission tables, settings layout, and the application splash. Scenario definitions can only compose registered typed state primitives and registered service operations. The session projection adapter is the sole boundary allowed to update production renderer projections; definitions never receive atoms, a Jotai store, React setters, or arbitrary fixtures.

The frozen clock virtualizes the registered application `timer`, `debounce`, `retry`, and `scheduler` domains. Snapshot, apply, and evidence results report those domains explicitly and always report OS and network clocks as not virtualized. Reset disposes pending work so an old scenario timeline cannot mutate the next scenario. Registered fault points are `transport.connect`, `session.stream`, and `extension.reload`; each is wired through its named service operation, validates its scope, consumes an exact bounded count, and gives `delay`, `error`, `disconnect`, and `drop` distinct observable behavior.

## Source UI Validation Control Plane

`mortise-ui` is source-only and is excluded from production/package module graphs. It exposes a versioned JSON control plane; callers do not use Playwright, CDP, selectors, renderer evaluation, or Electron objects directly.

Cold starts and explicitly requested UI waits allow up to 10 minutes; the default cold-start budget is 10 minutes, ordinary host operations default to 2 minutes, and adapter-level waits default to 1 minute.

Electron source-validation builds are published as immutable, fingerprinted capsules under `output/mortise-ui-builds`. Starts with the same source fingerprint wait for and reuse one completed build; changed source publishes a new capsule without modifying files used by live runs. Each run records its `buildId` and `buildDir`. Normal shutdown releases the run's build lease and automatically removes unreferenced old capsules, retaining the newest two within a 2 GiB cache budget by default. `MORTISE_UI_BUILD_RETAIN_COUNT` and `MORTISE_UI_BUILD_MAX_BYTES` may tighten those bounds; active builds are never removed, so routine use requires no manual cleanup.

For Electron UI work, this CLI is also the primary AI-operated validation surface. Use it to explore the real changed workflow instead of relying only on a prewritten smoke script: start a fixture run, inspect the capability catalog and current snapshot, choose targets from that snapshot, execute a bounded action sequence, then capture evidence. The fixed E2E suites below are regression coverage and do not replace this interactive check.

```bash
bun run mortise-ui -- start --label settings-extension-reload --surface electron --profile fixture --json
bun run mortise-ui -- status --run settings-extension-reload --json
bun run mortise-ui -- capabilities list --kind route --run settings-extension-reload --json
bun run mortise-ui -- capabilities describe --kind scenario --id session.streaming --run settings-extension-reload --json
bun run mortise-ui -- open --run settings-extension-reload --params '{"route":{"surface":"settings","section":"extensions"}}' --json
bun run mortise-ui -- snapshot --run settings-extension-reload --json
bun run mortise-ui -- wait --run settings-extension-reload --params '{"predicate":{"kind":"semantic-ready"}}' --json
bun run mortise-ui -- evidence --run settings-extension-reload --params '{"label":"manual-check"}' --json
bun run mortise-ui -- stop --run settings-extension-reload --json
```

Mount an extension package directly from its development directory with a repeatable `--extension` option:

```bash
bun run mortise-ui -- start --label extension-package --surface electron --profile fixture \
  --extension /absolute/path/to/extension --json
```

The directory must contain Manifest V1 `pi.extensions` entries targeting `mortise`. The controller writes their resolved absolute entry paths into the disposable Pi settings file; it does not copy extension source, dependencies, or global user configuration. Mounted command-line entries replace cloned settings entries with the same ID for that run, and duplicate mounted IDs fail before the host starts.

An agent may build a broader disposable data scene before launch. The schema is available without starting the app, so callers do not need to inspect implementation source:

```bash
bun run mortise-ui -- fixture schema --json
bun run mortise-ui -- start --label fixture-data-scene --surface electron --profile fixture --fixture ./fixture.json --json
```

Fixture V1 declares one or more workspaces, workspace-root files, sessions, conversation messages, session sidecar files, and the initially active workspace/session. For example:

```json
{
  "version": 1,
  "active": { "workspaceId": "docs", "sessionId": "review-readme" },
  "workspaces": [{
    "id": "docs",
    "name": "Documentation",
    "files": [{ "path": "README.md", "content": "# Documentation\n" }],
    "sessions": [{
      "id": "review-readme",
      "name": "Review README",
      "messages": [
        { "role": "user", "content": "Review the README structure." },
        { "role": "assistant", "content": "The setup section needs an example." }
      ],
      "files": [{ "path": "plans/review.md", "content": "# Review plan\n" }]
    }]
  }]
}
```

Workspace files are materialized under the real disposable workspace root. Session files are materialized under the normal Mortise sidecar and must start with `attachments/`, `data/`, `downloads/`, `long_responses/`, or `plans/`. Conversation history is written through the canonical Pi session projection rather than a renderer mock. The validator bounds counts and bytes, rejects duplicate identities and paths, and prevents path escape or Windows-unsafe names. The entire profile is removed by `mortise-ui stop`.

Give AI-operated runs a short lowercase semantic label. The label is stored separately from the immutable run ID and may be passed to `--run`; exact run IDs remain available for protocol identity and disambiguation. If historical runs share a label, a single active match wins, while multiple active or stopped matches require the full run ID.

The usual interactive loop uses the semantic label for routine commands while retaining the returned run ID as the exact fallback:

```bash
bun run mortise-ui -- start --label changed-workflow --surface electron --profile fixture --json
bun run mortise-ui -- capabilities list --kind action --run changed-workflow --json
bun run mortise-ui -- snapshot --run changed-workflow --json
bun run mortise-ui -- action --run changed-workflow \
  --params '{"revision":<revision>,"target":{"ref":"<ref>"},"action":"click","mode":"physical"}' --json
bun run mortise-ui -- evidence --run changed-workflow --params '{"label":"changed-workflow"}' --json
bun run mortise-ui -- stop --run changed-workflow --json
```

Use Electron background mode when validation must not take over the active desktop:

```bash
bun run mortise-ui -- start --label background-validation --surface electron --profile fixture --window-mode background --json
```

The run starts real source-development Electron windows with renderer background throttling disabled and keeps every managed window minimized. Semantic actions, renderer snapshots and waits, CDP-backed physical input, renderer screenshots, and background-safe Windows UIA patterns remain available. A native background snapshot advertises only operations that do not require a foreground window: `Invoke`, `Value`, and `SelectionItem` patterns plus window minimize/close. Coordinate mouse fallback, focus, restore, maximize, and native dialogs return `UNSUPPORTED` instead of restoring or focusing the window. `status.windowMode` and `status.nativeDriver.windowMode` report the active contract. WebUI runs do not accept this option because they have no Electron window lifecycle.

For native Electron behavior, use the same run through either `snapshot --params '{"scope":"native"}'` or `request ui.native --params '{"operation":"snapshot"}'`, then send a `ui.action` request with `{"mode":"native","target":{"kind":"native","ref":"<native-ref>"},"action":"focus"}` or another action advertised by the native snapshot. In foreground mode, snapshots, actions, and native dialogs share the selected-window readiness boundary: the host reveals the window, matches its process-local UIA root by native handle or by title and DPI-scaled bounds, and only then returns `native-verified`. Background mode instead requires a minimized, UIA-verified selected window and filters each snapshot to background-safe actions. In `status.nativeDriver`, `available` means that the platform adapter exists; `ready` means the selected window has satisfied the active foreground or background contract. Native references and revisions must be refreshed after the window or dialog changes.

`start` returns only after both the application state and its semantic UI are ready. Route, session, transport, extension, and native waits are event-driven. Do not add fixed sleeps to validation flows.

Use `capabilities list` before composing a flow and `capabilities describe` to obtain the bounded input schema, supported surfaces, modes, and expected verification level for one route, scenario, or action. The catalog is protocol V1 data and never exposes Playwright, CDP, selectors, JavaScript evaluation, or renderer state. Its `runtimeDiscovery.extensionDefinitions` entry also describes the dynamic extension discovery call. Read extension identities from the `scope: "extension"` entries returned by `status`, then call `snapshot --params '{"target":{"kind":"extension","sessionId":"...","extensionId":"..."}}'`. The result contains the host-validated readiness signals, actions, scenarios, and input schemas contributed by that running extension; callers do not inspect extension or renderer source.

`fixture` is the default profile. Without `--fixture`, it sets `setupDeferred` and opens the normal application on a populated product-release conversation. The preset contains three disposable workspaces: a product launch with code, release files, multiple sessions, a tool-call transcript, and plan data; customer research with Markdown/CSV/JSON inputs and analysis sessions; and support operations with runbooks, incident/ticket files, triage sessions, and unread state. A custom `--fixture` replaces that preset with the declared real data scene. Fixture profiles contain no provider credentials or live endpoints; use registered typed scenarios for transient loading, streaming, approval, extension, permission, and error states.

Use `isolated` only for onboarding and pristine-profile behavior. When real provider or user configuration is required, clone mode requires both source paths explicitly and redirects every write into temporary directories:

```bash
bun run mortise-ui -- start --label real-provider-clone --surface electron --profile clone \
  --source-mortise-profile /explicit/mortise/profile \
  --source-pi-profile /explicit/pi/agent --json
```

Verification levels are cumulative evidence, not interchangeable labels:

- `scenario-verified`: real production components and command/state-machine actions with controlled dependencies.
- `renderer-verified`: real renderer plus physical mouse, keyboard, clipboard, composition, rich-text, shortcut, or drag input.
- `native-verified`: Electron/native window, application menu, or platform dialog operation.

Run the focused and real-host suites with:

```bash
bun run test:mortise-ui
bun run test:ui-validation:electron
bun run test:ui-validation:extension
bun run test:ui-validation:recovery
bun run test:ui-validation:runtime-contract
bun run test:ui-validation:surface-parity
MORTISE_UI_STABILITY_SURFACES=webui,electron MORTISE_UI_STABILITY_ITERATIONS=10 bun run test:ui-validation:stability
bun run test:ui-validation:raw-host-smoke
```

`runtime-contract` drives the public fault, frozen-clock, physical retry, and idempotent reset APIs against a real Electron renderer. `surface-parity` applies the same real AppShell scenario to WebUI and Electron and compares stable semantic roles, actions, and state. They are explicit source-development acceptance checks and are not part of the fast unit suite.

`test:electron:chat-real` now uses only `mortise-ui`. It deliberately refuses implicit access to a home profile:

```bash
MORTISE_E2E_SOURCE_PROFILE=/explicit/mortise/profile \
MORTISE_E2E_SOURCE_PI_PROFILE=/explicit/pi/agent \
bun run test:electron:chat-real
```

Every failed host command captures a redacted evidence bundle. Electron and WebUI bundles have a stable full/incremental snapshot pair, screenshot, state/event interval, console and page errors, network summary, runtime log, driver data, route/scenario/seed/viewport, and verification level. Electron also includes fixed main-process diagnostics without an evaluation API.
