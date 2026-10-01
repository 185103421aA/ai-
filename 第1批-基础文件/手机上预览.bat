@echo off
rem ============================================================
rem  AI Competition Info Hub - "phone preview" launcher
rem
rem  Same as the static preview (port 8001, serves public\ as-is),
rem  except this one also listens on the local network so a phone
rem  on the same Wi-Fi / hotspot can open the site.
rem
rem  It prints the exact address to type into the phone browser.
rem  Nothing is generated or modified - this only sends files out.
rem
rem  IMPORTANT: keep this file ASCII-only. cmd reads .bat files with
rem  the local codepage, so Chinese here turns into garbage.
rem  All user-facing text is printed by deploy\static-preview.js.
rem ============================================================

title AI Competition Info Hub - phone preview
cd /d "%~dp0"

rem ---------- locate node (no hard-coded drive letter) ----------
call :findnode
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

rem ---------- listen on the local network, not just this PC ----------
set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=8001"

"%NODE_EXE%" deploy\static-preview.js

pause
exit /b 0

:findnode
set "NODE_EXE=node"
where node >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "C:\node\node.exe" set "NODE_EXE=C:\node\node.exe"
"%NODE_EXE%" --version >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0
