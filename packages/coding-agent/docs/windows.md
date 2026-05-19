# Windows Setup

Pi uses PowerShell 7 (`pwsh`) by default on Windows. Checked locations (in order):

1. Custom shell from `~/.pi/agent/settings.json`
2. `C:\Program Files\PowerShell\7\pwsh.exe`
3. `C:\Program Files (x86)\PowerShell\7\pwsh.exe`
4. `pwsh` on PATH

For most users, installing [PowerShell 7](https://aka.ms/powershell-release?tag=stable) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "pwsh"
}
```

You can also point `shellPath` at another shell executable, such as `C:\\cygwin64\\bin\\bash.exe`.
