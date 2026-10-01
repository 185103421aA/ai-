@echo off
rem ============================================================
rem  AI Competition Info Hub - read the feedback mailbox
rem
rem  Prints every message visitors left in the mailbox widget
rem  (stored one per line in data\feedback.jsonl).
rem
rem  IMPORTANT: keep this file ASCII-only. Windows cmd reads .bat
rem  files using the local codepage (936/GBK on a Chinese system),
rem  so Chinese characters here turn into garbage and may even be run
rem  as commands. All user-facing text is printed by src\read-feedback.js.
rem ============================================================

title AI Competition Info Hub - feedback mailbox
cd /d "%~dp0"

rem ---------- locate node (no hard-coded drive letter) ----------
call :findnode
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

"%NODE_EXE%" src\read-feedback.js

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
