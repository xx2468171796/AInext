# 牛马模式 (niuma-mode) 技术教学文档

> 本文档详细解析 VSCode 扩展「牛马模式」的完整技术实现，适合用于学习 VSCode 扩展开发、MCP 协议实现、Webview UI 开发等技术。

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈总览](#2-技术栈总览)
3. [VSCode 扩展基础](#3-vscode-扩展基础)
4. [项目架构](#4-项目架构)
5. [MCP 协议实现](#5-mcp-协议实现)
6. [弹窗系统](#6-弹窗系统)
7. [授权验证系统](#7-授权验证系统)
8. [Webview UI 开发](#8-webview-ui-开发)
9. [文件系统操作](#9-文件系统操作)
10. [后台 API 通信](#10-后台-api-通信)
11. [跨平台兼容](#11-跨平台兼容)
12. [打包与发布](#12-打包与发布)

---

## 1. 项目概述

### 1.1 功能定位
牛马模式是一个 AI 编程助手的「持久输出控制器」。核心功能：
- 当 AI 想结束对话时，弹出确认窗口
- 用户可以选择「继续」并提供反馈，或「结束」对话
- 实现「AI 持续工作直到用户满意」的交互模式

### 1.2 工作原理
```
AI IDE (Windsurf/Cursor) ──MCP协议──▶ 牛马扩展 ──弹窗──▶ 用户
                         ◀──反馈────                ◀──选择──
```

---

## 2. 技术栈总览

| 层级 | 技术 | 用途 |
|------|------|------|
| **运行时** | Node.js | VSCode 扩展宿主环境 |
| **语言** | JavaScript (ES6+) | 无 TypeScript，保持简洁 |
| **协议** | MCP (Model Context Protocol) | AI IDE 与扩展的通信标准 |
| **传输** | HTTP + SSE | MCP 协议的传输层 |
| **UI** | VSCode Webview | 侧边栏面板和弹窗 |
| **存储** | 文件系统 | 配置、统计、历史记录 |
| **打包** | VSIX | VSCode 扩展分发格式 |

---

## 3. VSCode 扩展基础

### 3.1 扩展入口 (package.json)

```json
{
  "name": "niuma-mode",
  "main": "./extension.js",           // 入口文件
  "activationEvents": ["onStartupFinished"],  // 启动后激活
  "contributes": {
    "viewsContainers": {              // 侧边栏容器
      "activitybar": [{
        "id": "niuma-panel",
        "title": "牛马模式",
        "icon": "icon.svg"
      }]
    },
    "views": {                        // Webview 面板
      "niuma-panel": [{
        "type": "webview",
        "id": "niuma.mainPanel",
        "name": "控制面板"
      }]
    }
  }
}
```

### 3.2 激活与停用

```javascript
// 扩展激活入口
function activate(context) {
  console.log("[牛马模式] 扩展开始激活");
  
  // 创建主控制器
  const panel = new NiumaPanel(context);
  
  // 注册 Webview Provider
  const provider = vscode.window.registerWebviewViewProvider(
    "niuma.mainPanel",  // 对应 package.json 中的 id
    panel,
    { webviewOptions: { retainContextWhenHidden: true } }
  );
  
  // 注册到上下文，自动清理
  context.subscriptions.push(provider);
  
  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand("niuma.showPanel", () => {
      vscode.commands.executeCommand("workbench.view.extension.niuma-panel");
    })
  );
}

// 扩展停用
function deactivate() {
  console.log("[牛马模式] 扩展已停用");
}

module.exports = { activate, deactivate };
```

### 3.3 WebviewViewProvider 接口

```javascript
class NiumaPanel {
  // 必须实现此方法，VSCode 会在需要显示面板时调用
  resolveWebviewView(webviewView) {
    this._view = webviewView;
    
    // 配置 Webview
    webviewView.webview.options = {
      enableScripts: true,  // 允许执行 JS
      localResourceRoots: [this._context.extensionUri]
    };
    
    // 设置 HTML 内容
    webviewView.webview.html = this._getHtml();
    
    // 监听来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "init":
          await this._loadUserData();
          break;
        case "activateCDK":
          await this._activateCDK(message.cdk);
          break;
        // ... 更多消息处理
      }
    });
  }
}
```

---

## 4. 项目架构

### 4.1 单类控制器模式

整个扩展的逻辑集中在 `NiumaPanel` 类中：

```javascript
class NiumaPanel {
  constructor(context) {
    // ===== 基础属性 =====
    this._context = context;      // VSCode 扩展上下文
    this._view = null;            // Webview 视图引用
    
    // ===== 授权相关 =====
    this._cdk = null;             // CDK 激活码
    this._userData = null;        // 用户数据
    this._apiUrl = API_BASE;      // 后台 API 地址
    
    // ===== MCP Server =====
    this._mcpServer = null;       // HTTP Server 实例
    this._mcpPort = 3457;         // 当前端口
    this._sessions = new Map();   // 会话存储
    this._sseConnections = new Map();  // SSE 连接
    
    // ===== 弹窗相关 =====
    this._dialogPanel = null;     // 当前弹窗面板
    
    // ===== 统计相关 =====
    this._stats = { totalCalls: 0, continueCount: 0, ... };
    this._currentSessionCalls = 0;
    
    // ===== 历史记录 =====
    this._historyDir = this._getProjectHistoryDir();
    this._historyEnabled = true;
  }
}
```

### 4.2 模块职责划分

```
NiumaPanel
├── MCP Server 模块
│   ├── startMcpServer()        // 启动 HTTP Server
│   ├── _handleMcpRequest()     // 路由请求
│   ├── _handleSseStream()      // SSE 长连接
│   └── _handleJsonRpc()        // JSON-RPC 处理
│
├── 弹窗模块
│   ├── _collectFeedback()      // 显示弹窗，等待用户
│   ├── _getFeedbackWebviewHtml()  // 生成弹窗 HTML
│   └── _formatFeedbackResult() // 格式化反馈结果
│
├── 授权模块
│   ├── _verifyCDK()            // 验证 CDK
│   ├── _activateCDK()          // 激活 CDK
│   ├── _getDeviceId()          // 生成设备指纹
│   └── _logout()               // 登出
│
├── UI 模块
│   ├── resolveWebviewView()    // 侧边栏面板
│   ├── _getHtml()              // 侧边栏 HTML
│   ├── _sendToWebview()        // 发送消息到 Webview
│   └── _showMessage()          // Toast 提示
│
├── 存储模块
│   ├── _loadStats()/_saveStats()      // 统计数据
│   ├── _saveInteraction()             // 历史记录
│   └── _getHistoryFiles()             // 历史列表
│
└── 工具模块
    ├── _ensureWindsurfRules()  // 自动创建规则文件
    ├── _playNotificationSound() // 播放提示音
    └── _detectCurrentIde()      // 检测当前 IDE
```

---

## 5. MCP 协议实现

### 5.1 什么是 MCP

MCP (Model Context Protocol) 是 AI IDE 与工具之间的通信协议：
- 基于 JSON-RPC 2.0
- 支持 HTTP 请求/响应 和 SSE 事件流
- 定义了 `tools/list` 和 `tools/call` 等标准方法

### 5.2 启动 HTTP Server

```javascript
startMcpServer(port = null) {
  return new Promise((resolve, reject) => {
    // 如果没指定端口，根据项目名生成固定端口
    if (port === null) {
      port = this._getProjectPort();  // 3457-3557 范围
    }
    
    // 创建 HTTP Server
    this._mcpServer = http.createServer((req, res) => {
      this._handleMcpRequest(req, res);
    });
    
    // 配置长连接
    this._mcpServer.timeout = 0;
    this._mcpServer.keepAliveTimeout = 120000;
    
    // 监听端口
    this._mcpServer.listen(port, '127.0.0.1', () => {
      this._mcpPort = port;
      console.log(`[牛马模式] MCP Server 已启动，端口: ${port}`);
      resolve(port);
    });
    
    // 端口冲突时自动递增
    this._mcpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.startMcpServer(port + 1).then(resolve).catch(reject);
      }
    });
  });
}
```

### 5.3 请求路由

```javascript
async _handleMcpRequest(req, res) {
  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;
  
  // MCP 端点
  if (pathname === '/' || pathname === '/mcp') {
    if (req.method === 'GET') {
      // SSE 长连接 - AI IDE 用此保持连接
      this._handleSseStream(req, res);
    } else if (req.method === 'POST') {
      // JSON-RPC 请求 - 实际的工具调用
      await this._handleJsonRpc(req, res);
    }
  }
  
  // 健康检查
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: this._mcpPort }));
  }
}
```

### 5.4 SSE 长连接

```javascript
_handleSseStream(req, res) {
  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  // 生成会话 ID
  const sessionId = crypto.randomBytes(16).toString('hex');
  this._sessions.set(sessionId, { createdAt: Date.now() });
  this._sseConnections.set(sessionId, res);
  
  // 发送 endpoint 事件，告诉 AI IDE 后续请求的地址
  const endpointUrl = `/mcp?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
  
  // 心跳保活（每15秒）
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 15000);
  
  // 清理
  req.on('close', () => {
    clearInterval(keepAlive);
    this._sseConnections.delete(sessionId);
  });
}
```

### 5.5 JSON-RPC 处理

```javascript
async _handleJsonRpc(req, res) {
  // 读取请求体
  let body = '';
  req.on('data', chunk => body += chunk);
  await new Promise(resolve => req.on('end', resolve));
  
  const msg = JSON.parse(body);
  const method = msg.method;
  const id = msg.id;
  
  // ===== initialize =====
  // AI IDE 首次连接时调用
  if (method === 'initialize') {
    const result = {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'infinite-dialog', version: '2.0.0' }
    };
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }
  
  // ===== tools/list =====
  // AI IDE 查询可用工具
  if (method === 'tools/list') {
    const result = {
      tools: [{
        name: 'niuma_feedback',
        description: '每次回复结束前必须调用此工具...',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '工作摘要' },
            project_directory: { type: 'string' },
            timeout: { type: 'number', default: 31536000 }
          }
        }
      }]
    };
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }
  
  // ===== tools/call =====
  // AI IDE 调用工具
  if (method === 'tools/call') {
    const toolName = msg.params.name;
    const args = msg.params.arguments || {};
    
    if (toolName === 'niuma_feedback') {
      // 显示弹窗并等待用户响应
      const feedbackResult = await this._collectFeedback(args.summary);
      
      // 返回结果给 AI
      const result = {
        content: [{ type: 'text', text: this._formatFeedbackResult(feedbackResult) }]
      };
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
  }
}
```

### 5.6 MCP 配置自动写入

```javascript
_saveMcpConfig() {
  // 检测当前 IDE
  const currentIde = this._detectCurrentIde();
  const configPath = currentIde.configPath;
  // Windsurf: ~/.codeium/windsurf/mcp_config.json
  // Cursor:   ~/.cursor/mcp.json
  
  // 读取现有配置
  let config = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  
  // 添加牛马模式配置
  config.mcpServers['niuma'] = {
    url: `http://127.0.0.1:${this._mcpPort}`
  };
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
```

---

## 6. 弹窗系统

### 6.1 弹窗触发流程

```
AI 调用 tools/call
      ↓
_handleJsonRpc() 处理
      ↓
_collectFeedback() 显示弹窗
      ↓
创建 WebviewPanel
      ↓
用户选择「继续」或「结束」
      ↓
Promise resolve 返回结果
      ↓
_formatFeedbackResult() 格式化
      ↓
返回给 AI IDE
```

### 6.2 弹窗实现

```javascript
async _collectFeedback(summary, callCount = 1) {
  return new Promise((resolve) => {
    // 关闭已存在的弹窗
    if (this._dialogPanel) {
      this._dialogPanel.dispose();
    }
    
    // 创建 WebviewPanel（独立窗口）
    const panel = vscode.window.createWebviewPanel(
      'niumaFeedback',                    // 类型标识
      `🐴 牛马模式 (第${callCount}次)`,   // 标题
      vscode.ViewColumn.One,              // 显示位置
      { enableScripts: true, retainContextWhenHidden: true }
    );
    
    this._dialogPanel = panel;
    panel.webview.html = this._getFeedbackWebviewHtml(summary, callCount);
    
    // 播放提示音
    this._playNotificationSound();
    
    // 显示状态栏提醒
    const statusBarItem = vscode.window.createStatusBarItem();
    statusBarItem.text = "$(bell) 🐴 AI想结束了，请查看弹窗！";
    statusBarItem.show();
    
    // 监听 Webview 消息
    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'submit') {
        const result = {
          feedback: message.feedback || '',
          action: message.action || 'continue',  // 'continue' 或 'end'
          images: message.images || []
        };
        
        statusBarItem.dispose();
        panel.dispose();
        resolve(result);
      }
    });
    
    // 用户关闭弹窗 = 继续
    panel.onDidDispose(() => {
      statusBarItem.dispose();
      resolve({ feedback: '', action: 'continue', images: [] });
    });
  });
}
```

### 6.3 弹窗 HTML 结构

```javascript
_getFeedbackWebviewHtml(summary, callCount) {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    /* 深色主题样式 */
    body { background: linear-gradient(135deg, #0a0b0e, #10121a); }
    .container { max-width: 800px; margin: 0 auto; }
    .header { /* AI 摘要显示区 */ }
    .panel { /* 反馈输入区 */ }
    .btn-continue { /* 绿色继续按钮 */ }
    .btn-end { /* 红色结束按钮 */ }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="summary">${summary}</div>
    </div>
    
    <div class="panel">
      <textarea id="feedback" placeholder="输入反馈..."></textarea>
      <input type="file" id="fileInput" accept="image/*" multiple>
      
      <div class="main-actions">
        <button class="btn-continue" id="btnContinue">✅ 继续</button>
        <button class="btn-end" id="btnEnd">🛑 结束</button>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();  // 获取 VSCode API
    
    function submit(action) {
      vscode.postMessage({
        type: 'submit',
        action: action,
        feedback: document.getElementById('feedback').value,
        images: uploadedImages
      });
    }
    
    // 按钮点击
    document.getElementById('btnContinue').onclick = () => submit('continue');
    document.getElementById('btnEnd').onclick = () => submit('end');
    
    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') submit('continue');
      if (e.key === 'Escape') submit('end');
    });
  </script>
</body>
</html>`;
}
```

### 6.4 反馈结果格式化

```javascript
_formatFeedbackResult(result) {
  let text = '## 用户反馈\n\n';
  
  if (result.action === 'continue') {
    text += '**用户选择**: ✅ 继续\n\n';
    if (result.feedback) {
      text += `**反馈内容**:\n${result.feedback}\n\n`;
    }
    // 强制 AI 继续调用工具
    text += `\n---\n## ⚠️ MANDATORY NEXT STEP\n`;
    text += `**You MUST call \`niuma_feedback\` again after processing this feedback.**\n`;
  } else {
    text += '**用户选择**: 🛑 结束\n\n';
    text += `\n---\n## 🛑 CONVERSATION ENDED\n`;
    text += `**User wants to end.** Stop immediately.\n`;
  }
  
  return text;
}
```

---

## 7. 授权验证系统

### 7.1 设备指纹生成

```javascript
_getDeviceId() {
  const { execSync } = require('child_process');
  let machineId = '';
  
  if (process.platform === 'win32') {
    // Windows: 读取注册表 MachineGuid
    const cmd = `powershell -Command "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid"`;
    machineId = execSync(cmd, { encoding: 'utf8' }).trim();
  } else if (process.platform === 'darwin') {
    // macOS: 读取 IOPlatformUUID
    const output = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID');
    machineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  } else {
    // Linux: 读取 /etc/machine-id
    machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  }
  
  // SHA256 哈希，取前32位
  const hash = crypto.createHash('sha256').update(machineId).digest('hex');
  return hash.substring(0, 32);
}
```

### 7.2 CDK 验证流程

```javascript
async _verifyCDK(cdk) {
  return new Promise((resolve) => {
    const deviceId = this._getDeviceId();
    const postData = JSON.stringify({ cdk, device_id: deviceId });
    
    const options = {
      hostname: 'ggg.windsurfaa.top',
      port: 80,
      path: '/api/activate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.success) {
          resolve({ valid: true, data: result.user });
        } else {
          resolve({ valid: false, error: result.message });
        }
      });
    });
    
    req.write(postData);
    req.end();
  });
}
```

### 7.3 激活与登出

```javascript
// 激活 CDK
async _activateCDK(cdk) {
  const result = await this._verifyCDK(cdk.trim());
  
  if (result.valid) {
    // 保存 CDK 到本地文件
    const cdkFile = path.join(os.homedir(), '.niuma-mcp', 'cdk.txt');
    fs.writeFileSync(cdkFile, cdk.trim());
    
    this._cdk = cdk.trim();
    this._userData = result.data;
    
    // 更新 UI
    this._sendToWebview('updateData', {
      loggedIn: true,
      user: this._userData,
      expireTime: this._userData?.expire_time
    });
  }
}

