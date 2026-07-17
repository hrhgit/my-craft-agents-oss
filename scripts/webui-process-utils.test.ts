import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const utilsPath = fileURLToPath(new URL("./webui-process-utils.ps1", import.meta.url));
const launcherPath = fileURLToPath(new URL("./start-webui.ps1", import.meta.url));
const instanceLauncherPath = fileURLToPath(new URL("./start-webui-instance.ps1", import.meta.url));
const clientLauncherPath = fileURLToPath(new URL("./start-webui-client.ps1", import.meta.url));
const cmdLauncherPath = fileURLToPath(new URL("../start-webui.cmd", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const webuiViteConfigPath = fileURLToPath(new URL("../apps/webui/vite.config.ts", import.meta.url));
const windowsTest = process.platform === "win32" ? test : test.skip;

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShellJson(command: string): unknown {
  const source = `$ProgressPreference = 'SilentlyContinue'; . ${quotePowerShell(utilsPath)}; ${command}`;
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const output = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { cwd: scriptsDir, encoding: "utf8" },
  );
  return JSON.parse(output.trim());
}

describe("WebUI process lifecycle utilities", () => {
  windowsTest("validates PID identity with the process creation time", () => {
    const result = runPowerShellJson(`
      $record = New-WebuiProcessRecord (Get-Process -Id $PID)
      [pscustomobject]@{
        active = Test-WebuiProcessRecordActive $record
        reusedPidRejected = -not (Test-WebuiProcessRecordActive ([pscustomobject]@{
          pid = $record.pid
          startedAtUtcTicks = [long]$record.startedAtUtcTicks + 1
        }))
      } | ConvertTo-Json -Compress
    `) as { active: boolean; reusedPidRejected: boolean };

    expect(result).toEqual({ active: true, reusedPidRejected: true });
  });

  windowsTest("only recognizes the legacy Craft RPC process chain", () => {
    const result = runPowerShellJson(`
      [pscustomobject]@{
        craftRpc = Test-IsLegacyWebuiRpcProcess ` +
          `-ProcessName 'bun.exe' ` +
          `-CommandLine 'bun.exe run packages/server/src/index.ts' ` +
          `-ParentCommandLine 'bun.exe run server:dev:raw'
        unrelatedCommand = Test-IsLegacyWebuiRpcProcess ` +
          `-ProcessName 'bun.exe' ` +
          `-CommandLine 'bun.exe run other/server.ts' ` +
          `-ParentCommandLine 'bun.exe run server:dev:raw'
        unrelatedRuntime = Test-IsLegacyWebuiRpcProcess ` +
          `-ProcessName 'python.exe' ` +
          `-CommandLine 'python packages/server/src/index.ts' ` +
          `-ParentCommandLine 'bun.exe run server:dev:raw'
      } | ConvertTo-Json -Compress
    `) as { craftRpc: boolean; unrelatedCommand: boolean; unrelatedRuntime: boolean };

    expect(result).toEqual({
      craftRpc: true,
      unrelatedCommand: false,
      unrelatedRuntime: false,
    });
  });

  windowsTest("only recognizes Vite processes rooted in this repository", () => {
    const result = runPowerShellJson(`
      [pscustomobject]@{
        craftVite = Test-IsLegacyWebuiViteProcess ` +
          `-RepoRoot 'E:\\craft-agent' ` +
          `-ProcessName 'node.exe' ` +
          `-CommandLine 'node E:\\craft-agent\\node_modules\\vite\\bin\\vite.js dev --config apps/webui/vite.config.ts'
        otherRepo = Test-IsLegacyWebuiViteProcess ` +
          `-RepoRoot 'E:\\craft-agent' ` +
          `-ProcessName 'node.exe' ` +
          `-CommandLine 'node E:\\other\\node_modules\\vite\\bin\\vite.js dev --config apps/webui/vite.config.ts'
        otherConfig = Test-IsLegacyWebuiViteProcess ` +
          `-RepoRoot 'E:\\craft-agent' ` +
          `-ProcessName 'node.exe' ` +
          `-CommandLine 'node E:\\craft-agent\\node_modules\\vite\\bin\\vite.js dev --config apps/marketing/vite.config.ts'
      } | ConvertTo-Json -Compress
    `) as { craftVite: boolean; otherRepo: boolean; otherConfig: boolean };

    expect(result).toEqual({ craftVite: true, otherRepo: false, otherConfig: false });
  });

  windowsTest("keeps a live launch state until its matching launcher removes it", () => {
    const result = runPowerShellJson(`
      $path = Join-Path $env:TEMP ('craft-webui-state-test-' + [guid]::NewGuid() + '.json')
      $self = Get-Process -Id $PID
      $children = [System.Collections.ArrayList]::new()
      try {
        Write-WebuiLaunchState -Path $path -LauncherProcess $self -ChildProcesses $children ` +
          `-RepoRoot 'E:\\repo' -WebuiPort 12000 -RpcPort 12001
        $state = Read-WebuiLaunchState $path
        $activeState = Test-WebuiLaunchStateActive $path
        $stopped = Stop-WebuiLaunchState -Path $path
        $keptWhileLive = Test-Path -LiteralPath $path
        Remove-WebuiLaunchState -Path $path -LauncherProcess $self
        [pscustomobject]@{
          schemaVersion = $state.schemaVersion
          activeState = $activeState
          stopped = $stopped
          keptWhileLive = $keptWhileLive
          removedByOwner = -not (Test-Path -LiteralPath $path)
        } | ConvertTo-Json -Compress
      } finally {
        if (Test-Path -LiteralPath $path) {
          Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
      }
    `) as {
      schemaVersion: number;
      activeState: boolean;
      stopped: number;
      keptWhileLive: boolean;
      removedByOwner: boolean;
    };

    expect(result).toEqual({
      schemaVersion: 1,
      activeState: true,
      stopped: 0,
      keptWhileLive: true,
      removedByOwner: true,
    });
  });

  windowsTest("accepts a live endpoint owned by the current process", () => {
    const result = runPowerShellJson(`
      $directory = Join-Path $env:TEMP ('craft-endpoint-test-' + [guid]::NewGuid())
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
      try {
        New-Item -ItemType Directory -Force $directory | Out-Null
        $tokenFile = Join-Path $directory '.server-token'
        Set-Content -LiteralPath $tokenFile -Value 'test-token'
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        [ordered]@{
          schemaVersion = 1
          pid = $PID
          startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          url = "ws://127.0.0.1:$port"
          tokenFile = $tokenFile
          webui = [ordered]@{ enabled = $true; autoLogin = $true }
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $directory '.server-endpoint.json')
        $endpoint = Get-CraftServerEndpoint -ConfigDir $directory -RequireWebuiAutoLogin
        [pscustomobject]@{
          found = $null -ne $endpoint
          pid = $endpoint.pid
          port = ([Uri]$endpoint.url).Port
        } | ConvertTo-Json -Compress
      } finally {
        $listener.Stop()
        Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
      }
    `) as { found: boolean; pid: number; port: number };

    expect(result.found).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.port).toBeGreaterThan(0);
  });

  test("starts Vite with non-interactive standard input and persists child state", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    expect(launcher).toContain("-RedirectStandardInput $viteStandardInput");
    expect(launcher).toContain("Save-LaunchState");
    expect(launcher).toContain("Stop-LegacyWebuiRpcProcess");
  });

  test("starts WebUI development without a production frontend build", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const scripts = packageJson.scripts as Record<string, string>;

    expect(launcher).toContain('"apps\\webui\\src"');
    expect(launcher).toContain('{ "server:dev:runtime" } else { "server:dev:webui" }');
    expect(scripts["server:dev:webui"]).toContain("CRAFT_WEBUI_DIR=apps/webui/src");
    expect(scripts["server:dev:webui"]).toContain("server:dev:raw");
    expect(scripts["server:dev:webui"]).not.toContain("webui:build");
    expect(scripts["server:dev:raw"]).toContain("server:build:subprocess");
    expect(scripts["server:dev:raw"]).toContain("server:dev:runtime");
    expect(scripts["server:dev:runtime"]).not.toContain("server:build:subprocess");
  });

  test("production WebUI builds clear stale hashed assets", () => {
    const viteConfig = readFileSync(webuiViteConfigPath, "utf8");
    expect(viteConfig).toContain("emptyOutDir: true");
    expect(viteConfig).not.toContain("emptyDirBeforeWrite");
  });

  test("cleans stale processes before portmux chooses a replacement port", () => {
    const launcher = readFileSync(instanceLauncherPath, "utf8");
    const cleanupIndex = launcher.indexOf("Clear-StaleWebuiLaunch\n  Write-Host");
    const portmuxIndex = launcher.indexOf("& portmux start --project $repoRoot");
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(portmuxIndex).toBeGreaterThan(cleanupIndex);
  });

  test("repeated zero-argument launches create frontend-only clients", () => {
    const cmd = readFileSync(cmdLauncherPath, "utf8");
    const instanceLauncher = readFileSync(instanceLauncherPath, "utf8");
    const clientLauncher = readFileSync(clientLauncherPath, "utf8");

    expect(cmd).not.toContain("%~1");
    expect(instanceLauncher).toContain("Get-CraftServerEndpoint -RequireWebuiAutoLogin");
    expect(instanceLauncher).toContain("Start-SharedClientInstance");
    expect(clientLauncher).toContain("apps/webui/vite.config.ts");
    expect(clientLauncher).not.toContain("Start-HeadlessServer");
    expect(clientLauncher).not.toContain("server:dev:webui");
    expect(clientLauncher).not.toContain("Stop-LegacyWebuiRpcProcess");
  });
});
