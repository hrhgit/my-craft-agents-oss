@echo off
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo Mortise Desktop Tool requires PowerShell 7.
  pause
  exit /b 1
)
start "" pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\mortise-dev-tool\MortiseDesktopTool.ps1"