// 登出
async _logout() {
  const cdkFile = path.join(os.homedir(), '.niuma-mcp', 'cdk.txt');
  if (fs.existsSync(cdkFile)) {
    fs.unlinkSync(cdkFile);
  }
  
  this._cdk = null;
  this._userData = null;
  
  this._sendToWebview('updateData', { loggedIn: false });
}
```

---

## 8. Webview UI 开发

### 8.1 Webview 通信机制

```
┌──────────────────┐              ┌──────────────────┐
│    Extension     │              │     Webview      │
│   (Node.js)      │              │   (Browser)      │
├──────────────────┤              ├──────────────────┤
│                  │  postMessage │                  │
│ webview.postMsg ─┼─────────────▶│ window.message   │
│ (消息到 Webview)  │              │ (接收消息)        │
│                  │              │                  │
│ onDidReceiveMsg ◀┼──────────────┼─ vscode.postMsg  │
│ (接收消息)        │  postMessage │ (消息到扩展)      │
└──────────────────┘              └──────────────────┘
```

### 8.2 Extension 端发送消息

```javascript
// 发送消息到 Webview
_sendToWebview(type, data) {
  if (this._view && this._view.webview) {
    this._view.webview.postMessage({ type, ...data });
  }
}

// 示例：更新统计
_updateSidebarStats() {
  this._sendToWebview({
    type: 'updateStats',
    stats: {
      totalCalls: this._stats.totalCalls,
      continueCount: this._stats.continueCount,
      currentSessionCalls: this._currentSessionCalls
    }
  });
}
```

### 8.3 Webview 端接收消息

```javascript
// webview.html 中的 JS
window.addEventListener('message', (event) => {
  const message = event.data;
  
  switch (message.type) {
    case 'updateData':
      updateUI(message);
      break;
    case 'showToast':
      showToast(message.message, message.toastType);
      break;
    case 'updateStats':
      updateStats(message.stats);
      break;
  }
});
```

### 8.4 Webview 端发送消息

```javascript
// 获取 VSCode API（只能调用一次）
const vscode = acquireVsCodeApi();

