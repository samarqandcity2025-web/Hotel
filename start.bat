@echo off
chcp 65001 >nul
title Mehmonxona serveri - YOPMANG
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js o'rnatilmagan: https://nodejs.org & pause & exit /b)
if not exist node_modules\web-push (
  echo Kerakli kutubxonalar o'rnatilmoqda...
  call npm install --omit=dev
)
rem Internet manzili (Tailscale o'rnatilgan bo'lsa)
where tailscale >nul 2>nul && tailscale funnel --bg 3000
start "" http://localhost:3000
node server.js
pause
