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
