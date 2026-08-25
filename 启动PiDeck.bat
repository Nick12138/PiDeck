@echo off
chcp 65001 >nul
title PiDeck
cd /d "%~dp0"

echo Starting PiDeck...
call pnpm dev:fast
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] PiDeck exited with code %EXIT_CODE%.
    echo Please scroll up to review the error, then fix it and run this script again.
) else (
    echo PiDeck exited.
)

echo.
echo Window stays open - press any key to close it yourself.
pause >nul
exit /b %EXIT_CODE%
