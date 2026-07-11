@echo off
setlocal EnableDelayedExpansion

where portmux >nul 2>nul
if errorlevel 1 (
  echo portmux is required to start the WebUI test environment.
  set "EXIT_CODE=1"
) else (
  portmux start
  set "EXIT_CODE=!ERRORLEVEL!"
)

if not "!EXIT_CODE!"=="0" (
  pause
)

exit /b !EXIT_CODE!
