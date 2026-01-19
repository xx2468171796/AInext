#!/usr/bin/env python3
"""
MCP 配置安装脚本
安全地将 ask-continue 配置合并到现有的 mcp_config.json 中，不会覆盖其他配置
支持可选的 Chrome DevTools MCP 配置
"""

import json
import os
import sys
import shutil
import subprocess
import requests
from pathlib import Path
from datetime import datetime


def get_mcp_config_path():
    """获取 Windsurf MCP 配置文件路径"""
    home = Path.home()
    return home / ".codeium" / "windsurf" / "mcp_config.json"


def get_server_path():
    """获取 server.py 的绝对路径（使用正斜杠）"""
    script_dir = Path(__file__).parent.resolve()
    server_path = script_dir / "server.py"
    # 转换为正斜杠格式
    return str(server_path).replace("\\", "/")


def backup_config(config_path: Path):
    """备份现有配置文件"""
    if config_path.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = config_path.with_suffix(f".backup_{timestamp}.json")
        shutil.copy2(config_path, backup_path)
        print(f"[备份] 已备份原配置到: {backup_path}")
        return backup_path
    return None


def load_existing_config(config_path: Path) -> dict:
    """加载现有配置，如果不存在或无效则返回空配置"""
    if not config_path.exists():
        return {"mcpServers": {}}
    
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return {"mcpServers": {}}
            config = json.loads(content)
            # 确保 mcpServers 字段存在
            if "mcpServers" not in config:
                config["mcpServers"] = {}
            return config
    except json.JSONDecodeError as e:
        print(f"[警告] 现有配置文件 JSON 格式无效: {e}")
        print("[提示] 将创建新配置，原文件已备份")
        return {"mcpServers": {}}
    except Exception as e:
        print(f"[警告] 读取配置文件失败: {e}")
        return {"mcpServers": {}}


