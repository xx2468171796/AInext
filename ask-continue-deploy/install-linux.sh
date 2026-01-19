#!/bin/bash
# Ask Continue 一键安装 (Linux/macOS/远程SSH)
# 作者: 孤独制作
# 电报群: https://t.me/+RZMe7fnvvUg1OWJl
# 支持 Debian/Ubuntu 的 externally-managed-environment

set -e
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.ask-continue"
VENV_DIR="$INSTALL_DIR/venv"

# 解析命令行参数
INSTALL_ALL=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --all) INSTALL_ALL=1; shift;;
    --install-dir) INSTALL_DIR="$2"; VENV_DIR="$INSTALL_DIR/venv"; shift 2;;
    *) shift;;
  esac
done

echo "========================================"
echo "   MCP 服务一键安装 (Linux/SSH)"
echo "   作者: 孤独制作"
echo "========================================"
echo ""

# ========== 系统检测 ==========
echo "[0/5] 检测系统环境..."

# 检测操作系统
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    OS_VERSION=$VERSION_ID
    echo -e "${GREEN}[系统] $OS $VERSION_ID${NC}"
else
    OS="Unknown"
    echo -e "${YELLOW}[!] 无法检测操作系统${NC}"
fi

# 检测用户权限
if [ "$(id -u)" = "0" ]; then
    USER_TYPE="root"
    SUDO_CMD=""
    echo -e "${GREEN}[用户] root 权限${NC}"
else
    USER_TYPE="normal"
    SUDO_CMD="sudo"
    echo -e "${GREEN}[用户] 普通用户 (使用 sudo)${NC}"
fi

# 检测包管理器
if command -v apt-get &> /dev/null; then
    PKG_MANAGER="apt"
    PKG_UPDATE="$SUDO_CMD apt-get update -qq"
    PKG_INSTALL="$SUDO_CMD apt-get install -y"
    echo -e "${GREEN}[包管理] APT${NC}"
elif command -v yum &> /dev/null; then
    PKG_MANAGER="yum"
    PKG_UPDATE="$SUDO_CMD yum update -y"
    PKG_INSTALL="$SUDO_CMD yum install -y"
    echo -e "${GREEN}[包管理] YUM${NC}"
elif command -v dnf &> /dev/null; then
    PKG_MANAGER="dnf"
    PKG_UPDATE="$SUDO_CMD dnf update -y"
    PKG_INSTALL="$SUDO_CMD dnf install -y"
    echo -e "${GREEN}[包管理] DNF${NC}"
elif command -v brew &> /dev/null; then
    PKG_MANAGER="brew"
    PKG_UPDATE="brew update"
    PKG_INSTALL="brew install"
    echo -e "${GREEN}[包管理] Homebrew${NC}"
else
    echo -e "${RED}[错误] 不支持的包管理器${NC}"
    exit 1
fi

echo ""

# ========== 1. 检查并安装 Python ==========
echo "[1/5] 检查 Python 环境..."

# 检查是否有 Python3
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
    PYTHON_VERSION=$($PYTHON_CMD -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    echo -e "${GREEN}[OK] 找到 Python: $($PYTHON_CMD --version)${NC}"
else
    echo -e "${YELLOW}[!] Python3 未安装，正在安装最新版本...${NC}"
    case $PKG_MANAGER in
        "apt")
            $PKG_UPDATE
            # 安装最新 Python3 和相关包
            $PKG_INSTALL software-properties-common
            if [ "$USER_TYPE" = "root" ]; then
                add-apt-repository ppa:deadsnakes/ppa -y
            else
                sudo add-apt-repository ppa:deadsnakes/ppa -y
            fi
            $PKG_UPDATE
            $PKG_INSTALL python3 python3.12 python3-venv python3-pip
            PYTHON_CMD="python3.12"
            ;;
        "yum")
            $PKG_UPDATE
            $PKG_INSTALL centos-release-scl
            $PKG_INSTALL rh-python312 python3-pip
            PYTHON_CMD="python3.12"
            ;;
        "dnf")
            $PKG_UPDATE
            $PKG_INSTALL python3.12 python3-pip
            PYTHON_CMD="python3.12"
            ;;
        "brew")
            $PKG_UPDATE
            $PKG_INSTALL python@3.12
            PYTHON_CMD="python3.12"
            ;;
    esac
fi

# 优先使用最新的 Python 版本
for py_version in python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v $py_version &> /dev/null; then
        PYTHON_CMD=$py_version
        break
    fi
done

echo -e "${GREEN}[OK] 使用 Python: $($PYTHON_CMD --version)${NC}"

# ========== 2. 检查并安装 python3-venv ==========
echo ""
echo "[2/5] 检查虚拟环境支持..."

