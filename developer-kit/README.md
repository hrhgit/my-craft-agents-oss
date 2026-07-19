# Mortise Developer Kit

The Mortise Developer Kit is an optional, separately packaged extension-authoring toolset. It is not required to install or run Mortise.

The kit contains:

- `bin/mortise-ui.exe`: the AI-operable UI validation CLI.
- `dev-host/`: a version-matched Mortise Developer Host with the validation control plane enabled.
- `docs/`: extension, CLI, and validation authoring guides.
- `examples/`: complete extension packages, including Manifest V1.
- `schemas/`: machine-readable extension authoring schemas.
- `developer-kit.json`: exact kit, host, and protocol compatibility metadata.

## Quick Start

```powershell
bin\mortise-ui.exe start --surface electron --profile fixture
bin\mortise-ui.exe capabilities list --kind scenario
bin\mortise-ui.exe snapshot
bin\mortise-ui.exe stop
```

To load an extension directly from its development directory without copying its source or using the global Pi profile:

```powershell
bin\mortise-ui.exe start --surface electron --profile fixture --extension C:\path\to\my-extension
```

Repeat `--extension <directory>` to mount more than one package. Each directory must contain `package.json` with Manifest V1 `pi.extensions` entries targeting `mortise`. The CLI registers absolute entry paths only inside the disposable profile, so extension-local dependencies and **Settings > Extensions > Reload extensions** continue to resolve from the development directory.

The Developer Host uses an isolated profile, a per-run random authentication token, and a loopback-only endpoint. It has a separate application identity and does not register the production `mortise://` protocol.

On Windows, native snapshots and actions use the UI Automation driver bundled under `dev-host/resources/ui-validation`; they do not depend on a source checkout.

Use `--profile clone --source-mortise-profile <path> --source-pi-profile <path>` only when validation explicitly requires copied user configuration. The clone is placed inside the run directory; the Developer Host never mutates the selected source profile.

The kit validates extensions against its bundled Host version. Read `docs/pi-extensions.md` for the package manifest, contribution, settings, and validation contracts.

Copy `examples/manifest-v1/` into `~/.pi/agent/extensions/` to run the minimal packaged example. Use `schemas/extension-manifest-v1.schema.json` in editor or CI validation; the bundled Host remains authoritative for SemVer ranges and cross-extension diagnostics.