// 发送消息到扩展
function activateCDK() {
  const cdk = document.getElementById('cdkInput').value;
  vscode.postMessage({ type: 'activateCDK', cdk: cdk });
}

function toggleNiuma() {
  const enabled = document.getElementById('niumaToggle').checked;
  vscode.postMessage({ type: 'toggleNiuma', enabled: enabled });
}
```

---

## 9. 文件系统操作

### 9.1 本地存储目录

```
~/.niuma-mcp/
├── cdk.txt              # CDK 激活码
├── enabled.txt          # 开关状态 (1/0)
├── stats.json           # 统计数据
├── history_enabled.txt  # 历史存储开关
├── .installed           # 首次安装标记
├── dialog_request.json  # 弹窗请求（跨进程通信）
├── dialog_response.json # 弹窗响应
├── images/              # 上传的图片
└── history/
    └── [project-name]/
        ├── 2026-01-09.md
        └── 2026-01-08.md
```

### 9.2 统计数据持久化

```javascript
// 加载统计
_loadStats() {
  const statsFile = path.join(os.homedir(), '.niuma-mcp', 'stats.json');
  if (fs.existsSync(statsFile)) {
    this._stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  }
}

// 保存统计
_saveStats() {
  const dir = path.join(os.homedir(), '.niuma-mcp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dir, 'stats.json'),
    JSON.stringify(this._stats, null, 2)
  );
}
```

### 9.3 历史记录存储

```javascript
// 按项目分目录存储
_getProjectHistoryDir() {
  const projectName = this._getProjectName();  // 从 workspace 获取
  const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_');
  return path.join(os.homedir(), '.niuma-mcp', 'history', safeName);
}

