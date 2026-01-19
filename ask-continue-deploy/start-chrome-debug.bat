@echo off
setlocal enabledelayedexpansion

:: Set console to UTF-8
chcp 65001 >nul 2>&1

title Chrome Remote Debug - Ask Continue

echo ========================================
echo    Chrome Remote Debug Launcher
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

:: Find Chrome
set "CHROME_PATH="
for %%P in (
    "C:\Program Files\Google\Chrome\Application\chrome.exe"
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do (
    if exist %%P set "CHROME_PATH=%%~P"
)

if "%CHROME_PATH%"=="" (
    echo [ERROR] Chrome not found!
    echo Please install Google Chrome first.
    pause
    exit /b 1
)

echo [OK] Chrome: %CHROME_PATH%
echo.

:: Open firewall port 9222
echo [SETUP] Opening firewall port 9222...
netsh advfirewall firewall delete rule name="Chrome Remote Debug 9222" >nul 2>&1
netsh advfirewall firewall add rule name="Chrome Remote Debug 9222" dir=in action=allow protocol=tcp localport=9222 >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] Firewall port 9222 opened
) else (
    echo [WARN] Could not open firewall port
)

:: Setup port forwarding (Chrome ignores --remote-debugging-address on newer versions)
echo [SETUP] Configuring port forwarding...
netsh interface portproxy delete v4tov4 listenport=9222 listenaddress=0.0.0.0 >nul 2>&1
netsh interface portproxy add v4tov4 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1 >nul 2>&1
echo [OK] Port forwarding: 0.0.0.0:9222 -^> 127.0.0.1:9222
echo.

:: Get local IP
echo [INFO] Your IP addresses:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "ip=%%a"
    set "ip=!ip: =!"
    if not "!ip!"=="" echo   - !ip!
)
echo.

:: Kill existing Chrome debug instances
taskkill /f /im chrome.exe >nul 2>&1

:: Start Chrome in debug mode
echo [START] Chrome debug mode on port 9222
echo.
start "" "%CHROME_PATH%" --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir="%TEMP%\chrome-debug"

echo ========================================
echo    Chrome Started Successfully!
echo ========================================
echo.
echo Use in your remote mcp_config.json:
echo   ws://YOUR_IP:9222
echo.
echo Press any key to exit...
pause >nul
