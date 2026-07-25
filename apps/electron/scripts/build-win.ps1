[CmdletBinding()]
param(
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$env:MORTISE_UI_VALIDATION_BUILD = "0"
$env:MORTISE_DEV_HOST_BUILD = "0"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronDir = Split-Path -Parent $scriptDir
$repoRoot = Split-Path -Parent (Split-Path -Parent $electronDir)

try {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun not found on PATH."
  }

  Write-Host "Building the Mortise Windows installer through the canonical immutable producer..." -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    bun run electron:dist:win
    if ($LASTEXITCODE -ne 0) {
      throw "Canonical Windows packaging failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  $installer = Get-ChildItem -LiteralPath (Join-Path $electronDir "release") -Filter "*.exe" -File |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if (-not $installer) {
    throw "Windows installer was not produced under $electronDir\release."
  }
  Write-Host "Installer ready: $($installer.FullName)" -ForegroundColor Green
} catch {
  Write-Host "Windows package failed: $_" -ForegroundColor Red
  if (-not $NoPause) { Read-Host "Press Enter to exit" }
  exit 1
}

if (-not $NoPause) { Read-Host "Press Enter to exit" }