// 保存交互记录
_saveInteraction(round, summary, feedback, action) {
  const filePath = this._getTodayHistoryFile();  // 按日期分文件
  
  let content = '';
  if (!fs.existsSync(filePath)) {
    content = `# 牛马模式历史记录 - ${new Date().toLocaleDateString()}\n\n`;
  }
  
  content += `## 轮次 ${round}\n`;
  content += `- **AI摘要**: ${summary}\n`;
  content += `- **用户反馈**: ${feedback}\n`;
  content += `- **用户选择**: ${action === 'continue' ? '继续' : '结束'}\n\n`;
  
  fs.appendFileSync(filePath, content);
}
```

---

## 10. 后台 API 通信

### 10.1 API 概览

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/activate` | POST | CDK 激活与验证 |

### 10.2 请求格式

```javascript
// 请求
POST http://ggg.windsurfaa.top/api/activate
Content-Type: application/json

{
  "cdk": "XXXX-XXXX-XXXX-XXXX",
  "device_id": "a1b2c3d4..."  // 32位设备指纹
}

// 成功响应
{
  "success": true,
  "user": {
    "name": "用户名",
    "expire_time": "2026-12-31T23:59:59Z"
  }
}

// 失败响应
{
  "success": false,
  "message": "CDK 无效或已过期"
}
```

