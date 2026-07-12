# Craft Agent Notes

## Runtime Logs

Primary local diagnostic log:

- Windows default: `C:\Users\32858\.craft-agent\logs\runtime.log`
- Portable form: `%USERPROFILE%\.craft-agent\logs\runtime.log`
- Override: if `CRAFT_CONFIG_DIR` is set, use `%CRAFT_CONFIG_DIR%\logs\runtime.log`

The file is JSONL and rotates to `runtime.log.1` at about 5 MB.

Important scopes:

- `scope: "pi-rpc"` records Pi RpcClient subprocess startup, capabilities handshake, lifecycle failures, and full captured stderr.
- `scope: "session"` records Craft session chat failures with session/workspace/model context and structured Error details.

Existing specialized logs remain separate:

- `C:\Users\32858\.craft-agent\logs\messaging-gateway.log`
- `C:\Users\32858\.craft-agent\logs\auto-update.log`
- `C:\Users\32858\.craft-agent\logs\interceptor.log` only exists for non-packaged debug interceptor runs.

Do not treat these as runtime failure logs:

- `C:\Users\32858\.craft-agent\workspaces\<workspace>\events.jsonl` is automation/event history.
- `C:\Users\32858\.pi\agent\sessions\...` stores Pi/Craft session JSONL and sidecar data, not Craft main-process diagnostics.

When investigating "Pi Process Exited", `get_capabilities`, or Windows `EPERM` startup failures, check `runtime.log` first and filter for `scope == "pi-rpc"`.

## Web UI Validation Workflow

For renderer and UI changes, validate in the browser first, then run the relevant Electron smoke check.

- Start the complete local WebUI with `start-webui.cmd` from the repository root.
- The script starts the headless RPC server and Vite WebUI, automatically signs the local browser in, then opens the localhost URL assigned by portmux.
- Automatic login is a development-only localhost flow enabled by the launcher; do not enable it for shared or production servers.
- Keep reusable UI in `apps/electron/src/renderer` or `packages/ui` so WebUI and Electron share the same components and styles.
- Treat `apps/webui/src` as the browser adapter/bootstrap layer. Do not duplicate the main application layout there.
- Browser-only behavior belongs in the Web API adapter or explicit browser shims; native dialogs, menus, IPC, filesystem, subprocess, and window behavior still require Electron verification.
- When comparing the two surfaces, check the same viewport sizes and states in both before changing platform-specific code.