def command_exists(command):
    """检查命令是否存在"""
    try:
        subprocess.run(["where", command] if os.name == "nt" else ["which", command], 
                      check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        return False


def test_chrome_connection(host, port, timeout=5):
    """测试 Chrome 调试端点连接"""
    try:
        response = requests.get(f"http://{host}:{port}/json", timeout=timeout)
        return response.status_code == 200
    except:
        return False


def get_chrome_mcp_config():
    """交互式 Chrome MCP 配置"""
    # 检查 Node.js/npx 可用性
    if not command_exists("npx"):
        print("[错误] 未找到 npx 命令")
        print("[信息] Chrome DevTools MCP 需要 Node.js 和 npx")
        print("[提示] 请安装 Node.js: https://nodejs.org/")
        choice = input("是否跳过 Chrome 配置? (Y/n): ").strip().lower()
        if choice != 'n':
            return None
    
    print("\n配置 Chrome DevTools MCP:")
    print("1) 本地开发 (本机 Chrome)")
    print("2) 远程开发 (远程 Chrome)")
    print("3) 跳过 Chrome 配置")
    
    while True:
        choice = input("选择选项 [1/2/3]: ").strip()
        if choice in ["1", "2", "3"]:
            break
        print("无效选择，请输入 1、2 或 3")
    
    if choice == "1":
        return setup_local_chrome()
    elif choice == "2":
        return setup_remote_chrome()
    else:
        return None


def setup_local_chrome():
    """配置本地 Chrome MCP"""
    print("[信息] 配置本地 Chrome...")
    
    # 检查 Chrome 是否可用
    if not command_exists("chrome"):
        print("[警告] 未找到 Chrome 浏览器")
        choice = input("是否继续配置? (y/N): ").strip().lower()
        if choice != 'y':
            return None
    
    # 测试 Chrome 连接
    if not test_chrome_connection("127.0.0.1", 9222):
        print("[信息] Chrome 调试模式未运行")
        print("[提示] 安装完成后请运行 start-chrome-debug.bat")
    
    return {
        "command": "npx",
        "args": ["chrome-devtools-mcp@latest"],
        "env": {
            "CHROME_CDP_URL": "ws://127.0.0.1:9222"
        }
    }


def setup_remote_chrome():
    """配置远程 Chrome MCP"""
    print("[信息] 配置远程 Chrome...")
    
    while True:
        ip = input("输入远程 Chrome IP 地址: ").strip()
        if ip:
            break
        print("IP 地址不能为空")
    
    port = input("输入远程 Chrome 端口 [9222]: ").strip() or "9222"
    
    try:
        port = int(port)
    except ValueError:
        print("[错误] 端口号必须是数字")
        return None
    
    print(f"[信息] 测试连接到 {ip}:{port}...")
    if test_chrome_connection(ip, port):
        print(f"[OK] 成功连接到远程 Chrome")
        return {
            "command": "npx",
            "args": ["chrome-devtools-mcp@latest"],
            "env": {
                "CHROME_CDP_URL": f"ws://{ip}:{port}"
            }
        }
    else:
        print(f"[错误] 无法连接到 {ip}:{port}")
        choice = input("是否重试? (y/N): ").strip().lower()
        if choice == 'y':
            return setup_remote_chrome()
        return None


def install_mcp_config(with_chrome=False, chrome_auto=False):
    """安装/更新 MCP 配置"""
    config_path = get_mcp_config_path()
    server_path = get_server_path()
    
    print(f"[信息] MCP 配置路径: {config_path}")
    print(f"[信息] Server 路径: {server_path}")
    
    # 确保目录存在
    config_path.parent.mkdir(parents=True, exist_ok=True)
    
    # 备份现有配置
    backup_config(config_path)
    
    # 加载现有配置
    config = load_existing_config(config_path)
    
    # 检查是否已存在 ask-continue 配置
    if "ask-continue" in config["mcpServers"]:
        print("[信息] 检测到已有 ask-continue 配置，将更新")
    
    # 添加/更新 ask-continue 配置
    config["mcpServers"]["ask-continue"] = {
        "command": "python",
        "args": [server_path]
    }
    
    # Chrome MCP 配置
    chrome_config = None
    if with_chrome:
        if chrome_auto:
            # 自动模式：直接配置本地 Chrome，无需交互
            # Windows 本地模式不需要 CHROME_CDP_URL，MCP 会自动管理浏览器
            print("[信息] 自动配置本地 Chrome MCP...")
            chrome_config = {
                "command": "npx",
                "args": ["chrome-devtools-mcp@latest"]
            }
        else:
            # 交互模式
            chrome_config = get_chrome_mcp_config()
        
        if chrome_config:
            config["mcpServers"]["chrome-devtools"] = chrome_config
            print("[OK] Chrome DevTools MCP 已配置")
            # 设置环境变量供批处理脚本使用
            os.environ["CHROME_MCP_ENABLED"] = "1"
        else:
            print("[信息] 跳过 Chrome MCP 配置")
    
    # 写入配置
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        print(f"[OK] MCP 配置已更新: {config_path}")
        
        # 显示当前所有配置的 MCP 服务器
        servers = list(config["mcpServers"].keys())
        print(f"[信息] 当前已配置的 MCP 服务器: {', '.join(servers)}")
        
        if chrome_config:
            print("\nChrome MCP 使用说明:")
            print("- 运行 start-chrome-debug.bat 启动 Chrome 调试模式")
            print("- 在 Windsurf 中可使用浏览器自动化工具")
        
        return True
    except Exception as e:
        print(f"[错误] 写入配置失败: {e}")
        return False


def uninstall_mcp_config():
    """卸载 ask-continue 配置（保留其他配置）"""
    config_path = get_mcp_config_path()
    
    if not config_path.exists():
        print("[信息] 配置文件不存在，无需卸载")
        return True
    
    # 备份
    backup_config(config_path)
    
    # 加载配置
    config = load_existing_config(config_path)
    
    # 移除 ask-continue
    if "ask-continue" in config["mcpServers"]:
        del config["mcpServers"]["ask-continue"]
        print("[OK] 已移除 ask-continue 配置")
    else:
        print("[信息] ask-continue 配置不存在")
    
    # 写回
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        
        servers = list(config["mcpServers"].keys())
        if servers:
            print(f"[信息] 保留的 MCP 服务器: {', '.join(servers)}")
        else:
            print("[信息] 当前无其他 MCP 服务器配置")
        return True
    except Exception as e:
        print(f"[错误] 写入配置失败: {e}")
        return False


def install_all_services():
    """安装所有 MCP 服务"""
    config_path = get_mcp_config_path()
    server_path = get_server_path()
    
    print("[信息] 安装所有 MCP 服务...")
    
    # 确保目录存在
    config_path.parent.mkdir(parents=True, exist_ok=True)
    
    # 备份现有配置
    backup_config(config_path)
    
    # 加载现有配置
    config = load_existing_config(config_path)
    
    # 用户主目录
    home_dir = str(Path.home()).replace("\\", "/")
    
    # 配置所有服务 - 使用正确的官方包名
    config["mcpServers"] = {
        "ask-continue": {
            "command": "python",
            "args": [server_path]
        },
        "chrome-devtools": {
            "command": "npx",
            "args": ["-y", "chrome-devtools-mcp@latest"]
        },
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", home_dir]
        },
        "shell": {
            "command": "npx",
            "args": ["-y", "shell-mcp-server"],
            "env": {}
        },
        "memory": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"]
        },
        "fetch": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-fetch"]
        },
        "sqlite": {
            "command": "npx",
            "args": ["-y", "mcp-sqlite"]
        }
    }
    
    # 写入配置
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        print(f"[OK] MCP 配置已更新: {config_path}")
        
        servers = list(config["mcpServers"].keys())
        print(f"[信息] 已配置的 MCP 服务: {', '.join(servers)}")
        return True
    except Exception as e:
        print(f"[错误] 写入配置失败: {e}")
        return False


if __name__ == "__main__":
    with_chrome = "--with-chrome" in sys.argv
    chrome_auto = "--chrome-auto" in sys.argv
    install_all = "--all" in sys.argv
    
    if len(sys.argv) > 1 and sys.argv[1] == "--uninstall":
        success = uninstall_mcp_config()
    elif install_all:
        success = install_all_services()
    else:
        success = install_mcp_config(with_chrome=with_chrome, chrome_auto=chrome_auto)
    
    sys.exit(0 if success else 1)
