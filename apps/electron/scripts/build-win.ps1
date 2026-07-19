# Build script for Windows NSIS installer
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1

$ErrorActionPreference = "Stop"
$env:MORTISE_UI_VALIDATION_BUILD = "0"
$env:MORTISE_DEV_HOST_BUILD = "0"

# 强制 TLS 1.2:GitHub 要求 TLS 1.2+,旧版 Windows/PowerShell 默认 TLS 1.0/1.1 会导致下载失败
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 全局 try/catch:捕获所有未处理异常,防止窗口闪退导致看不到错误
try {

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

# Configuration
$BunVersion = "bun-v1.3.14"  # Pinned version for reproducible builds

Write-Host "=== Building Mortise Windows Installer using electron-builder ===" -ForegroundColor Cyan

# 预检:构建步骤依赖系统 PATH 上的 bun/npx/node(vendor/bun/bun.exe 只用于打包进应用,不参与构建)
foreach ($tool in @('bun', 'npx', 'node')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool not found on PATH. Install bun (https://bun.sh) and Node.js, then re-run this script."
    }
}
Write-Host "Pre-flight check: bun/npx/node all available" -ForegroundColor Green

# Debug: System information
Write-Host ""
Write-Host "=== Debug: System Information ===" -ForegroundColor Magenta
Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "Hostname: $env:COMPUTERNAME"
Write-Host "User: $env:USERNAME"
Write-Host "Temp: $env:TEMP"
Write-Host "Working Dir: $(Get-Location)"

# Debug: Check Windows Defender status
Write-Host ""
Write-Host "=== Debug: Windows Defender Status ===" -ForegroundColor Magenta
try {
    $defenderStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($defenderStatus) {
        Write-Host "Real-time Protection: $($defenderStatus.RealTimeProtectionEnabled)"
        Write-Host "Antivirus Enabled: $($defenderStatus.AntivirusEnabled)"
        Write-Host "On Access Protection: $($defenderStatus.OnAccessProtectionEnabled)"
        Write-Host "IO AV Protection: $($defenderStatus.IoavProtectionEnabled)"
    } else {
        Write-Host "Could not get Defender status"
    }
} catch {
    Write-Host "Defender status check failed: $_"
}

# Debug: List exclusions
Write-Host ""
Write-Host "=== Debug: Defender Exclusions ===" -ForegroundColor Magenta
try {
    $prefs = Get-MpPreference -ErrorAction SilentlyContinue
    if ($prefs.ExclusionPath) {
        Write-Host "Path Exclusions: $($prefs.ExclusionPath -join ', ')"
    }
    if ($prefs.ExclusionProcess) {
        Write-Host "Process Exclusions: $($prefs.ExclusionProcess -join ', ')"
    }
} catch {
    Write-Host "Could not get exclusions: $_"
}
Write-Host ""

# 0. Kill any lingering Electron processes that might lock files
# 注意:只杀 electron/electron-builder,不杀 node/npm,避免影响 VS Code 等无关进程
Write-Host "Killing any lingering Electron processes..."
$processesToKill = @('electron', 'electron-builder')
foreach ($procName in $processesToKill) {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}
# Give processes time to fully terminate
Start-Sleep -Seconds 2

# 1. Clean previous build artifacts (with retry for locked files)
Write-Host "Cleaning previous builds..."
# 注意:vendor\bun\ 不在此清理列表中,以便复用已下载的 bun.exe,避免每次打包都重新下载。
$foldersToClean = @(
    "$ElectronDir\resources\session-mcp-server",
    "$ElectronDir\release"
)
foreach ($folder in $foldersToClean) {
    if (Test-Path $folder) {
        $retries = 3
        for ($i = 1; $i -le $retries; $i++) {
            try {
                Remove-Item -Recurse -Force $folder -ErrorAction Stop
                break
            } catch {
                if ($i -eq $retries) { throw }
                Write-Host "  Retrying cleanup of $folder (attempt $i)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        }
    }
}

# 2. Skip `bun install`
# mortise 的 package.json 用 `file:../pi/packages/...` 协议依赖本地 Pi 仓库,
# bun 1.3.13/1.3.14 在 Windows 上解析 `file:../` 路径时会剥掉 `../` 前缀(已知 bug),
# 导致 `bun install` 失败并破坏已有的 node_modules symlink。
# 开发环境已装好依赖(含指向 E:\_workSpace\_Agents\pi\packages\* 的 symlink),
# 构建只需复用现有 node_modules,因此跳过安装步骤。
Write-Host "Skipping 'bun install' (reusing dev node_modules with Pi symlinks)" -ForegroundColor Yellow

# Skipping install means stale workspace links from removed packages can linger in
# node_modules. electron-builder's npm collector follows those links and fails on
# missing targets, even when the package is no longer declared anywhere.
function Remove-StaleCraftWorkspaceLinks {
    param([string]$ScopeDir)

    if (-not (Test-Path -LiteralPath $ScopeDir)) {
        return
    }

    Write-Host "Checking @mortise workspace links..."
    foreach ($item in Get-ChildItem -LiteralPath $ScopeDir -Force) {
        $isReparsePoint = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq [System.IO.FileAttributes]::ReparsePoint)
        if (-not $isReparsePoint) {
            continue
        }

        $targets = @($item.Target) | Where-Object { $_ }
        if ($targets.Count -eq 0) {
            continue
        }

        $missingTargets = @($targets | Where-Object { -not (Test-Path -LiteralPath $_) })
        if ($missingTargets.Count -eq 0) {
            continue
        }

        Write-Host "  Removing stale link $($item.FullName) -> $($targets -join ', ')" -ForegroundColor Yellow
        Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
    }
}

Remove-StaleCraftWorkspaceLinks -ScopeDir "$RootDir\node_modules\@mortise"

# 3. Download Bun binary for Windows (cached by version marker file)
# Use baseline build - works on all x64 CPUs (no AVX2 requirement)
# 复用策略:在 vendor\bun\.version 中记录已下载的版本,匹配则跳过下载,避免重复下载约 50MB。
$BunExePath = "$ElectronDir\vendor\bun\bun.exe"
$BunVersionMarker = "$ElectronDir\vendor\bun\.version"

$BunCached = $false
# 注意:每个 Test-Path 必须用括号包裹,否则 PowerShell 会把 -and 当成 Test-Path 的参数
if ((Test-Path $BunExePath) -and (Test-Path $BunVersionMarker)) {
    $CachedVersion = (Get-Content $BunVersionMarker -ErrorAction SilentlyContinue).Trim()
    # 同时校验文件大小 > 1MB,防止 .version 正确但 bun.exe 损坏/截断的情况
    $BunSize = (Get-Item $BunExePath -ErrorAction SilentlyContinue).Length
    if ($CachedVersion -eq $BunVersion -and $BunSize -gt 1MB) {
        Write-Host "Bun $BunVersion already cached at $BunExePath ($([math]::Round($BunSize / 1MB, 1)) MB), skipping download" -ForegroundColor Green
        $BunCached = $true
    } else {
        Write-Host "Cached Bun invalid (version=$CachedVersion, size=$BunSize bytes), re-downloading..." -ForegroundColor Yellow
    }
}

if (-not $BunCached) {
    Write-Host "Downloading Bun $BunVersion for Windows x64 (baseline)..."
    New-Item -ItemType Directory -Force -Path "$ElectronDir\vendor\bun" | Out-Null

    $BunDownload = "bun-windows-x64-baseline"
    $TempDir = Join-Path $env:TEMP "bun-download-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

    try {
        # Download binary and checksums
        $ZipUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip"
        $ChecksumUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt"

        Write-Host "Downloading from $ZipUrl..."
        Invoke-WebRequest -Uri $ZipUrl -OutFile "$TempDir\$BunDownload.zip"
        Invoke-WebRequest -Uri $ChecksumUrl -OutFile "$TempDir\SHASUMS256.txt"

        # Verify checksum (取第一行匹配,避免多匹配导致 .ToString() 返回数组类型名)
        Write-Host "Verifying checksum..."
        $hashLine = (Get-Content "$TempDir\SHASUMS256.txt" | Select-String -Pattern "^\s*[0-9a-f]{64}\s+$BunDownload\.zip$" | Select-Object -First 1).Line
        if (-not $hashLine) {
            throw "Could not find $BunDownload.zip in SHASUMS256.txt"
        }
        $ExpectedHash = $hashLine.Trim().Split("`t ")[0].ToLower()
        $ActualHash = (Get-FileHash "$TempDir\$BunDownload.zip" -Algorithm SHA256).Hash.ToLower()

        if ($ActualHash -ne $ExpectedHash) {
            throw "Checksum verification failed! Expected: $ExpectedHash, Got: $ActualHash"
        }
        Write-Host "Checksum verified successfully" -ForegroundColor Green

        # Extract and install using robocopy for better file handle management
        Write-Host "Extracting Bun..."
        Expand-Archive -Path "$TempDir\$BunDownload.zip" -DestinationPath $TempDir -Force

        # Unblock in temp first (before copy)
        Unblock-File -Path "$TempDir\$BunDownload\bun.exe" -ErrorAction SilentlyContinue

        # Use robocopy with retries - handles transient file locks better than Copy-Item
        # /R:5 = 5 retries, /W:3 = 3 second wait between retries, /NP = no progress, /NFL /NDL = quiet
        Write-Host "Copying bun.exe with robocopy..."
        $robocopyResult = robocopy "$TempDir\$BunDownload" "$ElectronDir\vendor\bun" "bun.exe" /R:5 /W:3 /NP /NFL /NDL
        # Robocopy exit codes: 0-7 are success, 8+ are errors
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed with exit code $LASTEXITCODE"
        }

        # Write version marker for future cache hits
        Set-Content -Path $BunVersionMarker -Value $BunVersion -NoNewline
        Write-Host "Bun extracted to: $BunExePath" -ForegroundColor Green

        # Give Windows time to release any file handles from the copy
        Write-Host "Waiting for file handles to release..."
        Start-Sleep -Seconds 3
    } finally {
        Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
    }
}

# 4. Copy ripgrep.
$RgSource = "$RootDir\node_modules\@vscode\ripgrep"
if (-not (Test-Path $RgSource) -or -not (Test-Path "$RgSource\bin\rg.exe")) {
    Write-Host "ERROR: @vscode/ripgrep not installed or postinstall did not run" -ForegroundColor Red
    Write-Host "Run 'bun install' and 'bun pm trust @vscode/ripgrep'."
    throw "@vscode/ripgrep not installed"
}
Write-Host "Copying @vscode/ripgrep..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\node_modules\@vscode" | Out-Null
Remove-Item -Recurse -Force "$ElectronDir\node_modules\@vscode\ripgrep" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $RgSource "$ElectronDir\node_modules\@vscode\"

# 6. Build Electron app
Write-Host "Building Electron app..."

# Build main process + all subprocesses (session-mcp-server, interceptor,
# WhatsApp worker) via the canonical build script.
# This ensures --alias flags (node-fetch, abort-controller) and build defines
# (OAuth, Sentry) are applied consistently with `bun run electron:build`.
Write-Host "  Building main process + subprocesses..."
Push-Location $RootDir
try {
    bun run electron:build:main
    if ($LASTEXITCODE -ne 0) { throw "Main process build failed" }
} finally {
    Pop-Location
}

# Build preload
Write-Host "  Building preload..."
Push-Location $RootDir
try {
    bun run electron:build:preload
    if ($LASTEXITCODE -ne 0) { throw "Preload build failed" }
} finally {
    Pop-Location
}

# Build renderer (frontend)
Write-Host "  Building renderer (frontend)..."
Push-Location $RootDir
try {
    # Clean previous renderer build
    $RendererDir = "$ElectronDir\dist\renderer"
    if (Test-Path $RendererDir) { Remove-Item -Recurse -Force $RendererDir }

    # Run vite build
    npx vite build --config apps/electron/vite.config.ts
    if ($LASTEXITCODE -ne 0) { throw "Renderer build failed" }

    # Verify renderer was built
    if (-not (Test-Path "$RendererDir\index.html")) {
        throw "Renderer build verification failed: index.html not found"
    }
    Write-Host "  Renderer build verified: $RendererDir" -ForegroundColor Green
} finally {
    Pop-Location
}

# Copy all resources and bundled assets using the shared script.
# Single source of truth — matches Mac/Linux build (bun run build:copy).
# Copies: resources (icons, DMG bg), docs, tool-icons, themes, permissions, config-defaults.
Write-Host "  Copying resources and bundled assets..."
Push-Location $ElectronDir
try {
    bun scripts/copy-assets.ts
    if ($LASTEXITCODE -ne 0) { throw "Asset copy failed" }
    bun scripts/validate-assets.ts
    if ($LASTEXITCODE -ne 0) { throw "Asset validation failed" }
    Write-Host "  Assets copied" -ForegroundColor Green
} finally {
    Pop-Location
}

# 7. Package with electron-builder
Write-Host "Packaging app with electron-builder..."

# Debug: Show bun.exe file info
Write-Host ""
Write-Host "=== Debug: bun.exe File Info ===" -ForegroundColor Magenta
$BunExe = "$ElectronDir\vendor\bun\bun.exe"
if (Test-Path $BunExe) {
    $fileInfo = Get-Item $BunExe
    Write-Host "Path: $($fileInfo.FullName)"
    Write-Host "Size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
    Write-Host "Created: $($fileInfo.CreationTime)"
    Write-Host "Modified: $($fileInfo.LastWriteTime)"
    Write-Host "Attributes: $($fileInfo.Attributes)"

    # Check Zone.Identifier (Mark of the Web)
    $zoneFile = "$BunExe`:Zone.Identifier"
    if (Test-Path $zoneFile -ErrorAction SilentlyContinue) {
        Write-Host "Zone.Identifier: EXISTS (file may be blocked)" -ForegroundColor Yellow
    } else {
        Write-Host "Zone.Identifier: None (file is unblocked)"
    }

    # Check file hash
    $hash = (Get-FileHash $BunExe -Algorithm SHA256).Hash
    Write-Host "SHA256: $hash"
} else {
    Write-Host "ERROR: bun.exe not found at $BunExe" -ForegroundColor Red
}

# Debug: List vendor directory contents
Write-Host ""
Write-Host "=== Debug: vendor/bun Directory ===" -ForegroundColor Magenta
Get-ChildItem "$ElectronDir\vendor\bun" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name) - $($_.Length) bytes"
}

