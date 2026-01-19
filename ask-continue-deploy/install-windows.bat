@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title MCP 服务一键安装

echo ========================================
echo    MCP 服务一键安装 (Windows)
echo    作者: 孤独制作
echo    电报群: https://t.me/+RZMe7fnvvUg1OWJl
echo ========================================
echo.

:: 解析命令行参数
set "INSTALL_ALL=0"
set "INSTALL_DIR=%USERPROFILE%\.mcp-services"
:parse_args
if "%~1"=="" goto :done_args
if /i "%~1"=="--all" set "INSTALL_ALL=1"
if /i "%~1"=="--install-dir" set "INSTALL_DIR=%~2" & shift
shift
goto :parse_args
:done_args

:: 检查 Python
echo [1/5] 检查环境依赖...
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python 3.10+
    echo 下载: https://www.python.org/downloads/
    pause
    exit /b 1
)
echo [OK] Python 已安装

:: 检查 Node.js
where npx >nul 2>&1
if errorlevel 1 (
    echo [警告] 未找到 Node.js/npx，部分 MCP 服务将无法安装
    echo 下载: https://nodejs.org/
    set "HAS_NPX=0"
) else (
    echo [OK] Node.js/npx 已安装
    set "HAS_NPX=1"
)

:: 创建安装目录
echo.
echo [2/5] 准备安装目录...
echo 安装目录: %INSTALL_DIR%
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
echo [OK] 安装目录已就绪

:: 安装 MCP 服务
echo.
echo [3/5] 安装 MCP 服务...
cd /d "%~dp0mcp-server-python"
pip install -r requirements.txt -q

if "%INSTALL_ALL%"=="1" (
    echo.
    echo [安装] 所有 MCP 服务...
    python install_mcp_config.py --all
) else (
    echo.
    echo [安装] ask-continue + chrome-devtools...
    python install_mcp_config.py --with-chrome --chrome-auto
)

if errorlevel 1 (
    echo [错误] MCP 配置失败
    pause
    exit /b 1
)
echo [OK] MCP 服务安装完成

:: 安装扩展提示
echo.
echo [4/5] 安装 VS Code 扩展...
echo.
echo ========================================
echo    请手动安装 VSIX 扩展:
echo ========================================
echo.
echo    1. 打开 Windsurf
echo    2. 按 Ctrl+Shift+P
echo    3. 输入: Install from VSIX
echo    4. 选择: %~dp0windsurf-ask-continue-1.1.0.vsix
echo    5. 重启 Windsurf

:: 完成
echo.
echo [5/5] 安装完成！
echo.
echo ========================================
echo    已安装的 MCP 服务:
echo ========================================
echo    [x] ask-continue    - 无限对话
echo    [x] chrome-devtools - 浏览器自动化
if "%INSTALL_ALL%"=="1" (
echo    [x] filesystem      - 文件操作
echo    [x] shell           - 命令执行
echo    [x] git             - Git 操作
)
echo.
echo ========================================
echo    使用说明:
echo ========================================
echo    - 重启 Windsurf 后生效
echo    - 侧边栏点击 "MCP 服务管理" 查看状态
echo    - 配置文件: %USERPROFILE%\.codeium\windsurf\mcp_config.json
echo.
echo ========================================
pause