### 10.3 HTTP 请求封装

```javascript
// 使用 Node.js 原生 http 模块（无外部依赖）
async _verifyCDK(cdk) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ 
      cdk, 
      device_id: this._getDeviceId() 
    });
    
    const urlObj = new URL(this._apiUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: '/api/activate',
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.success 
            ? { valid: true, data: result.user }
            : { valid: false, error: result.message }
          );
        } catch {
          resolve({ valid: false, error: '响应解析失败' });
        }
      });
    });
    
    req.on('error', err => {
      resolve({ valid: false, error: err.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: '请求超时' });
    });
    
    req.write(postData);
    req.end();
  });
}
```

---

## 11. 跨平台兼容

### 11.1 平台检测

```javascript
const platform = process.platform;
// 'win32'  - Windows
// 'darwin' - macOS
// 'linux'  - Linux
```

### 11.2 路径处理

```javascript
// 使用 path.join() 自动处理分隔符
const configDir = path.join(os.homedir(), '.niuma-mcp');

// 避免硬编码路径分隔符
// ❌ '~/.niuma-mcp/config.json'
// ✅ path.join(os.homedir(), '.niuma-mcp', 'config.json')
```

### 11.3 提示音

```javascript
_playNotificationSound() {
  if (process.platform === 'win32') {
    // Windows: 使用 PowerShell 播放系统声音
    exec(`powershell -c "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify.wav').PlaySync()"`);
  } else if (process.platform === 'darwin') {
    // macOS: 使用 afplay
    exec('afplay /System/Library/Sounds/Glass.aiff');
  }
  // Linux: 无默认实现
}
```

