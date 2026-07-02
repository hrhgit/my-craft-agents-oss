param(
  [ValidateSet("dev", "start", "server-dev", "webui-dev")]
  [string]$Mode = "dev",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

function Write-Step {
  param([string]$Message)
  Write-Host "[Craft Agents] $Message" -ForegroundColor Cyan
}

function Fail-And-Wait {
  param(
    [string]$Message,
    [int]$ExitCode = 1
  )

  Write-Host ""
  Write-Host $Message -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit $ExitCode
}

function Ensure-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail-And-Wait "Missing required command: $Name. Please install it first."
  }
}

Ensure-Command "bun"

$nodeModulesPath = Join-Path $repoRoot "node_modules"
if (-not (Test-Path $nodeModulesPath)) {
  if ($SkipInstall) {
    Fail-And-Wait "node_modules is missing and -SkipInstall was provided."
  }

  Write-Step "node_modules not found, running bun install..."
  & bun install
  if ($LASTEXITCODE -ne 0) {
    Fail-And-Wait "bun install failed." $LASTEXITCODE
  }
}

$bunArgs = switch ($Mode) {
  "dev" { @("run", "electron:dev") }
  "start" { @("run", "electron:start") }
  "server-dev" { @("run", "server:dev") }
  "webui-dev" { @("run", "webui:dev") }
  default { throw "Unsupported mode: $Mode" }
}

$modeLabel = switch ($Mode) {
  "dev" { "Electron hot-reload dev mode" }
  "start" { "Electron local build-and-run mode" }
  "server-dev" { "Server development mode" }
  "webui-dev" { "Web UI development mode" }
}

Write-Step "Repository: $repoRoot"
Write-Step "Starting $modeLabel"
Write-Step ("Command: bun " + ($bunArgs -join " "))
Write-Host ""

& bun @bunArgs
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Fail-And-Wait "Startup failed with exit code $exitCode." $exitCode
}
