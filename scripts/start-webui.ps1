param(
  [switch]$SkipInstall,
  [switch]$NoBrowser,
  [switch]$PortmuxManaged,
  [int]$Instance = 0
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot
. (Join-Path $PSScriptRoot 'webui-process-utils.ps1')

function Write-Step {
  param([string]$Message)
  Write-Host "[Mortise Web] $Message" -ForegroundColor Cyan
}

function Fail-And-Wait {
  param(
    [string]$Message,
    [int]$ExitCode = 1
  )

  Write-Host ""
  Write-Host $Message -ForegroundColor Red
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

  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
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

$webuiInstance = 1
$webuiPort = if ($env:MORTISE_WEBUI_PORT) {
  Get-Port "MORTISE_WEBUI_PORT" 5175
} elseif ($env:PORT) {
  Get-Port "PORT" 5175
} else {
  if ($PortmuxManaged) {
    Fail-And-Wait "portmux did not provide MORTISE_WEBUI_PORT or PORT. Check .portmux.json and run portmux doctor."
  }
  5175
}
if ($webuiPort -ge 65535) {
  Fail-And-Wait "MORTISE_WEBUI_PORT must be below 65535 so the derived RPC port remains valid."
}

$rpcPort = if (-not $PortmuxManaged -and $env:MORTISE_RPC_PORT) {
  Get-Port "MORTISE_RPC_PORT" 9100
} else {
  $webuiPort + 1
}

$logDir = Join-Path $env:TEMP "mortise-webui\instance-$webuiInstance"
New-Item -ItemType Directory -Force $logDir | Out-Null
$launchStatePath = Join-Path $logDir 'webui-launch-state.json'
$staleProcessCount = Stop-WebuiLaunchState -Path $launchStatePath
if ($staleProcessCount -gt 0) {
  Write-Step "Cleaned up $staleProcessCount stale WebUI process tree(s) from the previous launch."
}
$completeWebuiAlreadyRunning = (Test-WebuiHttpReady -Port $webuiPort) -and (Test-WebuiTcpPort $rpcPort)
if (-not $completeWebuiAlreadyRunning) {
  if (Stop-LegacyWebuiViteProcess -RepoRoot $repoRoot -WebuiPort $webuiPort) {
    Write-Step "Cleaned up a legacy orphaned Vite process on port $webuiPort."
  }
  if (Stop-LegacyWebuiRpcProcess -WebuiPort $webuiPort -RpcPort $rpcPort) {
    Write-Step "Cleaned up a legacy orphaned RPC process on port $rpcPort."
  }
}

foreach ($port in @($webuiPort, $rpcPort)) {
  if (-not (Test-PortAvailable $port)) {
    Fail-And-Wait "Port $port cannot be bound. Close the conflicting process, or run start-webui.cmd again if the shared WebUI is already running."
  }
}

$env:MORTISE_SERVER_TOKEN = New-DevelopmentToken
$env:MORTISE_RPC_HOST = "127.0.0.1"
$env:MORTISE_RPC_PORT = "$rpcPort"
$env:MORTISE_WEBUI_PORT = "$webuiPort"
$env:MORTISE_WEBUI_INSTANCE = "$webuiInstance"
$env:MORTISE_CONFIG_DIR = Join-Path ([Environment]::GetFolderPath('UserProfile')) ".mortise"
# Vite serves the application in development. The RPC server only needs the
# source login page so it can host auth/API routes without a production build.
$env:MORTISE_WEBUI_DIR = (Join-Path $repoRoot "apps\webui\src")
$env:MORTISE_WEBUI_AUTO_LOGIN = "true"
$env:MORTISE_WEBUI_HOST = "127.0.0.1"
$env:MORTISE_WEBUI_WS_URL = "ws://localhost:$webuiPort/ws"
$env:MORTISE_BUNDLED_ASSETS_ROOT = (Join-Path $repoRoot "apps\electron")
$env:MORTISE_DEBUG = "true"

$bunPath = (Get-Command bun).Source
$vitePath = Join-Path $repoRoot "node_modules\.bin\vite.exe"
if (-not (Test-Path $vitePath)) {
  Fail-And-Wait "Vite executable not found at $vitePath. Run bun install first."
}
$serverErrorLog = Join-Path $logDir "webui-server.error.log"
$viteErrorLog = Join-Path $logDir "webui-vite.error.log"
$viteStandardInput = Join-Path $logDir 'webui-vite.stdin'
New-Item -ItemType File -Force $viteStandardInput | Out-Null
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$launcherProcess = Get-Process -Id $PID

function Save-LaunchState {
  Write-WebuiLaunchState `
    -Path $launchStatePath `
    -LauncherProcess $launcherProcess `
    -ChildProcesses $processes `
    -RepoRoot $repoRoot `
    -WebuiPort $webuiPort `
    -RpcPort $rpcPort
}

function Start-HeadlessServer {
  param([int]$RestartAttempt = 0)

  $suffix = if ($RestartAttempt -gt 0) { ".restart-$RestartAttempt" } else { "" }
  $stdoutLog = Join-Path $logDir "webui-server$suffix.log"
  $stderrLog = Join-Path $logDir "webui-server$suffix.error.log"
  $script = if ($RestartAttempt -gt 0) { "server:dev:runtime" } else { "server:dev:webui" }

  $process = Start-Process -FilePath $bunPath `
    -ArgumentList @("run", $script) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
  $processes.Add($process)

  return @{
    Process = $process
    StdoutLog = $stdoutLog
    StderrLog = $stderrLog
    StartedAt = Get-Date
  }
}

try {
  Write-Step "Starting WebUI instance $webuiInstance (config: $env:MORTISE_CONFIG_DIR)..."
  $serverState = Start-HeadlessServer
  $server = $serverState.Process
  Save-LaunchState

  Write-Step "Starting Vite WebUI dev server..."
  $webui = Start-Process -FilePath $vitePath `
    -ArgumentList @("dev", "--config", "apps/webui/vite.config.ts") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardInput $viteStandardInput `
    -RedirectStandardOutput (Join-Path $logDir "webui-vite.log") `
    -RedirectStandardError $viteErrorLog `
    -PassThru
  $processes.Add($webui)
  Save-LaunchState

  if (-not (Wait-ForPort $rpcPort)) {
    throw "Headless server did not start on ws://127.0.0.1:$rpcPort within 180 seconds. See $serverErrorLog."
  }
  if (-not (Wait-ForPort $webuiPort)) {
    throw "WebUI dev server did not start on http://localhost:$webuiPort within 180 seconds. See $viteErrorLog."
  }

  $testModeQuery = if ($env:MORTISE_TEST_MODE -eq "1") { "?mortiseTestMode=1" } else { "" }
  $webuiUrl = "http://localhost:$webuiPort$testModeQuery"
  Write-Step "WebUI is ready: $webuiUrl (RPC: ws://127.0.0.1:$rpcPort)"
  if (-not $NoBrowser -and $env:MORTISE_WEBUI_NO_BROWSER -ne "1") {
    Start-Process $webuiUrl
  }

  $restartAttempt = 0
  $rpcUnavailableChecks = 0
  while (-not $webui.HasExited) {
    if (-not $server.HasExited -and (Test-PortAvailable $rpcPort)) {
      $rpcUnavailableChecks++
      if ($rpcUnavailableChecks -ge 10) {
        Write-Host ""
        Write-Host "[Mortise Web] Headless server process is alive but RPC port $rpcPort has been unavailable for 5 seconds. Recycling the process tree..." -ForegroundColor Yellow
        & taskkill.exe /PID $server.Id /T /F *> $null
      }
    } else {
      $rpcUnavailableChecks = 0
    }

    if ($server.HasExited) {
      $uptime = (Get-Date) - $serverState.StartedAt
      if ($uptime.TotalSeconds -ge 30) {
        $restartAttempt = 0
      }
      $restartAttempt++
      $delaySeconds = [Math]::Min([Math]::Pow(2, $restartAttempt - 1), 10)

      Write-Host ""
      Write-Host "[Mortise Web] Headless server exited with code $($server.ExitCode). Restarting in ${delaySeconds}s..." -ForegroundColor Yellow
      Write-Host "[Mortise Web] Server logs: $($serverState.StdoutLog), $($serverState.StderrLog)" -ForegroundColor DarkYellow
      Start-Sleep -Seconds $delaySeconds

      $serverState = Start-HeadlessServer -RestartAttempt $restartAttempt
      $server = $serverState.Process
      Save-LaunchState
      $rpcUnavailableChecks = 0
      Write-Step "Headless server restart attempt $restartAttempt started (PID $($server.Id))."

      if (-not (Wait-ForPort $rpcPort 60)) {
        Write-Host "[Mortise Web] Restart attempt $restartAttempt did not bind port $rpcPort within 60 seconds; monitoring will retry if it exits." -ForegroundColor Yellow
      } else {
        Write-Step "Headless server recovered on ws://127.0.0.1:$rpcPort. The WebUI will reconnect automatically."
      }
    }
    Start-Sleep -Milliseconds 500
  }

  throw "Vite WebUI exited with code $($webui.ExitCode). See $viteErrorLog."
} catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  foreach ($process in $processes) {
    $record = New-WebuiProcessRecord $process
    if ($null -ne $record) { $null = Stop-WebuiProcessRecord $record }
  }
  Remove-WebuiLaunchState -Path $launchStatePath -LauncherProcess $launcherProcess
}
