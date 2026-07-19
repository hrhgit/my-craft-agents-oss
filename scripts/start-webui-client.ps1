param(
  [switch]$NoBrowser,
  [switch]$PortmuxManaged,
  [ValidatePattern('^[A-Za-z0-9-]+$')]
  [string]$ClientId
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
. (Join-Path $PSScriptRoot 'webui-process-utils.ps1')

function Write-Step {
  param([string]$Message)
  Write-Host "[Mortise Web client $ClientId] $Message" -ForegroundColor Cyan
}

function Get-AssignedPort {
  $raw = if ($env:MORTISE_WEBUI_PORT) { $env:MORTISE_WEBUI_PORT } else { $env:PORT }
  $port = 0
  if ([string]::IsNullOrWhiteSpace($raw) -or
      -not [int]::TryParse($raw, [ref]$port) -or
      $port -lt 1 -or
      $port -gt 65535) {
    throw 'portmux did not provide a valid MORTISE_WEBUI_PORT or PORT.'
  }
  return $port
}

function Wait-ForHttp {
  param([int]$Port, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-WebuiHttpReady -Port $Port) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

if (-not $PortmuxManaged) {
  throw 'Shared WebUI clients must be launched through portmux.'
}

$endpoint = Get-MortiseServerEndpoint -RequireWebuiAutoLogin
if ($null -eq $endpoint) {
  throw 'No healthy shared Mortise WebUI backend was found. Run start-webui.cmd once to start it.'
}

$webuiPort = Get-AssignedPort
if (Test-WebuiTcpPort -Port $webuiPort) {
  throw "WebUI port $webuiPort is already in use."
}

$rpcUri = [Uri]([string]$endpoint.url)
$rpcPort = $rpcUri.Port
$logDir = Join-Path $env:TEMP "mortise-webui\client-$ClientId"
New-Item -ItemType Directory -Force $logDir | Out-Null
$launchStatePath = Join-Path $logDir 'webui-launch-state.json'
$staleProcessCount = Stop-WebuiLaunchState -Path $launchStatePath
if ($staleProcessCount -gt 0) {
  Write-Step "Cleaned up $staleProcessCount stale client process tree(s)."
}

$vitePath = Join-Path $repoRoot 'node_modules\.bin\vite.exe'
if (-not (Test-Path -LiteralPath $vitePath)) {
  throw 'Vite executable not found. Run bun install first.'
}

$env:MORTISE_RPC_PORT = "$rpcPort"
$env:MORTISE_WEBUI_PORT = "$webuiPort"
$env:MORTISE_WEBUI_INSTANCE = "$ClientId"
$env:MORTISE_WEBUI_HOST = '127.0.0.1'
$env:MORTISE_WEBUI_WS_URL = "ws://localhost:$webuiPort/ws"
$env:MORTISE_CONFIG_DIR = Split-Path -Parent ([string]$endpoint.tokenFile)

$viteInput = Join-Path $logDir 'webui-vite.stdin'
$viteOutput = Join-Path $logDir 'webui-vite.log'
$viteError = Join-Path $logDir 'webui-vite.error.log'
New-Item -ItemType File -Force $viteInput | Out-Null

$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$launcherProcess = Get-Process -Id $PID

try {
  Write-Step "Connecting a new frontend process to shared backend PID $($endpoint.pid) at $($endpoint.url)..."
  $vite = Start-Process -FilePath $vitePath `
    -ArgumentList @('dev', '--config', 'apps/webui/vite.config.ts') `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardInput $viteInput `
    -RedirectStandardOutput $viteOutput `
    -RedirectStandardError $viteError `
    -PassThru
  $processes.Add($vite)
  Write-WebuiLaunchState `
    -Path $launchStatePath `
    -LauncherProcess $launcherProcess `
    -ChildProcesses $processes `
    -RepoRoot $repoRoot `
    -WebuiPort $webuiPort `
    -RpcPort $rpcPort

  if (-not (Wait-ForHttp -Port $webuiPort)) {
    throw "Shared WebUI client did not start on http://localhost:$webuiPort. See $viteError."
  }

  $url = "http://localhost:$webuiPort"
  Write-Step "Ready: $url (shared RPC: $($endpoint.url))"
  if (-not $NoBrowser -and $env:MORTISE_WEBUI_NO_BROWSER -ne '1') {
    Start-Process $url
  }

  $vite.WaitForExit()
  throw "Vite WebUI client exited with code $($vite.ExitCode). See $viteError."
} finally {
  foreach ($process in $processes) {
    $record = New-WebuiProcessRecord $process
    if ($null -ne $record) { $null = Stop-WebuiProcessRecord $record }
  }
  Remove-WebuiLaunchState -Path $launchStatePath -LauncherProcess $launcherProcess
}
