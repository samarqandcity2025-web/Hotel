@echo off
chcp 65001 >nul
title Mehmonxona - sinov serveri
cd /d "%~dp0"
rem Kompyuterda sinash uchun. Asosiy ishchi versiya Vercel'da ishlaydi.
where node >nul 2>nul || (echo Node.js o'rnatilmagan: https://nodejs.org & pause & exit /b)
if not exist node_modules\web-push (
  echo Kerakli kutubxonalar o'rnatilmoqda...
  call npm install
)
start "" http://localhost:3000
node server.js
pause
