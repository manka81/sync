@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Lampa Sync Plugin Build...
echo Working directory: %cd%
node build.js
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed with exit code %ERRORLEVEL%!
    pause
    exit /b %ERRORLEVEL%
)
echo [SUCCESS] Build completed successfully!
timeout /t 2 >nul
exit /b 0