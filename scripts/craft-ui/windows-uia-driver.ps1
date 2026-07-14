$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CraftUiNativeWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
}
'@

$requestText = [Console]::In.ReadToEnd()
$request = $requestText | ConvertFrom-Json
if ($request.v -ne 1) { throw 'Unsupported Windows UI Automation protocol version.' }
if ($request.processId -lt 1) { throw 'Invalid processId.' }

function Get-Patterns($element) {
  $result = @()
  foreach ($entry in @(
    @{ Name = 'Invoke'; Pattern = [System.Windows.Automation.InvokePattern]::Pattern },
    @{ Name = 'Value'; Pattern = [System.Windows.Automation.ValuePattern]::Pattern },
    @{ Name = 'SelectionItem'; Pattern = [System.Windows.Automation.SelectionItemPattern]::Pattern },
    @{ Name = 'ExpandCollapse'; Pattern = [System.Windows.Automation.ExpandCollapsePattern]::Pattern },
    @{ Name = 'Window'; Pattern = [System.Windows.Automation.WindowPattern]::Pattern }
  )) {
    $pattern = $null
    if ($element.TryGetCurrentPattern($entry.Pattern, [ref]$pattern)) { $result += $entry.Name }
  }
  return $result
}

function Convert-Bounds($rect) {
  foreach ($value in @($rect.X, $rect.Y, $rect.Width, $rect.Height)) {
    if ([Double]::IsNaN([double]$value) -or [Double]::IsInfinity([double]$value)) { return $null }
  }
  return [ordered]@{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height }
}

function Convert-Element($element, $maxNodes) {
  if ($script:nodeCount -ge $maxNodes) { return $null }
  try {
    $script:nodeCount++
    $rect = $element.Current.BoundingRectangle
    $controlType = $element.Current.ControlType
    return [ordered]@{
      runtimeId = (($element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')
      role = if ($null -ne $controlType) { [string]$controlType.ProgrammaticName.Replace('ControlType.', '') } else { '' }
      name = [string]$element.Current.Name
      automationId = [string]$element.Current.AutomationId
      enabled = [bool]$element.Current.IsEnabled
      focused = [bool]$element.Current.HasKeyboardFocus
      bounds = Convert-Bounds $rect
      patterns = @(Get-Patterns $element)
      children = @()
    }
  } catch {
    # Chromium's accessibility tree can invalidate an individual element between FindAll and property reads.
    return $null
  }
}

$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
  [int]$request.processId
)
$roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  $condition
)

if ($request.operation -eq 'snapshot') {
  $maxNodes = [Math]::Min([Math]::Max([int]$request.maxNodes, 1), 1000)
  $script:nodeCount = 0
  $windows = @()
  foreach ($root in $roots) {
    $converted = Convert-Element $root $maxNodes
    if ($null -eq $converted) { continue }
    $rootRuntimeId = [string]$converted.runtimeId
    $children = @()
    $descendants = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Subtree,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($descendant in $descendants) {
      if ($script:nodeCount -ge $maxNodes) { break }
      $child = Convert-Element $descendant $maxNodes
      if ($null -ne $child -and [string]$child.runtimeId -eq $rootRuntimeId) { continue }
      if ($null -ne $child) { $children += $child }
    }
    $converted.children = $children
    $windows += $converted
  }
  [ordered]@{ windows = $windows; truncated = ($script:nodeCount -ge $maxNodes) } | ConvertTo-Json -Depth 100 -Compress
  exit 0
}

if ($request.operation -ne 'action') { throw 'Unsupported operation.' }
$target = $null
$all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
  [System.Windows.Automation.TreeScope]::Subtree,
  $condition
)
foreach ($element in $all) {
  $runtimeId = (($element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')
  if ($runtimeId -eq [string]$request.runtimeId) { $target = $element; break }
}
if ($null -eq $target) { throw 'Native target no longer exists.' }
if (-not $target.Current.IsEnabled) { throw 'Native target is disabled.' }

if ($request.action -eq 'focus') {
  $handle = [IntPtr]$target.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) {
    # SW_RESTORE also restores minimized windows. Suppress native return values so stdout stays JSON-only.
    [CraftUiNativeWindow]::ShowWindow($handle, 9) | Out-Null
    [CraftUiNativeWindow]::SetForegroundWindow($handle) | Out-Null
  } else {
    $target.SetFocus()
  }
} elseif ($request.action -eq 'fill') {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $pattern.SetValue([string]$request.value)
} elseif ($request.action -eq 'select') {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $pattern.Select()
} elseif ($request.action -eq 'click') {
  $pattern = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
  } else {
    $point = New-Object System.Windows.Point
    if (-not $target.TryGetClickablePoint([ref]$point)) { throw 'Native target has no clickable point.' }
    Add-Type @'
using System.Runtime.InteropServices;
public static class CraftUiMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
}
'@
    [CraftUiMouse]::SetCursorPos([int]$point.X, [int]$point.Y) | Out-Null
    [CraftUiMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [CraftUiMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
} elseif (@('minimize', 'maximize', 'restore', 'close') -contains $request.action) {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  if ($request.action -eq 'close') { $pattern.Close() }
  elseif ($request.action -eq 'minimize') { $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized) }
  elseif ($request.action -eq 'maximize') { $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Maximized) }
  else { $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) }
} else { throw 'Unsupported native action.' }
[ordered]@{ ok = $true } | ConvertTo-Json -Compress
