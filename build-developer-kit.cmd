@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
bun run "%SCRIPT_DIR%scripts\build-developer-kit.ts" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  pause
)

exit /b %EXIT_CODE%
