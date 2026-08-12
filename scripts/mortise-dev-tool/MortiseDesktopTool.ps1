param(
  [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('MortiseDevTool.MainForm' -as [type])) {
  $winFormsReferences = @(
    Get-ChildItem (Join-Path $PSHOME 'ref') -Filter '*.dll' | ForEach-Object FullName
    [System.Windows.Forms.Form].Assembly.Location
    [System.Windows.Forms.Control].Assembly.Location
    [System.Windows.Forms.Padding].Assembly.Location
    [System.Drawing.Bitmap].Assembly.Location
    [System.Drawing.Color].Assembly.Location
  ) | Select-Object -Unique
  Add-Type -Language CSharp -ReferencedAssemblies $winFormsReferences -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace MortiseDevTool
{
    internal sealed class ProcessMessage
    {
        public string Source { get; set; } = "tool";
        public string Text { get; set; } = "";
        public bool IsExit { get; set; }
        public int ExitCode { get; set; }
    }

    internal sealed class ProcessRunner : IDisposable
    {
        private Process process;
        public readonly ConcurrentQueue<ProcessMessage> Messages = new ConcurrentQueue<ProcessMessage>();

        public bool IsRunning
        {
            get
            {
                try { return process != null && !process.HasExited; }
                catch { return false; }
            }
        }

        public int Start(string executable, string[] arguments, string workingDirectory, string source)
        {
            if (IsRunning) throw new InvalidOperationException("Process is already running.");
            var startInfo = new ProcessStartInfo
            {
                FileName = executable,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

            process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, eventArgs) => EnqueueLine(source, eventArgs.Data);
            process.ErrorDataReceived += (_, eventArgs) => EnqueueLine(source, eventArgs.Data);
            process.Exited += (_, __) =>
            {
                try { process.WaitForExit(); } catch { }
                Messages.Enqueue(new ProcessMessage
                {
                    Source = source,
                    IsExit = true,
                    ExitCode = SafeExitCode(process),
                });
            };
            if (!process.Start()) throw new InvalidOperationException("Unable to start " + executable + ".");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return process.Id;
        }

        public void Dispose()
        {
            if (process == null) return;
            try { process.Dispose(); } catch { }
            process = null;
        }

        public void TerminateTree()
        {
            if (!IsRunning) return;
            try
            {
                process.Kill(true);
                process.WaitForExit(5000);
            }
            catch { }
        }

        public bool WaitForExit(int milliseconds)
        {
            if (!IsRunning) return true;
            try { return process.WaitForExit(milliseconds); }
            catch { return !IsRunning; }
        }

        private void EnqueueLine(string source, string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            Messages.Enqueue(new ProcessMessage { Source = source, Text = line });
        }

        private static int SafeExitCode(Process value)
        {
            try { return value.ExitCode; }
            catch { return -1; }
        }
    }

    public sealed class MainForm : Form
    {
        private const int MaxMessagesPerDrain = 100;
        private readonly string repoRoot;
        private readonly string electronProject;
        private readonly bool stopDesktopOnClose;
        private readonly Label statusDot;
        private readonly Label statusText;
        private readonly Button startButton;
        private readonly Button restartButton;
        private readonly Button packageButton;
        private readonly Button webuiButton;
        private readonly Button stopWebuiButton;
        private readonly Button developerKitButton;
        private readonly RichTextBox logBox;
        private readonly Timer timer;

        private ProcessRunner desktopRunner;
        private ProcessRunner stopRunner;
        private ProcessRunner packageRunner;
        private ProcessRunner webuiRunner;
        private ProcessRunner stopWebuiRunner;
        private ProcessRunner developerKitRunner;
        private bool restarting;
        private bool closing;
        private bool suppressNextWebuiExitError;
        private string pendingDesktopControl;
        private string desktopState = "idle";
        private DateTime nextDesktopProbe = DateTime.MinValue;

        public MainForm(string repositoryRoot, bool stopDesktopWhenClosing)
        {
            repoRoot = repositoryRoot;
            electronProject = Path.Combine(repoRoot, "apps", "electron");
            stopDesktopOnClose = stopDesktopWhenClosing;

            Text = "Mortise 源码工具";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(820, 620);
            MinimumSize = new Size(640, 500);
            BackColor = Color.FromArgb(244, 243, 239);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;

            var header = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                Height = 78,
                Padding = new Padding(24, 12, 24, 8),
                ColumnCount = 2,
                RowCount = 1,
            };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70f));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30f));
            var title = new Label
            {
                Text = "Mortise 源码工具",
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Segoe UI Semibold", 16f, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(23, 24, 21),
            };
            var statusHost = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false,
                Padding = new Padding(0, 15, 0, 0),
            };
            statusDot = new Label
            {
                Text = "●",
                AutoSize = true,
                Margin = new Padding(6, 2, 0, 0),
                ForeColor = Color.FromArgb(140, 142, 134),
            };
            statusText = new Label
            {
                Text = "未启动",
                AutoSize = true,
                Margin = new Padding(0, 2, 0, 0),
                ForeColor = Color.FromArgb(93, 95, 88),
            };
            statusHost.Controls.Add(statusText);
            statusHost.Controls.Add(statusDot);
            header.Controls.Add(title, 0, 0);
            header.Controls.Add(statusHost, 1, 0);

            var actions = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                Height = 132,
                Padding = new Padding(24, 13, 24, 13),
                ColumnCount = 6,
                RowCount = 2,
            };
            for (var index = 0; index < 6; index++)
                actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 16.667f));
            actions.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            actions.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));

            startButton = CreateButton("启动", true, false);
            restartButton = CreateButton("重启", false, false);
            packageButton = CreateButton("打包", false, true);
            webuiButton = CreateButton("启动网页端", false, false);
            stopWebuiButton = CreateButton("停止网页端", false, false);
            developerKitButton = CreateButton("构建开发者套件", false, true);
            startButton.Click += (_, __) => StartDesktop();
            restartButton.Click += (_, __) => RestartDesktop();
            packageButton.Click += (_, __) => PackageDesktop();
            webuiButton.Click += (_, __) => StartWebui();
            stopWebuiButton.Click += (_, __) => StopWebui();
            developerKitButton.Click += (_, __) => BuildDeveloperKit();
            actions.Controls.Add(startButton, 0, 0);
            actions.SetColumnSpan(startButton, 2);
            actions.Controls.Add(restartButton, 2, 0);
            actions.SetColumnSpan(restartButton, 2);
            actions.Controls.Add(packageButton, 4, 0);
            actions.SetColumnSpan(packageButton, 2);
            actions.Controls.Add(webuiButton, 0, 1);
            actions.SetColumnSpan(webuiButton, 2);
            actions.Controls.Add(stopWebuiButton, 2, 1);
            actions.SetColumnSpan(stopWebuiButton, 2);
            actions.Controls.Add(developerKitButton, 4, 1);
            actions.SetColumnSpan(developerKitButton, 2);

            var logHeader = new Panel { Dock = DockStyle.Top, Height = 42, Padding = new Padding(24, 13, 24, 4) };
            var logTitle = new Label
            {
                Text = "运行日志",
                AutoSize = true,
                Location = new Point(24, 15),
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(23, 24, 21),
            };
            logHeader.Controls.Add(logTitle);

            var logHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 22) };
            logBox = new RichTextBox
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(21, 22, 19),
                ForeColor = Color.FromArgb(223, 225, 216),
                Font = new Font("Cascadia Mono", 9f, FontStyle.Regular, GraphicsUnit.Point),
                WordWrap = false,
                DetectUrls = false,
                Text = "等待操作\n",
            };
            logHost.Controls.Add(logBox);

            Controls.Add(logHost);
            Controls.Add(logHeader);
            Controls.Add(actions);
            Controls.Add(header);

            timer = new Timer { Interval = 150 };
            timer.Tick += (_, __) => DrainProcessMessages();
            timer.Start();

            Shown += (_, __) => DetectExistingDesktop();
            FormClosing += (_, __) =>
            {
                packageRunner?.TerminateTree();
                developerKitRunner?.TerminateTree();
                if (stopDesktopOnClose) StopDesktopOnToolClose();
            };
            FormClosed += (_, __) =>
            {
                timer.Stop();
                desktopRunner?.Dispose();
                stopRunner?.Dispose();
                packageRunner?.Dispose();
                developerKitRunner?.Dispose();
            };
        }

        private static Button CreateButton(string text, bool primary, bool package)
        {
            var button = new Button
            {
                Text = text,
                Dock = DockStyle.Fill,
                Margin = new Padding(6, 0, 6, 0),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
                Font = new Font("Segoe UI Semibold", 10f, FontStyle.Bold, GraphicsUnit.Point),
                BackColor = primary ? Color.FromArgb(23, 24, 21) : Color.White,
                ForeColor = primary ? Color.White : package ? Color.FromArgb(13, 98, 53) : Color.FromArgb(23, 24, 21),
            };
            button.FlatAppearance.BorderColor = package ? Color.FromArgb(20, 122, 67) : Color.FromArgb(29, 30, 27);
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(42, 43, 39) : Color.FromArgb(238, 238, 233);
            return button;
        }

        private void DetectExistingDesktop()
        {
            try
            {
                SetDesktopState(IsSourceDesktopRunning() ? "running" : "idle");
            }
            catch (Exception error)
            {
                AppendLog("tool", "状态检查失败：" + error.Message);
                SetDesktopState("error");
            }
        }

        private void StartDesktop()
        {
            if (desktopState == "starting" || desktopState == "running" || desktopState == "restarting" || desktopState == "stopping") return;
            RunDesktopControl("start", false);
        }

        private void LaunchDesktop(bool restartLaunch = false)
        {
            desktopRunner?.Dispose();
            desktopRunner = new ProcessRunner();
            SetDesktopState(restartLaunch ? "restarting" : "starting");
            AppendCommand("portmux", "start", "--project", electronProject);
            try
            {
                desktopRunner.Start("portmux", new[] { "start", "--project", electronProject }, repoRoot, "desktop");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                SetDesktopState("error");
            }
        }

        private void RestartDesktop()
        {
            if (restarting || (stopRunner != null && stopRunner.IsRunning)) return;
            RunDesktopControl("restart", true);
        }

        private void RunDesktopControl(string command, bool explicitRestart)
        {
            restarting = explicitRestart;
            pendingDesktopControl = command;
            SetDesktopState(explicitRestart ? "restarting" : "starting");
            stopRunner?.Dispose();
            stopRunner = new ProcessRunner();
            AppendCommand("bun", "run", "scripts/electron-dev-control.ts", command, "--repo-root", repoRoot);
            try
            {
                stopRunner.Start(
                    "bun",
                    new[] { "run", "scripts/electron-dev-control.ts", command, "--repo-root", repoRoot },
                    repoRoot,
                    "desktop-control");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                pendingDesktopControl = null;
                restarting = false;
                if (explicitRestart) StopDesktopBeforeLaunch(true);
                else LaunchDesktop();
            }
        }

        private void StopDesktopBeforeLaunch(bool explicitRestart)
        {
            restarting = true;
            pendingDesktopControl = explicitRestart ? "legacy-restart-stop" : "legacy-start-stop";
            SetDesktopState(explicitRestart ? "restarting" : "starting");
            stopRunner?.Dispose();
            stopRunner = new ProcessRunner();
            AppendCommand("portmux", "stop", "--project", electronProject);
            try
            {
                stopRunner.Start("portmux", new[] { "stop", "--project", electronProject }, repoRoot, "desktop");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                restarting = false;
                SetDesktopState("error");
            }
        }

        private void StopDesktopOnToolClose()
        {
            closing = true;
            restarting = false;
            SetDesktopState("stopping");
            stopRunner?.TerminateTree();
            try
            {
                using var stop = Process.Start(new ProcessStartInfo
                {
                    FileName = "portmux",
                    WorkingDirectory = repoRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    ArgumentList = { "stop", "--project", electronProject },
                });
                if (stop != null && !stop.WaitForExit(10000))
                {
                    stop.Kill(true);
                    stop.WaitForExit(5000);
                }
            }
            catch { }

            if (desktopRunner != null && !desktopRunner.WaitForExit(5000))
                desktopRunner.TerminateTree();

            TerminateRemainingSourceDesktopProcesses();
        }

        private void TerminateRemainingSourceDesktopProcesses()
        {
            var expectedExecutable = Path.GetFullPath(Path.Combine(repoRoot, "node_modules", "electron", "dist", "electron.exe"));
            var deadline = DateTime.UtcNow.AddSeconds(2);
            do
            {
                foreach (var process in Process.GetProcessesByName("electron"))
                {
                    try
                    {
                        var executable = process.MainModule?.FileName;
                        if (string.IsNullOrEmpty(executable)
                            || !string.Equals(Path.GetFullPath(executable), expectedExecutable, StringComparison.OrdinalIgnoreCase)) continue;
                        process.Kill(true);
                        process.WaitForExit(5000);
                    }
                    catch { }
                    finally { process.Dispose(); }
                }
                if (DateTime.UtcNow < deadline) System.Threading.Thread.Sleep(100);
            }
            while (DateTime.UtcNow < deadline);
        }

        private void PackageDesktop()
        {
            if (packageRunner != null && packageRunner.IsRunning) return;
            packageRunner?.Dispose();
            packageRunner = new ProcessRunner();
            packageButton.Enabled = false;
            packageButton.Text = "正在打包";
            AppendCommand("bun", "run", "scripts/build/package-electron.ts", "--target", "default");
            try
            {
                packageRunner.Start(
                    "bun",
                    new[] { "run", "scripts/build/package-electron.ts", "--target", "default" },
                    repoRoot,
                    "package");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                packageButton.Enabled = true;
                packageButton.Text = "打包";
            }
        }

        private void StartWebui()
        {
            if ((webuiRunner != null && webuiRunner.IsRunning)
                || (stopWebuiRunner != null && stopWebuiRunner.IsRunning)) return;
            webuiRunner?.Dispose();
            webuiRunner = new ProcessRunner();
            webuiButton.Enabled = false;
            webuiButton.Text = "正在启动网页端";
            var scriptPath = Path.Combine(repoRoot, "scripts", "start-webui-instance.ps1");
            AppendCommand("powershell", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath);
            try
            {
                webuiRunner.Start(
                    "powershell",
                    new[] { "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath },
                    repoRoot,
                    "webui");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                ResetWebuiStartButton();
            }
        }

        private void StopWebui()
        {
            if (stopWebuiRunner != null && stopWebuiRunner.IsRunning) return;
            suppressNextWebuiExitError = webuiRunner != null && webuiRunner.IsRunning;
            stopWebuiRunner?.Dispose();
            stopWebuiRunner = new ProcessRunner();
            webuiButton.Enabled = false;
            stopWebuiButton.Enabled = false;
            stopWebuiButton.Text = "正在停止网页端";
            var scriptPath = Path.Combine(repoRoot, "scripts", "stop-webui.ps1");
            AppendCommand("powershell", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath);
            try
            {
                stopWebuiRunner.Start(
                    "powershell",
                    new[] { "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath },
                    repoRoot,
                    "webui-stop");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                suppressNextWebuiExitError = false;
                ResetWebuiStartButton();
                ResetStopWebuiButton();
            }
        }

        private void BuildDeveloperKit()
        {
            if (developerKitRunner != null && developerKitRunner.IsRunning) return;
            developerKitRunner?.Dispose();
            developerKitRunner = new ProcessRunner();
            developerKitButton.Enabled = false;
            developerKitButton.Text = "正在构建开发者套件";
            AppendCommand("bun", "run", "scripts/build-developer-kit.ts", "--no-archive");
            try
            {
                developerKitRunner.Start(
                    "bun",
                    new[] { "run", "scripts/build-developer-kit.ts", "--no-archive" },
                    repoRoot,
                    "developer-kit");
            }
            catch (Exception error)
            {
                AppendLog("tool", error.Message);
                ResetDeveloperKitButton();
            }
        }

        private void DrainProcessMessages()
        {
            DrainDesktopMessages();
            DrainStopMessages();
            DrainPackageMessages();
            DrainWebuiMessages();
            DrainStopWebuiMessages();
            DrainDeveloperKitMessages();
            ProbeDesktopWindow();
        }

        private void ProbeDesktopWindow()
        {
            if (DateTime.UtcNow < nextDesktopProbe) return;
            nextDesktopProbe = DateTime.UtcNow.AddSeconds(1);
            var sourceDesktopRunning = IsSourceDesktopRunning();
            if ((desktopState == "starting" || desktopState == "restarting") && sourceDesktopRunning)
            {
                restarting = false;
                SetDesktopState("running");
            }
            else if (desktopState == "running" && !sourceDesktopRunning)
            {
                SetDesktopState("idle");
            }
        }

        private bool IsSourceDesktopRunning()
        {
            var expectedExecutable = Path.GetFullPath(Path.Combine(repoRoot, "node_modules", "electron", "dist", "electron.exe"));
            foreach (var process in Process.GetProcessesByName("electron"))
            {
                try
                {
                    if (process.Id == Process.GetCurrentProcess().Id || process.MainWindowHandle == IntPtr.Zero) continue;
                    var executable = process.MainModule?.FileName;
                    if (!string.IsNullOrEmpty(executable)
                        && string.Equals(Path.GetFullPath(executable), expectedExecutable, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch { }
                finally { process.Dispose(); }
            }
            return false;
        }

        private void DrainDesktopMessages()
        {
            if (desktopRunner == null) return;
            ProcessMessage message;
            var remaining = MaxMessagesPerDrain;
            while (remaining-- > 0 && desktopRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    if (Regex.IsMatch(message.Text, "Electron exited with code")) SetDesktopState("idle");
                    continue;
                }
                if (!closing && !IsSourceDesktopRunning()) SetDesktopState(message.ExitCode == 0 ? "idle" : "error");
                if (message.ExitCode != 0) AppendLog("tool", "桌面启动进程退出，代码 " + message.ExitCode + "。");
            }
        }

        private void DrainStopMessages()
        {
            if (stopRunner == null) return;
            ProcessMessage message;
            var remaining = MaxMessagesPerDrain;
            while (remaining-- > 0 && stopRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    continue;
                }
                var command = pendingDesktopControl;
                pendingDesktopControl = null;
                var explicitRestart = command == "restart";
                restarting = false;
                if (closing) continue;
                if (command == "legacy-restart-stop" || command == "legacy-start-stop")
                {
                    if (message.ExitCode != 0) AppendLog("tool", "停止返回代码 " + message.ExitCode + "，继续启动新实例。");
                    LaunchDesktop(command == "legacy-restart-stop");
                    continue;
                }
                if (message.ExitCode == 0) continue;
                if (message.ExitCode == 2)
                {
                    AppendLog("tool", "开发监督进程尚未运行，启动完整开发环境。");
                    if (explicitRestart) StopDesktopBeforeLaunch(true);
                    else LaunchDesktop();
                    continue;
                }
                AppendLog("tool", "桌面控制命令失败，代码 " + message.ExitCode + "。");
                SetDesktopState("error");
            }
        }

        private void DrainPackageMessages()
        {
            if (packageRunner == null) return;
            ProcessMessage message;
            var remaining = MaxMessagesPerDrain;
            while (remaining-- > 0 && packageRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    continue;
                }
                packageButton.Enabled = true;
                packageButton.Text = "打包";
                AppendLog("tool", message.ExitCode == 0 ? "打包完成。" : "打包失败，代码 " + message.ExitCode + "。");
            }
        }

        private void DrainWebuiMessages()
        {
            if (webuiRunner == null) return;
            ProcessMessage message;
            var remaining = MaxMessagesPerDrain;
            while (remaining-- > 0 && webuiRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    continue;
                }
                ResetWebuiStartButton();
                if (suppressNextWebuiExitError)
                {
                    suppressNextWebuiExitError = false;
                    continue;
                }
                AppendLog("tool", message.ExitCode == 0 ? "网页端已打开。" : "网页端启动失败，代码 " + message.ExitCode + "。");
            }
        }

        private void DrainStopWebuiMessages()
        {
            if (stopWebuiRunner == null) return;
            ProcessMessage message;
            var remaining = MaxMessagesPerDrain;
            while (remaining-- > 0 && stopWebuiRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    continue;
                }
                ResetWebuiStartButton();
                ResetStopWebuiButton();
                AppendLog("tool", message.ExitCode == 0
                    ? "网页端已停止。"
                    : "网页端停止失败，代码 " + message.ExitCode + "。");
            }
        }

        private void DrainDeveloperKitMessages()
        {
            if (developerKitRunner == null) return;
            ProcessMessage message;
            var remaining = MaxMessagesPerDrain;
            while (remaining-- > 0 && developerKitRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    continue;
                }
                ResetDeveloperKitButton();
                AppendLog("tool", message.ExitCode == 0
                    ? "开发者套件构建完成。"
                    : "开发者套件构建失败，代码 " + message.ExitCode + "。");
            }
        }

        private void ResetWebuiStartButton()
        {
            webuiButton.Enabled = (webuiRunner == null || !webuiRunner.IsRunning)
                && (stopWebuiRunner == null || !stopWebuiRunner.IsRunning);
            webuiButton.Text = "启动网页端";
        }

        private void ResetStopWebuiButton()
        {
            stopWebuiButton.Enabled = true;
            stopWebuiButton.Text = "停止网页端";
        }

        private void ResetDeveloperKitButton()
        {
            developerKitButton.Enabled = true;
            developerKitButton.Text = "构建开发者套件";
        }

        private void SetDesktopState(string state)
        {
            desktopState = state;
            if (state == "running")
            {
                statusText.Text = "运行中";
                statusDot.ForeColor = Color.FromArgb(20, 122, 67);
            }
            else if (state == "starting")
            {
                statusText.Text = "正在启动";
                statusDot.ForeColor = Color.FromArgb(178, 105, 19);
            }
            else if (state == "restarting")
            {
                statusText.Text = "正在重启";
                statusDot.ForeColor = Color.FromArgb(178, 105, 19);
            }
            else if (state == "stopping")
            {
                statusText.Text = "正在关闭";
                statusDot.ForeColor = Color.FromArgb(178, 105, 19);
            }
            else if (state == "error")
            {
                statusText.Text = "启动失败";
                statusDot.ForeColor = Color.FromArgb(182, 45, 45);
            }
            else
            {
                statusText.Text = "未启动";
                statusDot.ForeColor = Color.FromArgb(140, 142, 134);
            }

            startButton.Enabled = state == "idle" || state == "error";
            startButton.BackColor = startButton.Enabled
                ? Color.FromArgb(23, 24, 21)
                : Color.FromArgb(216, 216, 209);
            startButton.ForeColor = startButton.Enabled
                ? Color.White
                : Color.FromArgb(105, 106, 99);
            restartButton.Enabled = state == "running";
        }

        private void AppendCommand(params string[] values)
        {
            AppendLog("tool", "$ " + string.Join(" ", values));
        }

        private void AppendLog(string source, string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            var clean = Regex.Replace(value, "\\x1B\\[[0-?]*[ -/]*[@-~]", "");
            if (logBox.Text == "等待操作\n") logBox.Clear();
            logBox.AppendText("[" + source + "] " + clean + Environment.NewLine);
            if (logBox.TextLength > 120000) logBox.Text = logBox.Text.Substring(logBox.TextLength - 90000);
            logBox.SelectionStart = logBox.TextLength;
            logBox.ScrollToCaret();
        }
    }
}
'@
}

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
$form = [MortiseDevTool.MainForm]::new($repoRoot, -not $SmokeTest)

if ($SmokeTest) {
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 350
  [System.Windows.Forms.Application]::DoEvents()

  $screenshotPath = Join-Path ([System.IO.Path]::GetTempPath()) 'mortise-desktop-tool-smoke.png'
  $bitmap = [System.Drawing.Bitmap]::new($form.ClientSize.Width, $form.ClientSize.Height)
  $form.DrawToBitmap($bitmap, $form.ClientRectangle)
  $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()

  $buttons = @()
  $pending = [System.Collections.Generic.Queue[System.Windows.Forms.Control]]::new()
  $pending.Enqueue($form)
  while ($pending.Count -gt 0) {
    $control = $pending.Dequeue()
    if ($control -is [System.Windows.Forms.Button]) { $buttons += $control.Text }
    foreach ($child in $control.Controls) { $pending.Enqueue($child) }
  }

  [ordered]@{
    title = $form.Text
    buttons = @($buttons | Sort-Object)
    width = $form.ClientSize.Width
    height = $form.ClientSize.Height
    screenshot = $screenshotPath
  } | ConvertTo-Json -Compress
  $form.Close()
  exit 0
}

[System.Windows.Forms.Application]::Run($form)
