@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-hang.ps1"
echo.
pause
