@echo off
chcp 65001 >nul
title Isim Sehir ONLINE
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js yuklu degil. https://nodejs.org adresinden LTS surumunu kur, sonra tekrar ac. & pause & exit /b)

set "CF="
where cloudflared >nul 2>nul && set "CF=cloudflared"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set "CF=%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe"
if not defined CF (
  echo Cloudflare tunel programi kuruluyor ^(bir kerelik^)...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
  if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
  if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set "CF=%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe"
)
if not defined CF (echo Cloudflared kurulamadi. Bu pencereyi kapatip online_baslat.bat'i tekrar ac. & pause & exit /b)

start "Isim Sehir sunucu - KAPATMA" cmd /k node server.js
timeout /t 3 >nul
echo.
echo ==============================================================
echo  Birazdan asagida  https://....trycloudflare.com  linki cikacak.
echo  O linki arkadaslarina at, herkes oradan girsin.
echo  Bu iki pencere acik kaldigi surece oyun online.
echo ==============================================================
echo.
"%CF%" tunnel --url http://localhost:3000
pause
