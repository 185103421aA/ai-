@echo off
rem ============================================================
rem  AI Competition Info Hub - "daily auto collect" launcher
rem  Keep ASCII-only, see the note in the start-site .bat file.
rem
rem  To change the collection time, set COLLECT_AT before running:
rem     set COLLECT_AT=04:30
rem     daily-collect.bat
rem ============================================================

title AI Competition Info Hub - daily auto collect
cd /d "%~dp0"

call :findnode
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

"%NODE_EXE%" src\launcher.js daily

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
