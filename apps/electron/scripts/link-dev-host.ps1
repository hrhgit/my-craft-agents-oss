# Links the staged Developer Host runtime files to the installed Mortise host.
# The installer ships only files that differ between the Developer Host and the
# Mortise application; every entry in dev-host-dedup.json references a host file
# of identical content that was not shipped twice. Hard links keep a complete
# Developer Host runtime on disk while reusing the host payload on the same
# volume; filesystems without hard-link support fall back to a copy.
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"

$developerKitRoot = Join-Path $InstallDir "resources\developer-kit"
$manifestPath = Join-Path $developerKitRoot "dev-host-dedup.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  Write-Output "[Mortise] No Developer Host dedup manifest; nothing to link."
  exit 0
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$devHostRoot = Join-Path $developerKitRoot "dev-host"
$linked = 0
$copied = 0
foreach ($entry in $manifest.entries) {
  $relative = $entry.relative
  if ([string]::IsNullOrWhiteSpace($relative)) { continue }
  $source = Join-Path $InstallDir ($relative -replace "/", "\")
  $target = Join-Path $devHostRoot ($relative -replace "/", "\")
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Force
  }
  try {
    New-Item -ItemType HardLink -Path $target -Target $source | Out-Null
    $linked += 1
  } catch {
    Copy-Item -LiteralPath $source -Destination $target -Force
    $copied += 1
  }
}
Write-Output "[Mortise] Developer Host runtime linked to host ($linked hard links, $copied copies)."
exit 0
