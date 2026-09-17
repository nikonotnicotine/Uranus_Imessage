@echo off
rem ============================================================
rem  Uranus iMessage - one-click updater
rem
rem  Just double-click it. This stops the running service, pulls
rem  the newest release from GitHub, reinstalls dependencies only
rem  if they actually changed, and starts the service back up.
rem
rem  data\ is never touched. The old files are copied into
rem  .update-backup\ before anything is replaced.
rem
rem  Keep this file pure ASCII. cmd.exe mis-parses batch files
rem  containing multi-byte characters once they grow past a few
rem  KB, so all Chinese output lives in scripts\update.mjs.
rem
rem  The last line runs node and exits on the SAME line, so cmd
rem  parses both into memory and never re-reads this file. That
rem  matters: an update may replace this very file mid-run.
rem ============================================================

cd /d "%~dp0"
title Uranus Update

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found. Install v20+ from https://nodejs.org
  echo       then double-click this file again.
  echo.
  pause
  exit /b 1
)

rem  Coming from a version older than the updater itself: fetch it.
rem  curl.exe is built into Windows 10 1803+ and honours HTTPS_PROXY
rem  and %USERPROFILE%\.curlrc. Spell out the .exe so a stray curl.bat
rem  or curl.ps1 on PATH cannot shadow it.
if not exist "scripts\update.mjs" (
  echo   Fetching the updater ...
  if not exist "scripts" mkdir "scripts"
  curl.exe -fsSL -o "scripts\update.mjs" "https://raw.githubusercontent.com/nikonotnicotine/Uranus_Imessage/master/scripts/update.mjs"
  curl.exe -fsSL -o "scripts\port-check.mjs" "https://raw.githubusercontent.com/nikonotnicotine/Uranus_Imessage/master/scripts/port-check.mjs"
)

if not exist "scripts\update.mjs" (
  echo.
  echo   [X] Could not download the updater. Check the network, or
  echo       grab the ZIP from the releases page and update by hand:
  echo       https://github.com/nikonotnicotine/Uranus_Imessage/releases/latest
  echo.
  pause
  exit /b 1
)

set "URANUS_UPDATE_PAUSE=1"
node scripts\update.mjs %* & exit /b
