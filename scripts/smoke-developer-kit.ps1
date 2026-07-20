[CmdletBinding()]
param(
  [string]$KitDir
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($KitDir)) {
  $candidateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
  if (Test-Path -LiteralPath (Join-Path $candidateRoot "developer-kit.json")) {
    $KitDir = $candidateRoot
  } else {
    $latestPath = Join-Path $candidateRoot "output\developer-kit-latest.json"
    if (-not (Test-Path -LiteralPath $latestPath)) {
      throw "Developer Kit path was not provided and $latestPath does not exist"
    }
    $KitDir = (Get-Content -Raw -LiteralPath $latestPath | ConvertFrom-Json).artifactDirectory
  }
}

$kitRoot = [IO.Path]::GetFullPath($KitDir)
$cliPath = Join-Path $kitRoot "bin\mortise-ui.exe"
$logsCliPath = Join-Path $kitRoot "bin\mortise-logs.exe"
$packagedGuidePath = Join-Path $kitRoot "docs\ui-validation.md"
$sourceGuidePath = Join-Path $kitRoot "docs\source-development-testing.md"

foreach ($requiredPath in @(
  (Join-Path $kitRoot "developer-kit.json"),
  $cliPath,
  $logsCliPath,
  (Join-Path $kitRoot "dev-host\Mortise Developer Host.exe"),
  $packagedGuidePath,
  $sourceGuidePath
)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Developer Kit smoke prerequisite is missing: $requiredPath"
  }
}

$packagedGuide = Get-Content -Raw -LiteralPath $packagedGuidePath
if ($packagedGuide -notmatch [regex]::Escape('bin\mortise-ui.exe')) {
  throw "Packaged UI validation guide does not use bin\mortise-ui.exe"
}
foreach ($packagedDoc in Get-ChildItem -LiteralPath (Join-Path $kitRoot "docs") -Filter "*.md") {
  if ($packagedDoc.Name -like "source-development-*") { continue }
  if ((Get-Content -Raw -LiteralPath $packagedDoc.FullName) -match 'bun run mortise-ui') {
    throw "Packaged guide contains a source-only mortise-ui invocation: $($packagedDoc.FullName)"
  }
}

$sourceGuide = Get-Content -Raw -LiteralPath $sourceGuidePath
if ($sourceGuide -notmatch 'bun run mortise-ui') {
  throw "Source-development UI validation guide was not preserved separately"
}
$sourcePiExtensionGuide = Get-Content -Raw -LiteralPath (Join-Path $kitRoot "docs\source-development-pi-extensions.md")
if ($sourcePiExtensionGuide -notmatch 'bun run mortise-ui') {
  throw "Source-development extension guide was not preserved separately"
}

$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) "mortise-developer-kit-smoke-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
$previousPath = $env:PATH
$previousBunInstall = $env:BUN_INSTALL
$previousMortiseConfigDir = $env:MORTISE_CONFIG_DIR
try {
  $system32 = Join-Path $env:SystemRoot "System32"
  $env:PATH = "$system32;$env:SystemRoot"
  Remove-Item Env:BUN_INSTALL -ErrorAction SilentlyContinue
  $env:MORTISE_CONFIG_DIR = Join-Path $smokeRoot "profile"
  $runtimeLogsDir = Join-Path $env:MORTISE_CONFIG_DIR "logs"
  New-Item -ItemType Directory -Force -Path $runtimeLogsDir | Out-Null
  $runtimeLogPath = Join-Path $runtimeLogsDir "runtime.log"
  @(
    (@{ schemaVersion = 1; eventId = "smoke-start"; timestamp = "2026-01-01T00:00:00.000Z"; level = "info"; scope = "capability"; event = "started"; correlation = @{ requestId = "smoke-request"; sessionId = "smoke-session" }; data = @{ operation = "execute" } } | ConvertTo-Json -Compress -Depth 5),
    (@{ schemaVersion = 1; eventId = "smoke-timeout"; timestamp = "2026-01-01T00:00:01.000Z"; level = "warn"; scope = "capability"; event = "timed_out"; correlation = @{ requestId = "smoke-request"; sessionId = "smoke-session" }; data = @{ status = "cancelled"; errorCode = "CAPABILITY_TIMEOUT" } } | ConvertTo-Json -Compress -Depth 5)
  ) | Set-Content -LiteralPath $runtimeLogPath -Encoding utf8
  Push-Location $smokeRoot
  try {
    $helpOutput = & $cliPath --help 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Packaged mortise-ui --help failed with exit code $LASTEXITCODE" }
    if (($helpOutput -join "`n") -notmatch 'mortise-ui') { throw "Packaged mortise-ui --help returned unexpected output" }

    $schemaOutput = & $cliPath fixture schema --json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Packaged mortise-ui fixture schema failed with exit code $LASTEXITCODE" }
    $schemaEnvelope = ($schemaOutput | Select-Object -Last 1) | ConvertFrom-Json
    if ($schemaEnvelope.ok -ne $true -or $null -eq $schemaEnvelope.result.schema) {
      throw "Packaged mortise-ui fixture schema returned an invalid response envelope"
    }

    $recentEnvelope = (& $logsCliPath recent | Select-Object -Last 1) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $recentEnvelope.schemaVersion -ne 1 -or $recentEnvelope.evidence.Count -lt 1) {
      throw "Packaged mortise-logs recent returned an invalid response envelope"
    }
    if ($recentEnvelope.evidence[0].PSObject.Properties.Name -contains "data") {
      throw "Packaged mortise-logs recent exposed event data by default"
    }

    $traceEnvelope = (& $logsCliPath trace smoke-request | Select-Object -Last 1) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $traceEnvelope.evidence.Count -ne 2) {
      throw "Packaged mortise-logs trace did not return the correlated smoke events"
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:PATH = $previousPath
  if ($null -eq $previousBunInstall) { Remove-Item Env:BUN_INSTALL -ErrorAction SilentlyContinue }
  else { $env:BUN_INSTALL = $previousBunInstall }
  if ($null -eq $previousMortiseConfigDir) { Remove-Item Env:MORTISE_CONFIG_DIR -ErrorAction SilentlyContinue }
  else { $env:MORTISE_CONFIG_DIR = $previousMortiseConfigDir }
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[Mortise Developer Kit] Packaged CLI smoke passed: $kitRoot" -ForegroundColor Green
