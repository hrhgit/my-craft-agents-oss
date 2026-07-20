# Mortise UI Validation

The Developer Kit ships a self-contained AI-operated validation CLI and a
version-matched Developer Host. Run commands from the Developer Kit root so the
examples resolve `bin\mortise-ui.exe` without relying on a Mortise source
checkout or Bun installation.

## Start A Run

Use a short semantic label for routine commands. The CLI also returns an
immutable run ID for exact recovery and disambiguation.

```powershell
bin\mortise-ui.exe start --label extension-check --surface electron --profile fixture --json
bin\mortise-ui.exe runs list --json
bin\mortise-ui.exe runs resume --run extension-check --json
bin\mortise-ui.exe status --run extension-check --json
bin\mortise-ui.exe capabilities relevant --run extension-check --json
bin\mortise-ui.exe snapshot --run extension-check --json
```

Run discovery is designed for AI context recovery through progressive
disclosure. `runs list` shows runs that are live or need attention, followed by
the most recent inactive runs; use `--all` only when older runs are relevant.
`runs resume` returns the recent activity and evidence counts needed to choose
the next action. `runs inspect` is the explicit deep view for raw host status,
the complete manifest, history, and artifact list. `runs prune` previews
inactive cleanup candidates and removes them only when `--apply` is provided.

Electron validation starts in background mode by default. Use foreground mode
only for native menus, system dialogs, or validation that requires a visible
window:

```powershell
bin\mortise-ui.exe start --label native-dialog --surface electron --profile fixture --window-mode foreground --json
```

## Validate An Extension

Mount an extension directly from its development directory. Its `package.json`
must contain Manifest V1 `pi.extensions` entries targeting `mortise`.

```powershell
bin\mortise-ui.exe start --label package-check --surface electron --profile fixture --extension C:\path\to\my-extension --json
```

Repeat `--extension <directory>` to mount multiple packages. The disposable
profile references the source directories without copying them, so local
dependencies and extension reloads continue to resolve from the development
workspace.

Inspect the capability catalog before composing a flow, then use targets and
revisions returned by the latest snapshot:

```powershell
bin\mortise-ui.exe capabilities relevant --run package-check --json
bin\mortise-ui.exe open --run package-check --params '{"route":{"surface":"settings","section":"extensions"}}' --json
bin\mortise-ui.exe snapshot --run package-check --json
bin\mortise-ui.exe action --run package-check --params '{"target":{"semanticId":"replace-with-briefing-semantic-id"},"action":"click"}' --json
```

Snapshots default to the state, attention-first targets, and contextual next
actions needed for the current decision. They also report what was omitted and
the exact command that reveals it. Use `--full-observation` only to inspect raw
semantic regions or diagnose a target that is absent from the briefing.
Actions automatically observe the settled UI and return a compact receipt,
change counts, and the post-action briefing; node-level changes remain behind
the same `--full-observation` boundary.

`start`, `status`, and `stop` follow the same rule: normal output contains the
outcome and continuation state, while `runs inspect` or the lifecycle `--full`
flag exposes manifest and host internals for diagnostics.

## Fixture Data

The default fixture opens a populated, credential-free product profile. For a
custom disposable scene, inspect the bounded schema and pass a fixture file:

```powershell
bin\mortise-ui.exe fixture schema --json
bin\mortise-ui.exe start --label fixture-scene --surface electron --profile fixture --fixture C:\path\to\fixture.json --json
```

Use `isolated` only for onboarding or pristine-profile behavior. Clone mode is
reserved for checks that explicitly require copied user configuration; it
redirects all writes into the run directory.

```powershell
bin\mortise-ui.exe start --label provider-clone --surface electron --profile clone --source-mortise-profile C:\path\to\.mortise --source-pi-profile C:\path\to\.pi\agent --json
```

## Evidence And Cleanup

Capture evidence after exercising the changed workflow, then stop the run so
its disposable profile can be reclaimed:

```powershell
bin\mortise-ui.exe evidence --run extension-check --params '{"label":"extension-check"}' --json
bin\mortise-ui.exe stop --run extension-check --json
bin\mortise-ui.exe runs prune --keep 20 --older-than-hours 168 --json
```

Failed host commands preserve a redacted evidence bundle with semantic state,
screenshots, events, console and page errors, network summary, runtime logs,
driver data, and verification level. Treat `scenario-verified`,
`renderer-verified`, and `native-verified` as cumulative evidence levels.
The default `evidence` response shows counts plus one recent representative per
category. Use `--full-evidence` when every artifact path or the raw host bundle
is necessary.

## Verify The Package

The bundled smoke runs the compiled CLI from a temporary working directory with
no source checkout or Bun command available through `PATH`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\smoke.ps1
```

The source-development test and architecture guide is included separately at
`docs/source-development-testing.md`. Its Bun commands apply only inside a
Mortise source checkout.
