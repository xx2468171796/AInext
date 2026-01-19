@echo off
setlocal enabledelayedexpansion

:: Set console to UTF-8
chcp 65001 >nul 2>&1

title Edge Remote Debug - Ask Continue

echo ========================================
echo    Edge Remote Debug Launcher
echo    For Ask Continue Remote Dev
echo ========================================
echo.

:: Check admin rights for firewall
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Requesting admin rights for firewall...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Find Edge
set "EDGE_PATH="
for %%P in (
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
) do (
    if exist %%P set "EDGE_PATH=%%~P"
)

if "%EDGE_PATH%"=="" (
    echo [ERROR] Edge not found!
    pause
    exit /b 1
)

echo [OK] Edge: %EDGE_PATH%
echo.

:: Open firewall port 9223
echo [SETUP] Opening firewall port 9223...
netsh advfirewall firewall delete rule name="Edge Remote Debug 9223" >nul 2>&1
netsh advfirewall firewall add rule name="Edge Remote Debug 9223" dir=in action=allow protocol=tcp localport=9223 >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] Firewall port 9223 opened
) else (
    echo [WARN] Could not open firewall port
)
echo.

:: Get local IP
echo [INFO] Your IP addresses:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "ip=%%a"
    set "ip=!ip: =!"
    if not "!ip!"=="" echo   - !ip!
)
echo.

:: Kill existing Edge debug instances
taskkill /f /im msedge.exe >nul 2>&1

:: Start Edge in debug mode
echo [START] Edge debug mode on port 9223
echo.
start "" "%EDGE_PATH%" --remote-debugging-port=9223 --remote-debugging-address=0.0.0.0 --user-data-dir="%TEMP%\edge-debug"

echo ========================================
echo    Edge Started Successfully!
echo ========================================
echo.
echo Use in your remote mcp_config.json:
echo   ws://YOUR_IP:9223
echo.
echo Press any key to exit...
pause >nul
