@echo off
rem Double-click to start Site Editor. Keep this window open while editing.
chcp 65001 >nul
cd /d "%~dp0"
set SITE_EDITOR_OPEN=1
node server.js
pause
