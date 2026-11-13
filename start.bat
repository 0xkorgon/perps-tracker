@echo off
title Perps Tracker
cd /d "%~dp0"

rem Opened from inside the zip: Windows only unpacks this one file, so nothing else is here.
if not exist "%~dp0server.js" (
  echo.
  echo   The tracker's files aren't next to start.bat.
  echo   If you opened it from inside the zip: right-click the zip, choose Extract All,
  echo   then open the extracted folder and double-click start.bat there.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed on this PC yet. It's free and takes a minute:
  echo     1. Download the LTS version from https://nodejs.org
  echo     2. Install it with the default options
  echo     3. Double-click start.bat again
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

node server.js %*
if errorlevel 1 pause
