[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$NoArchive,
  [switch]$Worker,
  [string]$OutputRoot
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Worker) {
  $orchestratorArgs = @("run", (Join-Path $repoRoot "scripts\build-developer-kit.ts"))
  if ($NoArchive) { $orchestratorArgs += "--no-archive" }
  & bun @orchestratorArgs
  if ($LASTEXITCODE -ne 0) { throw "Developer Kit orchestrator failed with exit code $LASTEXITCODE" }
  return
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { throw "-OutputRoot is required in Developer Kit worker mode" }
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$electronDir = Join-Path $repoRoot "apps\electron"
$kitPackage = Get-Content -Raw (Join-Path $repoRoot "developer-kit\package.json") | ConvertFrom-Json
$hostPackage = Get-Content -Raw (Join-Path $electronDir "package.json") | ConvertFrom-Json
$kitName = "mortise-developer-kit-$($kitPackage.version)-win-x64"
$kitDir = Join-Path $outputRoot $kitName
$archivePath = "$kitDir.zip"
$devHostOutput = Join-Path $electronDir "release-devhost"

function Assert-ChildPath {
  param([string]$Path, [string]$Parent)
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify path outside $Parent`: $fullPath"
  }
}

function Invoke-Checked {
  param([scriptblock]$Command, [string]$Description)
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

Assert-ChildPath $kitDir $outputRoot
Assert-ChildPath $archivePath $outputRoot
Assert-ChildPath $devHostOutput $electronDir

if (-not $PSCmdlet.ShouldProcess($kitDir, "Build Mortise Developer Kit")) { return }

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
foreach ($path in @($kitDir, $archivePath, $devHostOutput)) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}

$previousValidationBuild = $env:MORTISE_UI_VALIDATION_BUILD
$previousDevHostBuild = $env:MORTISE_DEV_HOST_BUILD
try {
  $env:MORTISE_UI_VALIDATION_BUILD = "1"
  $env:MORTISE_DEV_HOST_BUILD = "1"
  Invoke-Checked { bun run pi:build } "Pi workspace build"
  Invoke-Checked { bun run pi:build:binary } "Pi binary build"
  Invoke-Checked { bun run electron:build } "Developer Host build"

  Push-Location $electronDir
  try {
    Invoke-Checked { bunx electron-builder --config electron-builder.devhost.yml --win --x64 --dir } "Developer Host packaging"
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $previousValidationBuild) { Remove-Item Env:MORTISE_UI_VALIDATION_BUILD -ErrorAction SilentlyContinue }
  else { $env:MORTISE_UI_VALIDATION_BUILD = $previousValidationBuild }
  if ($null -eq $previousDevHostBuild) { Remove-Item Env:MORTISE_DEV_HOST_BUILD -ErrorAction SilentlyContinue }
  else { $env:MORTISE_DEV_HOST_BUILD = $previousDevHostBuild }
}

$unpackedHost = Join-Path $devHostOutput "win-unpacked"
if (-not (Test-Path -LiteralPath (Join-Path $unpackedHost "Mortise Developer Host.exe"))) {
  throw "Packaged Developer Host executable not found in $unpackedHost"
}

New-Item -ItemType Directory -Force -Path (Join-Path $kitDir "bin"), (Join-Path $kitDir "docs") | Out-Null
Copy-Item -LiteralPath $unpackedHost -Destination (Join-Path $kitDir "dev-host") -Recurse

$uiValidationResources = Join-Path $kitDir "dev-host\resources\ui-validation"
$uiAutomationDriver = Join-Path $uiValidationResources "windows-uia-driver.ps1"
New-Item -ItemType Directory -Force -Path $uiValidationResources | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\mortise-ui\windows-uia-driver.ps1") -Destination $uiAutomationDriver
if (-not (Test-Path -LiteralPath $uiAutomationDriver)) {
  throw "Packaged Windows UI Automation driver not found at $uiAutomationDriver"
}

$cliOutput = Join-Path $kitDir "bin\mortise-ui.exe"
Invoke-Checked { bun build (Join-Path $repoRoot "scripts\mortise-ui\developer-kit-entry.ts") --compile --outfile $cliOutput } "mortise-ui compilation"

Copy-Item -LiteralPath (Join-Path $repoRoot "developer-kit\README.md") -Destination (Join-Path $kitDir "README.md")
Copy-Item -LiteralPath (Join-Path $electronDir "resources\docs\pi-extensions.md") -Destination (Join-Path $kitDir "docs\pi-extensions.md")
Copy-Item -LiteralPath (Join-Path $electronDir "resources\docs\mortise-cli.md") -Destination (Join-Path $kitDir "docs\mortise-cli.md")
Copy-Item -LiteralPath (Join-Path $repoRoot "docs\testing.md") -Destination (Join-Path $kitDir "docs\ui-validation.md")
Copy-Item -LiteralPath (Join-Path $repoRoot "developer-kit\examples") -Destination (Join-Path $kitDir "examples") -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot "developer-kit\schemas") -Destination (Join-Path $kitDir "schemas") -Recurse

$kitManifest = [ordered]@{
  schemaVersion = 1
  name = "@mortise/developer-kit"
  version = $kitPackage.version
  hostVersion = $hostPackage.version
  uiValidationProtocolVersion = 1
  platform = "win32"
  arch = "x64"
  appId = "io.github.hrhgit.mortise.devhost"
} | ConvertTo-Json
[IO.File]::WriteAllText(
  (Join-Path $kitDir "developer-kit.json"),
  "$kitManifest`n",
  [Text.UTF8Encoding]::new($false)
)

if (-not $NoArchive) {
  Compress-Archive -LiteralPath $kitDir -DestinationPath $archivePath -CompressionLevel Optimal
  Write-Host "[Mortise Developer Kit] Archive ready: $archivePath" -ForegroundColor Cyan
} else {
  Write-Host "[Mortise Developer Kit] Directory ready: $kitDir" -ForegroundColor Cyan
}
