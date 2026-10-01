@echo off
rem ============================================================
rem  AI Competition Info Hub - "prepare for deployment" launcher
rem
rem  It redraws the pages, runs the pre-flight checks and packs
rem  one zip into deploy\dist\.
rem
rem  IMPORTANT: keep this file ASCII-only. Windows cmd reads .bat
rem  files using the local codepage (936/GBK on a Chinese system),
rem  so Chinese characters here turn into garbage and may even be run
rem  as commands. All user-facing text is printed by deploy\prepare.js.
rem ============================================================

title AI Competition Info Hub - prepare deployment
cd /d "%~dp0"

rem ---------- locate node (no hard-coded drive letter) ----------
call :findnode
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

"%NODE_EXE%" deploy\prepare.js

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
