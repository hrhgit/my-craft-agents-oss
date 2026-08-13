# Mortise Developer Kit

The Mortise Developer Kit is an extension-authoring and AI-operated UI validation toolset that ships with the Windows installer as a default-selected component. It is not separately versioned: the bundled Developer Host is built from the same source identity as Mortise and is validated against the installed host. The Developer Host reuses the Mortise host runtime through same-volume links and runs as an isolated test instance with its own userData; it does not run without the installed host.

The kit contains:

- `bin/mortise-ui.exe`: the AI-operable UI validation CLI.
- `bin/mortise-logs.exe`: the AI-facing, progressively disclosed runtime-log query CLI.
- `dev-host/`: a version-matched Mortise Developer Host with the validation control plane enabled.
- `docs/`: extension, CLI, and validation authoring guides.
- `examples/`: complete extension packages, including Manifest V1 and the three-extension capability composition example.
- `schemas/`: machine-readable extension authoring schemas.
- `developer-kit.json`: exact kit, host, and protocol compatibility metadata.

## Quick Start

```powershell
bin\mortise-ui.exe start --surface electron --profile fixture
bin\mortise-ui.exe capabilities list --kind scenario
bin\mortise-ui.exe snapshot
bin\mortise-ui.exe stop
bin\mortise-logs.exe recent
```

For repeatable validation, use the workflow contract to validate, run, inspect,
and resume a JSON-defined sequence without losing step-level evidence:

```powershell
bin\mortise-ui.exe workflow validate --file C:\path\to\workflow.json
bin\mortise-ui.exe workflow run --file C:\path\to\workflow.json
```

The full workflow contract, loopback UI development-server overrides, and the
Electron-only `--skip-build` option are documented in `docs\ui-validation.md`.

To load an extension directly from its development directory without copying its source or using the global Mortise profile:

```powershell
bin\mortise-ui.exe start --surface electron --profile fixture --extension C:\path\to\my-extension
```

Repeat `--extension <directory>` to mount more than one package. Each extension has one host-neutral entry in the package's `pi.extensions` array. Host selectors and compatibility shims such as `targets`, `engines`, and the legacy `craft` target are rejected. The CLI registers absolute entry paths only inside the disposable profile, so extension-local dependencies and **Settings > Extensions > Reload extensions** continue to resolve from the development directory.

The Developer Host uses an isolated profile, a per-run random authentication token, and a loopback-only endpoint. It has a separate application identity and does not register the production `mortise://` protocol.

On Windows, native snapshots and actions use the UI Automation driver bundled under `dev-host/resources/ui-validation`; they do not depend on a source checkout.

Use `--profile clone --source-mortise-profile <path>` only when validation explicitly requires copied user configuration. The clone is placed inside the run directory; the Developer Host never mutates the selected source profile.

The kit validates extensions against its bundled Host version. Read `docs/pi-extensions.md` for the package manifest, contribution, settings, and validation contracts.

Copy `examples/manifest-v1/` into `~/.mortise/agent/extensions/` to run the minimal packaged example. Use `schemas/extension-manifest-v1.schema.json` in editor or CI validation; the bundled Host remains authoritative for SemVer ranges and cross-extension diagnostics.

The `examples/extension-services/` package demonstrates `search.query`, optional `knowledge.read`, and a session-scoped compatibility extension that exposes `research.summary` while loading a provider-owned UI module through a capability alias.
