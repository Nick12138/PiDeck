@echo off
chcp 65001 >nul
title PiDeck
cd /d "%~dp0"

echo Starting PiDeck...
call pnpm dev:fast

echo.
echo PiDeck exited. Closing in 3 seconds...
timeout /t 3 /nobreak >nul