# 获取 Python 版本号（如 3.11）
PYTHON_VERSION=$($PYTHON_CMD -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")

if ! $PYTHON_CMD -m venv --help &> /dev/null; then
    echo -e "${YELLOW}[!] python3-venv 未安装，正在安装...${NC}"
    case $PKG_MANAGER in
        "apt")
            echo "运行: $PKG_UPDATE && $PKG_INSTALL python${PYTHON_VERSION}-venv python3-pip"
            $PKG_UPDATE
            
            # 尝试安装对应版本的 venv
            VENV_PACKAGES="python${PYTHON_VERSION}-venv python3.12-venv python3.11-venv python3.10-venv python3.9-venv python3-venv"
            VENV_INSTALLED=false
            
            for package in $VENV_PACKAGES; do
                echo "尝试安装: $package"
                if $PKG_INSTALL $package python3-pip 2>/dev/null; then
                    echo -e "${GREEN}[OK] 成功安装: $package${NC}"
                    VENV_INSTALLED=true
                    break
                fi
            done
            
            if [ "$VENV_INSTALLED" = false ]; then
                echo -e "${RED}[错误] 无法安装 python3-venv 包${NC}"
                exit 1
            fi
            ;;
        "yum")
            $PKG_INSTALL python3-pip python3-venv
            ;;
        "dnf")
            $PKG_INSTALL python3-pip python3-venv
            ;;
        "brew")
            $PKG_INSTALL python@3.12
            ;;
    esac
fi

# 最终检查
if ! $PYTHON_CMD -m venv --help &> /dev/null; then
    echo -e "${RED}[错误] venv 模块安装失败${NC}"
    echo "请手动运行: sudo apt-get install python${PYTHON_VERSION}-venv"
    exit 1
fi

# 额外检查：确保 ensurepip 可用
echo -e "${YELLOW}[!] 检查 ensurepip 可用性...${NC}"
if ! $PYTHON_CMD -c "import ensurepip; print('ensurepip OK')" 2>/dev/null; then
    echo -e "${YELLOW}[!] ensurepip 不可用，尝试安装 python${PYTHON_VERSION}-distutils...${NC}"
    case $PKG_MANAGER in
        "apt")
            $PKG_INSTALL python${PYTHON_VERSION}-distutils python3-distutils 2>/dev/null || true
            ;;
        "yum")
            $PKG_INSTALL python3-distutils 2>/dev/null || true
            ;;
        "dnf")
            $PKG_INSTALL python3-distutils 2>/dev/null || true
            ;;
        "brew")
            # Homebrew 通常包含 distutils
            ;;
    esac
fi

echo -e "${GREEN}[OK] venv 模块已安装${NC}"

# ========== 3. 创建虚拟环境并安装依赖 ==========
echo ""
echo "[3/5] 创建虚拟环境并安装依赖..."

mkdir -p "$INSTALL_DIR"

# 复制 MCP Server 到安装目录
cp -r "$SCRIPT_DIR/mcp-server-python/"* "$INSTALL_DIR/"

# 删除旧的虚拟环境（如果存在）
if [ -d "$VENV_DIR" ]; then
    echo -e "${YELLOW}[!] 删除旧虚拟环境...${NC}"
    rm -rf "$VENV_DIR"
fi

# 创建虚拟环境
echo "创建虚拟环境: $VENV_DIR"
if ! $PYTHON_CMD -m venv "$VENV_DIR"; then
    echo -e "${RED}[错误] 虚拟环境创建失败${NC}"
    echo "尝试使用 --system-site-packages 选项..."
    if ! $PYTHON_CMD -m venv "$VENV_DIR" --system-site-packages; then
        echo -e "${RED}[错误] 虚拟环境创建完全失败${NC}"
        echo -e "${YELLOW}[!] 尝试安装 python${PYTHON_VERSION}-venv 包...${NC}"
        case $PKG_MANAGER in
            "apt")
                $PKG_UPDATE
                $PKG_INSTALL python${PYTHON_VERSION}-venv python${PYTHON_VERSION}-distutils python3-distutils 2>/dev/null || true
                ;;
            "yum")
                $PKG_INSTALL python3-pip python3-venv python3-distutils 2>/dev/null || true
                ;;
            "dnf")
                $PKG_INSTALL python3-pip python3-venv python3-distutils 2>/dev/null || true
                ;;
            "brew")
                $PKG_INSTALL python@3.12 2>/dev/null || true
                ;;
        esac
        echo "再次尝试创建虚拟环境..."
        if $PYTHON_CMD -m venv "$VENV_DIR"; then
            echo -e "${GREEN}[OK] 虚拟环境创建成功${NC}"
        else
            echo -e "${RED}[错误] 虚拟环境创建仍然失败${NC}"
            exit 1
        fi
    fi
fi

# 检查虚拟环境是否正确创建
if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo -e "${RED}[错误] 虚拟环境激活脚本不存在${NC}"
    exit 1
fi

# 激活虚拟环境并安装依赖
echo "激活虚拟环境并安装依赖..."
source "$VENV_DIR/bin/activate"
if [ -f "$INSTALL_DIR/requirements.txt" ]; then
    pip install --upgrade pip -q
    pip install -r "$INSTALL_DIR/requirements.txt" -q
