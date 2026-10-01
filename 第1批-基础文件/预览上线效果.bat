@echo off
rem ============================================================
rem  AI Competition Info Hub - "static preview" launcher
rem
rem  Serves the generated pages with no program logic involved, so
rem  what you see is what the server will show. Port 8001.
rem
rem  IMPORTANT: keep this file ASCII-only. cmd reads .bat files with
rem  the local codepage, so Chinese here turns into garbage.
rem  All user-facing text is printed by deploy\static-preview.js.
rem ============================================================

title AI Competition Info Hub - static preview
cd /d "%~dp0"

rem ---------- locate node (no hard-coded drive letter) ----------
call :findnode
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

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
