@echo off
chcp 65001 >nul
title Mehmonxona serveri
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js o'rnatilmagan: https://nodejs.org & pause & exit /b)
start "" http://localhost:3000
node server.js
pause
