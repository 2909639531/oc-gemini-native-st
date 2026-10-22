@echo off
chcp 65001 >nul
title OC Gemini Native - Relay
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 没找到 node 命令。
    echo   请先安装 Node.js 20 或更新版本： https://nodejs.org/
    echo   装完后重新双击本文件。
    echo.
    pause
    exit /b 1
)

echo.
echo   正在启动本地中转... 关掉这个窗口就等于断开。
echo.
node "%~dp0relay.js"

echo.
echo   中转已退出（退出码 %errorlevel%）。
pause
