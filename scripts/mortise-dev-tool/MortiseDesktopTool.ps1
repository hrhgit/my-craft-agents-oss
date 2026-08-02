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
        private readonly string repoRoot;
        private readonly string electronProject;
        private readonly Label statusDot;
        private readonly Label statusText;
        private readonly Button startButton;
        private readonly Button restartButton;
        private readonly Button packageButton;
        private readonly RichTextBox logBox;
        private readonly Timer timer;

        private ProcessRunner desktopRunner;
        private ProcessRunner stopRunner;
        private ProcessRunner packageRunner;
        private bool restarting;
        private string desktopState = "idle";
        private DateTime nextDesktopProbe = DateTime.MinValue;

        public MainForm(string repositoryRoot)
        {
            repoRoot = repositoryRoot;
            electronProject = Path.Combine(repoRoot, "apps", "electron");

            Text = "Mortise 源码工具";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(820, 560);
            MinimumSize = new Size(640, 440);
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
                Height = 76,
                Padding = new Padding(24, 13, 24, 13),
                ColumnCount = 3,
                RowCount = 1,
            };
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333f));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333f));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.334f));

            startButton = CreateButton("启动", true, false);
            restartButton = CreateButton("重启", false, false);
            packageButton = CreateButton("打包", false, true);
            startButton.Click += (_, __) => StartDesktop();
            restartButton.Click += (_, __) => RestartDesktop();
            packageButton.Click += (_, __) => PackageDesktop();
            actions.Controls.Add(startButton, 0, 0);
            actions.Controls.Add(restartButton, 1, 0);
            actions.Controls.Add(packageButton, 2, 0);

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
            FormClosed += (_, __) => timer.Stop();
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
            LaunchDesktop();
        }

        private void LaunchDesktop()
        {
            desktopRunner?.Dispose();
            desktopRunner = new ProcessRunner();
            SetDesktopState("starting");
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
            restarting = true;
            SetDesktopState("restarting");
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

        private void DrainProcessMessages()
        {
            DrainDesktopMessages();
            DrainStopMessages();
            DrainPackageMessages();
            ProbeDesktopWindow();
        }

        private void ProbeDesktopWindow()
        {
            if (DateTime.UtcNow < nextDesktopProbe) return;
            nextDesktopProbe = DateTime.UtcNow.AddSeconds(1);
            if (desktopState == "running" && !IsSourceDesktopRunning())
            {
                SetDesktopState(desktopRunner != null && desktopRunner.IsRunning ? "stopping" : "idle");
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
            while (desktopRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    if (Regex.IsMatch(message.Text, "Starting Electron\\.\\.\\.\\s*$")) SetDesktopState("running");
                    continue;
                }
                if (!restarting) SetDesktopState(message.ExitCode == 0 ? "idle" : "error");
                if (message.ExitCode != 0) AppendLog("tool", "桌面启动进程退出，代码 " + message.ExitCode + "。");
            }
        }

        private void DrainStopMessages()
        {
            if (stopRunner == null) return;
            ProcessMessage message;
            while (stopRunner.Messages.TryDequeue(out message))
            {
                if (!message.IsExit)
                {
                    AppendLog(message.Source, message.Text);
                    continue;
                }
                if (message.ExitCode != 0) AppendLog("tool", "停止返回代码 " + message.ExitCode + "，继续启动新实例。");
                restarting = false;
                LaunchDesktop();
            }
        }

        private void DrainPackageMessages()
        {
            if (packageRunner == null) return;
            ProcessMessage message;
            while (packageRunner.Messages.TryDequeue(out message))
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
            restartButton.Enabled = state != "restarting" && state != "stopping";
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
$form = [MortiseDevTool.MainForm]::new($repoRoot)

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
