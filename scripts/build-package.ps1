[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$NoOpenOutput
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
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

Write-Step "Repository: $repoRoot"
Write-Step "Using canonical command: bun run electron:dist:win"
Write-Step "Expected output directory: $releaseDir"

if (-not $PSCmdlet.ShouldProcess("Windows installer", "Build package")) {
  return
}

Push-Location $repoRoot
try {
  bun run electron:dist:win
  if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
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
