@echo off
setlocal EnableDelayedExpansion

where portmux >nul 2>nul
if errorlevel 1 (
  echo portmux is required to start the WebUI test environment.
  set "EXIT_CODE=1"
) else (
  set "WEBUI_INSTANCE=%~1"
  if "!WEBUI_INSTANCE!"=="" set "WEBUI_INSTANCE=1"
  if "!WEBUI_INSTANCE!"=="1" (
    portmux start --project "%~dp0."
  ) else (
    powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-webui-instance.ps1" -Instance "!WEBUI_INSTANCE!"
  )
  set "EXIT_CODE=!ERRORLEVEL!"
)

if not "!EXIT_CODE!"=="0" (
  pause
)

exit /b !EXIT_CODE!
