@echo off
cd /d "%~dp0"
echo Isim Sehir sunucusu aciliyor... http://localhost:3000
start "" http://localhost:3000
node server.js
pause
