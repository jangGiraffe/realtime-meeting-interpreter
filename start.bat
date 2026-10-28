@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed.
  echo     Install the LTS version from https://nodejs.org and run this file again.
  start https://nodejs.org/
  pause
  exit /b 1
)
:loop
node server.js
if errorlevel 1 goto end
set RESTARTED=1
goto loop
:end
pause
