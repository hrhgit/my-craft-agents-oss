@echo off
setlocal EnableDelayedExpansion

where portmux >nul 2>nul
if errorlevel 1 (
  echo portmux is required to stop the WebUI test environment.
  set "EXIT_CODE=1"
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-webui.ps1"
  set "EXIT_CODE=!ERRORLEVEL!"
)

if not "!EXIT_CODE!"=="0" (
  pause
)

exit /b !EXIT_CODE!