else
    echo -e "${YELLOW}[!] requirements.txt 不存在，手动安装依赖...${NC}"
    pip install --upgrade pip -q
    pip install mcp>=1.0.0 httpx>=0.25.0 -q
fi
deactivate

echo -e "${GREEN}[OK] 虚拟环境: $VENV_DIR${NC}"

# ========== 4. 配置 MCP ==========
echo ""
echo "[4/5] 配置 MCP Server..."

MCP_CONFIG_DIR="$HOME/.codeium/windsurf"
MCP_CONFIG_FILE="$MCP_CONFIG_DIR/mcp_config.json"

mkdir -p "$MCP_CONFIG_DIR"

# 询问是否配置远程浏览器调试
echo ""
echo "=========================================="
echo "  浏览器 MCP 配置 (远程 Chrome 调试)"
echo "=========================================="
echo ""
echo "是否通过 SSH 远程开发并需要连接 Windows 本地 Chrome?"
echo "  1) 是 - 配置 Chrome 远程调试"
echo "  2) 否 - 跳过浏览器 MCP 配置"
echo ""
read -p "请选择 [1/2]: " REMOTE_MODE

WINDOWS_IP=""
if [ "$REMOTE_MODE" = "1" ]; then
    echo ""
    echo "请在 Windows 上运行 start-chrome-debug.bat"
    echo "脚本会显示你的 IP 地址"
    echo ""
    read -p "请输入 Windows 电脑的 IP 地址: " WINDOWS_IP
    echo ""
    if [ -z "$WINDOWS_IP" ]; then
        echo -e "${YELLOW}[!] 未输入 IP，跳过浏览器 MCP 配置${NC}"
    else
        echo -e "${GREEN}[OK] Windows IP: $WINDOWS_IP${NC}"
        echo -e "${GREEN}[OK] Chrome 调试端口: 9222${NC}"
    fi
fi

# 生成 MCP 配置
if [ "$INSTALL_ALL" = "1" ]; then
    # 安装所有 MCP 服务
    echo -e "${GREEN}[安装] 所有 MCP 服务...${NC}"
    if [ -n "$WINDOWS_IP" ]; then
        cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "ask-continue": {
      "command": "$VENV_DIR/bin/python",
      "args": ["$INSTALL_DIR/server.py"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "env": {
        "CHROME_CDP_URL": "ws://$WINDOWS_IP:9222"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HOME"]
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
}
EOF
    else
        cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "ask-continue": {
      "command": "$VENV_DIR/bin/python",
      "args": ["$INSTALL_DIR/server.py"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HOME"]
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
}
EOF
    fi
    echo -e "${GREEN}[OK] 已配置所有 MCP 服务${NC}"
elif [ -n "$WINDOWS_IP" ]; then
    # 包含 Chrome MCP 的配置
    cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "ask-continue": {
      "command": "$VENV_DIR/bin/python",
      "args": ["$INSTALL_DIR/server.py"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"],
      "env": {
        "CHROME_CDP_URL": "ws://$WINDOWS_IP:9222"
      }
    }
  }
}
EOF
    echo -e "${GREEN}[OK] MCP 配置 (Chrome:9222): $MCP_CONFIG_FILE${NC}"
else
    # 仅 ask-continue + chrome-devtools 配置
    cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "ask-continue": {
      "command": "$VENV_DIR/bin/python",
      "args": ["$INSTALL_DIR/server.py"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"]
    }
  }
}
EOF
    echo -e "${GREEN}[OK] MCP 配置: $MCP_CONFIG_FILE${NC}"
fi

# ========== 5. 安装规则 ==========
echo ""
echo "[5/5] 安装规则..."

RULES_SRC="$SCRIPT_DIR/rules/example-windsurfrules.txt"
RULES_DST="$HOME/.windsurfrules"

if [ -f "$RULES_SRC" ]; then
    if [ -f "$RULES_DST" ]; then
        cp "$RULES_DST" "$RULES_DST.bak"
        echo -e "${YELLOW}[!] 已备份原规则到 $RULES_DST.bak${NC}"
    fi
    cp "$RULES_SRC" "$RULES_DST"
    echo -e "${GREEN}[OK] 规则已安装${NC}"
fi

# ========== 完成 ==========
echo ""
echo "========================================"
echo -e "${GREEN}   ✅ 环境配置完成！${NC}"
echo "========================================"
echo ""
echo "   接下来请手动安装 VSIX 扩展:"
echo ""
echo "   1. 打开 Windsurf"
echo "   2. 按 Ctrl+Shift+P"
echo "   3. 输入: Install from VSIX"
echo "   4. 选择: $SCRIPT_DIR/windsurf-ask-continue-1.1.0.vsix"
echo "   5. 重启 Windsurf"
echo ""
echo "========================================"
echo -e "${GREEN}   安装完成！重启 Windsurf 即可使用${NC}"
echo "========================================"
