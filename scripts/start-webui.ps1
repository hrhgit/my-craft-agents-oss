param(
  [switch]$SkipInstall,
  [switch]$NoBrowser,
  [switch]$PortmuxManaged
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

function Write-Step {
  param([string]$Message)
  Write-Host "[Craft Agents Web] $Message" -ForegroundColor Cyan
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

function New-DevelopmentToken {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
}

function Test-PortAvailable {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -eq $connection
}

function Get-Port {
  param(
    [string]$Name,
    [int]$Fallback
  )

  $rawValue = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($rawValue)) {
    return $Fallback
  }

  $port = 0
  if (-not [int]::TryParse($rawValue, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    Fail-And-Wait "$Name must be an integer between 1 and 65535; received '$rawValue'."
  }

  return $port
}

function Wait-ForPort {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 180
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (-not (Test-PortAvailable $Port)) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  return $false
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

$webuiPort = Get-Port "CRAFT_WEBUI_PORT" 5175
if ($PortmuxManaged -and -not $env:CRAFT_WEBUI_PORT) {
  Fail-And-Wait "portmux did not provide CRAFT_WEBUI_PORT. Check .portmux.json and run portmux doctor."
}
if ($webuiPort -ge 65535) {
  Fail-And-Wait "CRAFT_WEBUI_PORT must be below 65535 so the derived RPC port remains valid."
}

$rpcPort = if ($env:CRAFT_RPC_PORT) {
  Get-Port "CRAFT_RPC_PORT" 9100
} else {
  $webuiPort + 1
}

foreach ($port in @($webuiPort, $rpcPort)) {
  if (-not (Test-PortAvailable $port)) {
    Fail-And-Wait "Port $port is already in use. Run portmux switch to select another base port, then try again."
  }
}

$env:CRAFT_SERVER_TOKEN = New-DevelopmentToken
$env:CRAFT_RPC_HOST = "127.0.0.1"
$env:CRAFT_RPC_PORT = "$rpcPort"
$env:CRAFT_WEBUI_PORT = "$webuiPort"
if (-not $env:CRAFT_CONFIG_DIR) {
  $env:CRAFT_CONFIG_DIR = Join-Path $repoRoot ".craft-agent\webui-$webuiPort"
}
$env:CRAFT_WEBUI_DIR = (Join-Path $repoRoot "apps\webui\dist")
$env:CRAFT_WEBUI_AUTO_LOGIN = "true"
$env:CRAFT_WEBUI_HOST = "127.0.0.1"
$env:CRAFT_WEBUI_WS_URL = "ws://localhost:$webuiPort/ws"
$env:CRAFT_BUNDLED_ASSETS_ROOT = (Join-Path $repoRoot "apps\electron")
$env:CRAFT_DEBUG = "true"

$bunPath = (Get-Command bun).Source
$vitePath = Join-Path $repoRoot "node_modules\.bin\vite.exe"
if (-not (Test-Path $vitePath)) {
  Fail-And-Wait "Vite executable not found at $vitePath. Run bun install first."
}
$logDir = Join-Path $env:TEMP "craft-agent-webui"
New-Item -ItemType Directory -Force $logDir | Out-Null
$serverErrorLog = Join-Path $logDir "webui-server.error.log"
$viteErrorLog = Join-Path $logDir "webui-vite.error.log"
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

try {
  Write-Step "Starting headless server with WebUI enabled (config: $env:CRAFT_CONFIG_DIR)..."
  $server = Start-Process -FilePath $bunPath `
    -ArgumentList @("run", "server:dev:webui") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "webui-server.log") `
    -RedirectStandardError $serverErrorLog `
    -PassThru
  $processes.Add($server)

  Write-Step "Starting Vite WebUI dev server..."
  $webui = Start-Process -FilePath $vitePath `
    -ArgumentList @("dev", "--config", "apps/webui/vite.config.ts") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "webui-vite.log") `
    -RedirectStandardError $viteErrorLog `
    -PassThru
  $processes.Add($webui)

  if (-not (Wait-ForPort $rpcPort)) {
    throw "Headless server did not start on ws://127.0.0.1:$rpcPort within 180 seconds. See $serverErrorLog."
  }
  if (-not (Wait-ForPort $webuiPort)) {
    throw "WebUI dev server did not start on http://localhost:$webuiPort within 180 seconds. See $viteErrorLog."
  }

  $webuiUrl = "http://localhost:$webuiPort"
  Write-Step "WebUI is ready: $webuiUrl (RPC: ws://127.0.0.1:$rpcPort)"
  if (-not $NoBrowser) {
    Start-Process $webuiUrl
  }

  while ($true) {
    $running = $processes | Where-Object { -not $_.HasExited }
    if (-not $running) { break }
    Start-Sleep -Milliseconds 500
  }
} catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  foreach ($process in $processes) {
    if (-not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F *> $null
    }
  }
}
