$ErrorActionPreference = 'Stop'

function Normalize-WebuiPath {
  param([Parameter(Mandatory = $true)][string]$Value)

  return $Value.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Test-WebuiTcpPort {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutMilliseconds = 500
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync('127.0.0.1', $Port)
    return $connect.Wait($TimeoutMilliseconds) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-WebuiHttpReady {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 2
  )

  try {
    $response = Invoke-WebRequest `
      -Uri "http://127.0.0.1:$Port/" `
      -UseBasicParsing `
      -TimeoutSec $TimeoutSeconds `
      -ErrorAction Stop
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Get-WebuiPortmuxProjects {
  $statusText = (& portmux --json status 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read portmux status: $($statusText.Trim())"
  }

  $status = $statusText | ConvertFrom-Json
  return @($status.data.projects)
}

function Get-WebuiAssignedPort {
  param([Parameter(Mandatory = $true)][string]$ProjectPath)

  $normalizedProjectPath = Normalize-WebuiPath $ProjectPath
  $project = Get-WebuiPortmuxProjects |
    Where-Object { (Normalize-WebuiPath ([string]$_.project_path)) -eq $normalizedProjectPath } |
    Select-Object -First 1

  if ($null -eq $project -or $null -eq $project.assigned_port) {
    return $null
  }
  return [int]$project.assigned_port
}

function New-WebuiProcessRecord {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  try {
    return [ordered]@{
      pid = [int]$Process.Id
      startedAtUtcTicks = [long]$Process.StartTime.ToUniversalTime().Ticks
    }
  } catch {
    return $null
  }
}

function Test-WebuiProcessRecordActive {
  param([Parameter(Mandatory = $true)]$Record)

  if ($null -eq $Record -or $null -eq $Record.pid -or $null -eq $Record.startedAtUtcTicks) {
    return $false
  }

  try {
    $process = Get-Process -Id ([int]$Record.pid) -ErrorAction Stop
    return [long]$process.StartTime.ToUniversalTime().Ticks -eq [long]$Record.startedAtUtcTicks
  } catch {
    return $false
  }
}

function Write-WebuiLaunchState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$LauncherProcess,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.IEnumerable]$ChildProcesses,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][int]$WebuiPort,
    [Parameter(Mandatory = $true)][int]$RpcPort
  )

  $launcher = New-WebuiProcessRecord $LauncherProcess
  if ($null -eq $launcher) {
    throw 'Unable to capture the WebUI launcher process identity.'
  }

  $children = @(
    foreach ($process in $ChildProcesses) {
      $record = New-WebuiProcessRecord $process
      if ($null -ne $record) { $record }
    }
  )
  $state = [ordered]@{
    schemaVersion = 1
    repoRoot = $RepoRoot
    webuiPort = $WebuiPort
    rpcPort = $RpcPort
    launcher = $launcher
    children = $children
  }

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force $directory | Out-Null
  $temporaryPath = "$Path.$PID.tmp"
  try {
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Read-WebuiLaunchState {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($state.schemaVersion -ne 1 -or $null -eq $state.launcher) { return $null }
    return $state
  } catch {
    return $null
  }
}

function Test-WebuiLaunchStateActive {
  param([Parameter(Mandatory = $true)][string]$Path)

  $state = Read-WebuiLaunchState $Path
  return $null -ne $state -and (Test-WebuiProcessRecordActive $state.launcher)
}

function Stop-WebuiProcessRecord {
  param([Parameter(Mandatory = $true)]$Record)

  if (-not (Test-WebuiProcessRecordActive $Record)) { return $false }
  & taskkill.exe /PID ([int]$Record.pid) /T /F *> $null
  return $true
}

function Stop-WebuiLaunchState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Force
  )

  $state = Read-WebuiLaunchState $Path
  if ($null -eq $state) { return 0 }

  $launcherActive = Test-WebuiProcessRecordActive $state.launcher
  if ($launcherActive -and -not $Force) { return 0 }

  $stopped = 0
  if ($launcherActive) {
    if (Stop-WebuiProcessRecord $state.launcher) { $stopped++ }
  } else {
    foreach ($child in @($state.children)) {
      if (Stop-WebuiProcessRecord $child) { $stopped++ }
    }
  }

  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return $stopped
}

