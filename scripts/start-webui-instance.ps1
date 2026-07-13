$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcherStateRoot = Join-Path $repoRoot '.craft-agent\portmux'
$launchStatePath = Join-Path $env:TEMP 'craft-agent-webui\instance-1\webui-launch-state.json'
. (Join-Path $PSScriptRoot 'webui-process-utils.ps1')

if (-not (Get-Command portmux -ErrorAction SilentlyContinue)) {
  throw 'portmux is required to start the WebUI test environment.'
}

New-Item -ItemType Directory -Force $launcherStateRoot | Out-Null

function Open-ExclusiveFile {
  param([string]$Path)

  try {
    return [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    return $null
  }
}

function Get-RunningWebuiUrl {
  $port = Get-WebuiAssignedPort -ProjectPath $repoRoot
  if ($null -eq $port -or $port -ge 65535) { return $null }
  if ((Test-Path -LiteralPath $launchStatePath) -and
      -not (Test-WebuiLaunchStateActive -Path $launchStatePath)) {
    return $null
  }
  if (-not (Test-WebuiHttpReady -Port $port) -or -not (Test-WebuiTcpPort -Port ($port + 1))) {
    return $null
  }
  return "http://localhost:$port"
}

function Open-WebuiUrl {
  param([string]$Url)

  Write-Host "[Craft Agents Web] Opening shared WebUI: $Url" -ForegroundColor Cyan
  Start-Process $Url
}

function Clear-StaleWebuiLaunch {
  $state = Read-WebuiLaunchState $launchStatePath
  if ($null -eq $state -or (Test-WebuiProcessRecordActive $state.launcher)) { return }
  if ((Normalize-WebuiPath ([string]$state.repoRoot)) -ne (Normalize-WebuiPath $repoRoot)) { return }

  $webuiPort = [int]$state.webuiPort
  $rpcPort = [int]$state.rpcPort
  $stopped = Stop-WebuiLaunchState -Path $launchStatePath
  if (Stop-LegacyWebuiViteProcess -RepoRoot $repoRoot -WebuiPort $webuiPort) { $stopped++ }
  if (Stop-LegacyWebuiRpcProcess -WebuiPort $webuiPort -RpcPort $rpcPort) { $stopped++ }
  if ($stopped -gt 0) {
    Write-Host "[Craft Agents Web] Cleaned up $stopped stale WebUI process tree(s) before requesting a port." -ForegroundColor Cyan
  }
}

$existingUrl = Get-RunningWebuiUrl
if ($null -ne $existingUrl) {
  Open-WebuiUrl $existingUrl
  exit 0
}

$primaryLockPath = Join-Path $launcherStateRoot 'webui-primary.lock'
$primaryLock = Open-ExclusiveFile $primaryLockPath

if ($null -eq $primaryLock) {
  Write-Host '[Craft Agents Web] The shared WebUI is starting. Waiting for its URL...' -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds(180)
  do {
    Start-Sleep -Milliseconds 250
    $existingUrl = Get-RunningWebuiUrl
    if ($null -ne $existingUrl) {
      Open-WebuiUrl $existingUrl
      exit 0
    }

    # If the first launcher failed, take over and start the shared service.
    $primaryLock = Open-ExclusiveFile $primaryLockPath
  } while ($null -eq $primaryLock -and (Get-Date) -lt $deadline)

  if ($null -eq $primaryLock) {
    throw 'Timed out waiting for the shared WebUI to start.'
  }
}

try {
  $existingUrl = Get-RunningWebuiUrl
  if ($null -ne $existingUrl) {
    Open-WebuiUrl $existingUrl
    exit 0
  }

  Clear-StaleWebuiLaunch
  Write-Host '[Craft Agents Web] Starting the shared WebUI with ~/.craft-agent...' -ForegroundColor Cyan
  & portmux start --project $repoRoot
  exit $LASTEXITCODE
} finally {
  if ($null -ne $primaryLock) {
    $primaryLock.Dispose()
  }
}
