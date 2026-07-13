$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcherStateRoot = Join-Path $repoRoot '.craft-agent\portmux'

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
  $escapedRepoRoot = [Regex]::Escape($repoRoot)
  $viteProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -match $escapedRepoRoot -and
        $_.CommandLine -match 'vite\.js.+apps[\\/]webui[\\/]vite\.config\.ts'
      } |
      Sort-Object CreationDate
  )

  foreach ($process in $viteProcesses) {
    $listener = Get-NetTCPConnection -State Listen -OwningProcess $process.ProcessId -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') } |
      Sort-Object LocalPort |
      Select-Object -First 1
    if ($null -ne $listener) {
      return "http://localhost:$($listener.LocalPort)"
    }
  }

  return $null
}

function Open-WebuiUrl {
  param([string]$Url)

  Write-Host "[Craft Agents Web] Opening shared WebUI: $Url" -ForegroundColor Cyan
  Start-Process $Url
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

  Write-Host '[Craft Agents Web] Starting the shared WebUI with ~/.craft-agent...' -ForegroundColor Cyan
  & portmux start --project $repoRoot
  exit $LASTEXITCODE
} finally {
  if ($null -ne $primaryLock) {
    $primaryLock.Dispose()
  }
}
