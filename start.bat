@echo off
cd /d "%~dp0"
title Online Go

if not exist "node_modules" (
  echo [1/2] Installing dependencies...
  call npm install
)
if not exist "dist" (
  echo [2/2] Building frontend...
  call npm run build
)

echo.
echo   Online Go starting at http://localhost:8080
echo   Press Ctrl+C to stop.
echo.
start "" http://localhost:8080
node --no-warnings server/index.js
pause
