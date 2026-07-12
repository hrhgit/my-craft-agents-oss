param(
  [ValidateRange(1, 100000)]
  [int]$Instance = 1
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$webuiScript = Join-Path $PSScriptRoot 'start-webui.ps1'
$portmuxProject = Join-Path $repoRoot ".craft-agent\portmux\webui-instance-$Instance"
$portmuxConfig = Join-Path $portmuxProject '.portmux.json'
$portmuxLauncher = Join-Path $portmuxProject 'start.ps1'

if (-not (Get-Command portmux -ErrorAction SilentlyContinue)) {
  throw 'portmux is required to start the WebUI test environment.'
}

New-Item -ItemType Directory -Force $portmuxProject | Out-Null

# Each instance has its own portmux project identity, so portmux allocates a
# collision-free base port instead of deriving one from another instance.
$escapedWebuiScript = $webuiScript.Replace("'", "''")
$launcher = "& '$escapedWebuiScript' -PortmuxManaged -Instance $Instance$([Environment]::NewLine)exit `$LASTEXITCODE$([Environment]::NewLine)"
[System.IO.File]::WriteAllText($portmuxLauncher, $launcher, [System.Text.UTF8Encoding]::new($false))

$config = [ordered]@{
  start = 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File start.ps1'
  port_env = @('CRAFT_WEBUI_PORT', 'PORT')
}
$json = ($config | ConvertTo-Json -Depth 3) + [Environment]::NewLine
[System.IO.File]::WriteAllText($portmuxConfig, $json, [System.Text.UTF8Encoding]::new($false))

& portmux start --project $portmuxProject
exit $LASTEXITCODE
