$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$normalizedRepoRoot = $repoRoot.TrimEnd('\').ToLowerInvariant()
$legacyInstanceRoot = Join-Path $repoRoot '.craft-agent\portmux\webui-instance-'
$normalizedLegacyInstanceRoot = $legacyInstanceRoot.ToLowerInvariant()
$clientProjectRoot = Join-Path $env:TEMP 'craft-agent-webui\portmux\client-'
$normalizedClientProjectRoot = $clientProjectRoot.ToLowerInvariant()
. (Join-Path $PSScriptRoot 'webui-process-utils.ps1')

function Write-Step {
  param([string]$Message)
  Write-Host "[Craft Agents Web] $Message" -ForegroundColor Cyan
}

function Normalize-PathText {
  param([string]$Value)
  return $Value.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Test-IsWebuiProject {
  param([string]$ProjectPath)
  $normalized = Normalize-PathText $ProjectPath
  return $normalized -eq $normalizedRepoRoot -or
    $normalized.StartsWith($normalizedLegacyInstanceRoot) -or
    $normalized.StartsWith($normalizedClientProjectRoot)
}

$statusText = (& portmux --json status 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to read portmux status: $($statusText.Trim())"
}
$status = $statusText | ConvertFrom-Json
$projects = @($status.data.projects | Where-Object { Test-IsWebuiProject $_.project_path })

$stoppedManagedProjectCount = 0
foreach ($project in $projects) {
  $resultText = (& portmux --json stop --project $project.project_path 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to stop portmux project '$($project.project_path)': $($resultText.Trim())"
  }
  $result = $resultText | ConvertFrom-Json
  if ($result.data.was_running) {
    $stoppedManagedProjectCount++
  }
}

$stoppedStateProcessCount = 0
$stateRoot = Join-Path $env:TEMP 'craft-agent-webui'
if (Test-Path -LiteralPath $stateRoot) {
  Get-ChildItem -LiteralPath $stateRoot -Filter 'webui-launch-state.json' -File -Recurse |
    ForEach-Object {
      $stoppedStateProcessCount += Stop-WebuiLaunchState -Path $_.FullName -Force
    }
}

$stoppedLegacyViteCount = 0
$stoppedLegacyRpcCount = 0
foreach ($project in $projects) {
  if ($null -eq $project.assigned_port -or [int]$project.assigned_port -ge 65535) { continue }
  $webuiPort = [int]$project.assigned_port
  if (Stop-LegacyWebuiViteProcess -RepoRoot $repoRoot -WebuiPort $webuiPort) {
    $stoppedLegacyViteCount++
  }
  if (Stop-LegacyWebuiRpcProcess -WebuiPort $webuiPort -RpcPort ($webuiPort + 1)) {
    $stoppedLegacyRpcCount++
  }
}

# Migration fallback for WebUIs launched before portmux recorded managed PIDs.
$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$processById = @{}
foreach ($process in $processes) {
  $processById[[int]$process.ProcessId] = $process
}

$fallbackRoots = [System.Collections.Generic.HashSet[int]]::new()
foreach ($process in $processes) {
  $commandLine = [string]$process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }

  $normalizedCommandLine = $commandLine.Replace('/', '\').ToLowerInvariant()
  $isRepoWebui = $normalizedCommandLine.Contains($normalizedRepoRoot) -and (
    $normalizedCommandLine.Contains('apps\webui\vite.config.ts') -or
    $normalizedCommandLine.Contains('scripts\start-webui-instance.ps1')
  )
  if (-not $isRepoWebui) { continue }

  $rootPid = [int]$process.ProcessId
  $cursor = $process
  while ($null -ne $cursor -and $processById.ContainsKey([int]$cursor.ParentProcessId)) {
    $parent = $processById[[int]$cursor.ParentProcessId]
    $parentCommandLine = ([string]$parent.CommandLine).Replace('/', '\').ToLowerInvariant()
    if ($parentCommandLine.Contains($normalizedRepoRoot) -and (
      $parentCommandLine.Contains('scripts\start-webui.ps1') -or
      $parentCommandLine.Contains('scripts\start-webui-instance.ps1') -or
      ($parentCommandLine.Contains('portmux') -and $parentCommandLine.Contains(' start '))
    )) {
      $rootPid = [int]$parent.ProcessId
    }
    $cursor = $parent
  }
  $null = $fallbackRoots.Add($rootPid)
}

foreach ($rootPid in $fallbackRoots) {
  Write-Step "Stopping legacy WebUI process tree (PID $rootPid)..."
  & taskkill.exe /PID $rootPid /T /F *> $null
}

if ($stoppedManagedProjectCount -eq 0 -and
    $stoppedStateProcessCount -eq 0 -and
    $stoppedLegacyViteCount -eq 0 -and
    $stoppedLegacyRpcCount -eq 0 -and
    $fallbackRoots.Count -eq 0) {
  Write-Step 'No running WebUI processes found.'
} else {
  Write-Step "Stopped all WebUI processes ($stoppedManagedProjectCount managed project(s), $stoppedStateProcessCount state-tracked tree(s), $stoppedLegacyViteCount orphaned Vite tree(s), $stoppedLegacyRpcCount orphaned RPC tree(s), $($fallbackRoots.Count) legacy launcher tree(s))."
}
