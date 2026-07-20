# Mortise Runtime Logs

`bin\mortise-logs.exe` queries the local Mortise runtime JSONL without sending data to a model or remote service. It is distributed only with the Developer Kit; normal sessions and extensions do not receive global log access.

The default output is a compact JSON evidence envelope. It states observable facts and correlation gaps, but leaves root-cause analysis to the calling AI. Full payloads are omitted unless explicitly requested, and every output mode remains redacted.

```powershell
bin\mortise-logs.exe recent
bin\mortise-logs.exe search --scope capability --level warn
bin\mortise-logs.exe trace <session-or-request-id>
bin\mortise-logs.exe show --event-id <event-id> --detail
bin\mortise-logs.exe tail --scope browser-command
bin\mortise-logs.exe health
```

Use `--detail` for normalized event fields and `--raw` only when the compact evidence is insufficient. Results default to 20 items, are capped at 100 items and 256 KB, and return an executable continuation when more matching evidence exists.

The default path is `%USERPROFILE%\.mortise\logs\runtime.log`. Set `MORTISE_CONFIG_DIR` or pass `--log-path` to inspect an isolated or non-default profile.
