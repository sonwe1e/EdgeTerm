@echo off
rem Start EdgeTerm's dev app (real window, current source).
rem
rem The WebView2 GPU process cannot start under its own sandbox on this
rem machine: it crash-loops, Chromium logs "GPU process isn't usable.
rem Goodbye." and tears the browser process down, which is the blank window
rem that made the app look broken. Measured on WebView2 155.0.4283.62:
rem   6 GPU crashes + FATAL and a 9 s blank start without the switch below,
rem   0 GPU crashes and a 5 s start with it.
rem Drop the set line once the display driver or the security agent stops
rem breaking the GPU sandbox.
rem
rem The app also self-degrades now (gpu_fallback.rs remembers an unready
rem launch and drops the sandbox itself), but only from the second launch on;
rem this script forces it from the first.
setlocal
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu-sandbox
cd /d "%~dp0.."

powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://localhost:1420/' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting the Vite dev server...
  start "EdgeTerm dev server" /min cmd /c "npx vite"
  rem ping is the portable sleep: Git Bash puts a different timeout on PATH.
  ping -n 5 127.0.0.1 >nul
)

start "" "%~dp0..\src-tauri\target\debug\edgeterm.exe"
endlocal
