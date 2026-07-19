[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$NoOpenOutput
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildScript = Join-Path $repoRoot "apps\electron\scripts\build-win.ps1"
$releaseDir = Join-Path $repoRoot "apps\electron\release"

function Write-Step {
  param([string]$Message)
  Write-Host "[Mortise] $Message" -ForegroundColor Cyan
}

function Ensure-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Ensure-Command "powershell"
Ensure-Command "bun"

if (-not (Test-Path $buildScript)) {
  throw "Build script not found: $buildScript"
}

Write-Step "Repository: $repoRoot"
Write-Step "Using build script: $buildScript"
Write-Step "Expected output directory: $releaseDir"

if (-not $PSCmdlet.ShouldProcess("Windows installer", "Build package")) {
  return
}

& powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $buildScript
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  throw "Packaging failed with exit code $exitCode."
}

if (-not (Test-Path $releaseDir)) {
  throw "Output directory was not created: $releaseDir"
}

$installer = Get-ChildItem -Path $releaseDir -Filter "*.exe" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "No installer was found in $releaseDir"
}

Write-Step "Installer ready: $($installer.FullName)"

if (-not $NoOpenOutput) {
  Write-Step "Opening output folder..."
  Start-Process explorer.exe $releaseDir
}