function Remove-WebuiLaunchState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$LauncherProcess
  )

  $state = Read-WebuiLaunchState $Path
  if ($null -eq $state) { return }
  $launcher = New-WebuiProcessRecord $LauncherProcess
  if ($null -ne $launcher -and
      [int]$state.launcher.pid -eq [int]$launcher.pid -and
      [long]$state.launcher.startedAtUtcTicks -eq [long]$launcher.startedAtUtcTicks) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}

function Test-IsLegacyWebuiRpcProcess {
  param(
    [Parameter(Mandatory = $true)][string]$ProcessName,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$ParentCommandLine
  )

  $name = $ProcessName.ToLowerInvariant()
  if ($name -notin @('bun.exe', 'node.exe')) { return $false }

  $command = $CommandLine.Replace('/', '\').ToLowerInvariant()
  $parentCommand = $ParentCommandLine.Replace('/', '\').ToLowerInvariant()
  return $command.Contains('run packages\server\src\index.ts') -and
    $parentCommand.Contains('run server:dev:raw')
}

function Test-IsLegacyWebuiViteProcess {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$ProcessName,
    [Parameter(Mandatory = $true)][string]$CommandLine
  )

  $name = $ProcessName.ToLowerInvariant()
  if ($name -notin @('vite.exe', 'node.exe')) { return $false }

  $repoPrefix = (Normalize-WebuiPath $RepoRoot) + '\node_modules\'
  $command = $CommandLine.Replace('/', '\').ToLowerInvariant()
  return $command.Contains($repoPrefix) -and
    $command.Contains('apps\webui\vite.config.ts')
}

function Stop-LegacyWebuiViteProcess {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][int]$WebuiPort
  )

  $listener = Get-NetTCPConnection -State Listen -LocalPort $WebuiPort -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') } |
    Select-Object -First 1
  if ($null -eq $listener) { return $false }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($null -eq $process -or -not (Test-IsLegacyWebuiViteProcess `
      -RepoRoot $RepoRoot `
      -ProcessName ([string]$process.Name) `
      -CommandLine ([string]$process.CommandLine))) {
    return $false
  }

  $rootPid = [int]$process.ProcessId
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)" -ErrorAction SilentlyContinue
  if ($null -ne $parent -and (Test-IsLegacyWebuiViteProcess `
      -RepoRoot $RepoRoot `
      -ProcessName ([string]$parent.Name) `
      -CommandLine ([string]$parent.CommandLine))) {
    $rootPid = [int]$parent.ProcessId
  }

  & taskkill.exe /PID $rootPid /T /F *> $null
  $deadline = (Get-Date).AddSeconds(5)
  while ((Test-WebuiTcpPort $WebuiPort -TimeoutMilliseconds 100) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  return -not (Test-WebuiTcpPort $WebuiPort -TimeoutMilliseconds 100)
}

function Stop-LegacyWebuiRpcProcess {
  param(
    [Parameter(Mandatory = $true)][int]$WebuiPort,
    [Parameter(Mandatory = $true)][int]$RpcPort
  )

  if (Test-WebuiTcpPort $WebuiPort) { return $false }
  $listener = Get-NetTCPConnection -State Listen -LocalPort $RpcPort -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') } |
    Select-Object -First 1
  if ($null -eq $listener) { return $false }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)" -ErrorAction SilentlyContinue
  if ($null -eq $parent) { return $false }
  if (-not (Test-IsLegacyWebuiRpcProcess `
      -ProcessName ([string]$process.Name) `
      -CommandLine ([string]$process.CommandLine) `
      -ParentCommandLine ([string]$parent.CommandLine))) {
    return $false
  }

  & taskkill.exe /PID ([int]$parent.ProcessId) /T /F *> $null
  $deadline = (Get-Date).AddSeconds(5)
  while ((Test-WebuiTcpPort $RpcPort -TimeoutMilliseconds 100) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  return -not (Test-WebuiTcpPort $RpcPort -TimeoutMilliseconds 100)
}