# Debug: Check for processes that might have files open
Write-Host ""
Write-Host "=== Debug: Potentially Relevant Processes ===" -ForegroundColor Magenta
$relevantProcesses = Get-Process | Where-Object {
    $_.ProcessName -match 'node|npm|bun|electron|defender|antimalware|mpcmdrun'
} | Select-Object ProcessName, Id, CPU, WorkingSet64
if ($relevantProcesses) {
    $relevantProcesses | ForEach-Object {
        Write-Host "  $($_.ProcessName) (PID: $($_.Id)) - Memory: $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
    }
} else {
    Write-Host "  No relevant processes found"
}
Write-Host ""

# NOTE: bun.exe is now copied via extraResources in electron-builder.yml
# This avoids EBUSY errors from the npm node module collector.
# See electron-builder.yml for details.

# Verify bun.exe is accessible (not locked by another process)
Write-Host "  Verifying $BunExe is accessible..."
$retryCount = 0
$maxRetries = 6
while ($retryCount -lt $maxRetries) {
    try {
        # Try to open the file exclusively to verify no other process has it locked
        $stream = [System.IO.File]::Open($BunExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Close()
        $stream.Dispose()
        Write-Host "  File is accessible" -ForegroundColor Green
        break
    } catch {
        $retryCount++
        if ($retryCount -ge $maxRetries) {
            Write-Host "  WARNING: File may be locked after $maxRetries attempts, proceeding anyway..." -ForegroundColor Yellow
        } else {
            Write-Host "  File locked, waiting 5 seconds (attempt $retryCount/$maxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
}

# Force garbage collection to release any managed file handles
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

# Run electron-builder with retry logic for EBUSY errors
Push-Location $ElectronDir
$maxBuilderRetries = 3
$builderRetry = 0
$builderSuccess = $false

while (-not $builderSuccess -and $builderRetry -lt $maxBuilderRetries) {
    $builderRetry++
    Write-Host "  electron-builder attempt $builderRetry of $maxBuilderRetries..." -ForegroundColor Cyan

    # Clean release directory before each attempt to avoid stale files
    if (Test-Path "$ElectronDir\release") {
        Write-Host "  Cleaning release directory before attempt..."
        Remove-Item -Recurse -Force "$ElectronDir\release" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    # 注意:不能用 2>&1,因为 $ErrorActionPreference="Stop" 会把 native command 的
    # stderr 输出当作 terminating error,导致 electron-builder 输出任何警告时脚本闪退。
    # stderr 直接输出到控制台即可,不需要通过管道捕获。
    npx electron-builder --win --x64

    if ($LASTEXITCODE -eq 0) {
        $builderSuccess = $true
        Write-Host "  electron-builder succeeded on attempt $builderRetry" -ForegroundColor Green
    } else {
        Write-Host "  electron-builder failed with exit code $LASTEXITCODE" -ForegroundColor Yellow

        if ($builderRetry -lt $maxBuilderRetries) {
            Write-Host "  Waiting 10 seconds before retry..." -ForegroundColor Yellow

            # Kill electron processes that might be holding file locks (不杀 node/npm 以免影响 VS Code 等)
            Get-Process -Name 'electron', 'electron-builder' -ErrorAction SilentlyContinue | ForEach-Object {
                Write-Host "    Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }

            Start-Sleep -Seconds 10
        }
    }
}

Pop-Location

if (-not $builderSuccess) {
    throw "electron-builder failed after $maxBuilderRetries attempts"
}

# 8. Verify the installer was built
# electron-builder.yml 配置 win.artifactName = "Mortise-${arch}.${ext}",
# 所以 NSIS 输出为 Mortise-x64.exe。优先按名称查找,回退到第一个 .exe
$InstallerPath = Get-ChildItem -Path "$ElectronDir\release" -Filter "Mortise-x64.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $InstallerPath) {
    # 回退:取 release 目录下最大的 .exe(NSIS installer 通常远大于 blockmap)
    $InstallerPath = Get-ChildItem -Path "$ElectronDir\release" -Filter "*.exe" -ErrorAction SilentlyContinue |
        Sort-Object Length -Descending | Select-Object -First 1
}

if (-not $InstallerPath) {
    Write-Host "ERROR: Installer not found in $ElectronDir\release" -ForegroundColor Red
    Write-Host "Contents of release directory:"
    Get-ChildItem "$ElectronDir\release"
    throw "Installer not found in $ElectronDir\release"
}

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $($InstallerPath.FullName)"
Write-Host "Size: $([math]::Round($InstallerPath.Length / 1MB, 2)) MB"

} catch {
    Write-Host ""
    Write-Host "=== BUILD FAILED ===" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    # 显示完整错误堆栈,便于定位问题
    if ($_.ScriptStackTrace) {
        Write-Host "Stack Trace:" -ForegroundColor Yellow
        Write-Host $_.ScriptStackTrace
    }
    Write-Host ""
    Write-Host "按 Enter 键退出..." -ForegroundColor Yellow
    Read-Host
    exit 1
}

# 构建成功时也暂停,防止双击运行时窗口直接关闭
Write-Host ""
Write-Host "按 Enter 键退出..." -ForegroundColor Yellow
Read-Host
