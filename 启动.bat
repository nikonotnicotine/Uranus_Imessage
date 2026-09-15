@echo off
rem ============================================================
rem  Uranus iMessage - one-click launcher
rem
rem  Just double-click. The API and the console page are both
rem  served from 8787; the Instagram page gets its own port
rem  (6873) from the same process.
rem
rem  Change the port:      set PORT=8888  before running
rem  Skip the browser:     set URANUS_NO_BROWSER=1
rem
rem  Keep this file pure ASCII. cmd.exe mis-parses batch files
rem  containing multi-byte characters once they grow past a few
rem  KB, so all Chinese output lives in scripts\launch.mjs.
rem ============================================================

cd /d "%~dp0"
title Uranus iMessage

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found. Install v20+ from https://nodejs.org
  echo       then double-click this file again.
  echo.
  pause
  exit /b 1
)

node scripts\launch.mjs start
set "RC=%errorlevel%"

echo.
pause
exit /b %RC%