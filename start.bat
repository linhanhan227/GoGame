@echo off
cd /d "%~dp0"
title Online Go

if not exist "node_modules" (
  echo [1/2] Installing dependencies...
  call npm install
)

echo.
echo   Online Go starting at http://localhost:8080
echo   Press Ctrl+C to stop.
echo.
start "" http://localhost:8080
REM npm start 会走 scripts/boot.js：dist 缺失或源码更新时自动构建
call npm start
pause