### 11.4 IDE 配置路径

```javascript
const IDE_CONFIGS = [
  { 
    name: 'Windsurf', 
    configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json') 
  },
  { 
    name: 'Cursor', 
    configPath: path.join(HOME, '.cursor', 'mcp.json') 
  },
  { 
    name: 'Kiro', 
    configPath: path.join(HOME, '.kiro', 'settings', 'mcp.json') 
  }
];
```

---

## 12. 打包与发布

### 12.1 VSIX 结构

```
niuma-mode-3.0.0.vsix (ZIP 格式)
├── [Content_Types].xml
├── extension.vsixmanifest
└── extension/
    ├── package.json
    ├── extension.js
    ├── webview.html
    ├── dialog.html
    ├── dialog-trigger.js
    ├── icon.png
    └── icon.svg
```

### 12.2 打包命令

```bash
# 安装 vsce 工具
npm install -g @vscode/vsce

# 打包（在扩展目录下）
vsce package

# 输出: niuma-mode-3.0.0.vsix
```

### 12.3 本地安装测试

```bash
# 方法1: 命令行
code --install-extension niuma-mode-3.0.0.vsix

# 方法2: VSCode UI
# Extensions → ... → Install from VSIX...
```

---

## 附录：关键代码位置索引

| 功能 | 文件 | 行号 |
|------|------|------|
| MCP Server 启动 | extension.js | 84-133 |
| JSON-RPC 处理 | extension.js | 351-586 |
| SSE 长连接 | extension.js | 302-348 |
| 弹窗收集 | extension.js | 610-690 |
| 弹窗 HTML | extension.js | 717-1037 |
| 设备指纹 | extension.js | 1807-1854 |
| CDK 验证 | extension.js | 1858-1903 |
| CDK 激活 | extension.js | 1907-1941 |
| 历史记录 | extension.js | 1468-1600 |
| 侧边栏 UI | webview.html | 1-566 |

---

## 总结

本文档详细解析了牛马模式的完整技术实现：

1. **VSCode 扩展开发**：package.json 配置、activate/deactivate、WebviewViewProvider
2. **MCP 协议**：HTTP Server、SSE 长连接、JSON-RPC 2.0
3. **弹窗系统**：WebviewPanel、双向消息通信
4. **授权验证**：设备指纹、API 验证、CDK 存储
5. **UI 开发**：Webview HTML/CSS/JS、消息传递
6. **文件存储**：统计、历史、配置持久化
7. **跨平台**：Windows/macOS/Linux 兼容

掌握这些技术后，你就可以开发自己的 VSCode 扩展，并实现类似的 AI 辅助工具。
