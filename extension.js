/**
 * Alone模式 - AI持久输出助手
 * 重构版 v3.0.0 - 免费开源版
 * 
 * 功能:
 * 1. 内置 MCP HTTP Server（无需外部 mcp-server.js）
 * 2. SSE 心跳保持连接
 * 3. 弹窗统计功能
 */

const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");

// 默认 MCP Server 端口
const DEFAULT_MCP_PORT = 3457;
const PORT_RANGE_START = 3457;
const PORT_RANGE_END = 3557;

// Alone模式面板
class NiumaPanel {
  constructor(context) {
    console.log("[Alone模式] 构造函数调用");
    this._context = context;
    this._view = null;
    this._dialogPanel = null;
    
    // MCP HTTP Server 相关
    this._mcpServer = null;
    this._mcpPort = DEFAULT_MCP_PORT;
    this._sessions = new Map();
    this._sseConnections = new Map();
    this._currentSessionId = null;
    this._toolName = 'niuma_feedback';
    
    // 弹窗统计
    this._statsFile = path.join(os.homedir(), '.alone-mcp', 'stats.json');
    this._stats = {
      totalCalls: 0,        // 累计总弹窗（持久化）
      continueCount: 0,     // 累计继续次数
      endCount: 0,          // 累计结束次数
      sessionCount: 0,      // 累计会话数（窗口打开次数）
      lastCallTime: null
    };
    this._currentSessionCalls = 0;  // 本轮会话弹窗数（不持久化，窗口关闭时重置）
    this._sessionHistory = [];
    this._loadStats();  // 加载持久化统计
    
    // 窗口打开时，会话数 +1
    this._stats.sessionCount++;
    this._saveStats();
    
    // 上下文历史存储（按项目分开）
    this._historyBaseDir = path.join(os.homedir(), '.alone-mcp', 'history');
    this._historyDir = this._getProjectHistoryDir();
    this._projectName = this._getProjectName();
    this._currentSessionFile = null;
    this._historyEnabled = this._loadHistoryEnabled();
    this._ensureHistoryDir();
    
    // 输出通道
    this._output = vscode.window.createOutputChannel('Alone模式 MCP');
    
    // 快捷前缀和提示词库（从 ask-continue 移植）
    this._prefixList = [];
    this._promptCategories = [];
    this._promptItems = [];
    this._mcpLogs = [];
    this._toolsCollapsed = true;
    this._loadPrefixAndPromptData();
    
    // 自定义提示音
    this._customSoundFile = null;
    this._loadCustomSound();
    
    // AI 优化提示词配置
    this._aiOptimizerConfig = {
      platform: 'zhipu',  // siliconflow, zhipu, openai
      apiKey: '',
      apiUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      model: 'GLM-4.7',  // 默认使用付费模型
      enabled: false,
      customPrompt: '',  // 用户自定义预设提示词
      thinkingMode: false,  // 默认关闭思考模式以加速
      maxTokens: 1000  // 默认 1000 tokens
    };
    this._loadAiOptimizerConfig();
    
    // 自动创建 .windsurfrules 文件
    this._ensureWindsurfRules();
    
    // 文件监听 - 监听弹窗请求（工作区隔离）
    this._workspaceId = this._getWorkspaceId();
    this._dialogRequestFile = path.join(os.homedir(), '.alone-mcp', `dialog_request_${this._workspaceId}.json`);
    this._dialogResponseFile = path.join(os.homedir(), '.alone-mcp', `dialog_response_${this._workspaceId}.json`);
    // 同时监听全局请求文件（兼容旧版本）
    this._globalDialogRequestFile = path.join(os.homedir(), '.alone-mcp', 'dialog_request.json');
    this._globalDialogResponseFile = path.join(os.homedir(), '.alone-mcp', 'dialog_response.json');
    this._startDialogWatcher();
    
    console.log("[Alone模式] 扩展初始化完成");
  }

  // ==================== MCP HTTP Server（内置） ====================
  
  // 启动 MCP HTTP Server（使用项目绑定端口）
  startMcpServer(port = null) {
    // 如果没有指定端口，使用项目绑定的端口
    if (port === null) {
      port = this._getProjectPort();
    }
    return new Promise((resolve, reject) => {
      if (this._mcpServer) {
        resolve(this._mcpPort);
        return;
      }
      
      this._mcpServer = http.createServer((req, res) => {
        this._handleMcpRequest(req, res).catch((err) => {
          console.error('[Alone模式] MCP 请求错误:', err);
          try {
            if (!res.headersSent) {
              res.writeHead(500);
              res.end('Internal Server Error');
            }
          } catch {}
        });
      });
      
      // 禁用超时，保持长连接
      this._mcpServer.timeout = 0;
      this._mcpServer.keepAliveTimeout = 120000;
      
      this._mcpServer.listen(port, '127.0.0.1', () => {
        this._mcpPort = port;
        this._toolName = 'niuma_feedback';
        const msg = `[Alone模式] MCP Server 已启动，端口: ${port}, 工具名: ${this._toolName}`;
        console.log(msg);
        this._output.appendLine(msg);
        this._saveMcpConfig();
        resolve(port);
      });
      
      this._mcpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this._mcpServer?.close();
          this._mcpServer = null;
          console.log(`[Alone模式] 端口 ${port} 被占用，尝试 ${port + 1}`);
          this.startMcpServer(port + 1).then(resolve).catch(reject);
        } else {
          console.error('[Alone模式] MCP Server 错误:', err);
          reject(err);
        }
      });
    });
  }
  
  // 自动检测当前 IDE
  _detectCurrentIde() {
    const HOME = os.homedir();
    const IDE_CONFIGS = [
      { name: 'Windsurf', appNames: ['Windsurf', 'windsurf'], configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json') },
      { name: 'Cursor', appNames: ['Cursor', 'cursor'], configPath: path.join(HOME, '.cursor', 'mcp.json') },
      { name: 'Kiro', appNames: ['Kiro', 'kiro'], configPath: path.join(HOME, '.kiro', 'settings', 'mcp.json') },
      { name: 'Trae', appNames: ['Trae', 'trae'], configPath: path.join(HOME, '.trae', 'mcp.json') },
    ];
    
    const appName = vscode.env.appName || '';
    for (const ide of IDE_CONFIGS) {
      if (ide.appNames.some(n => appName.toLowerCase().includes(n.toLowerCase()))) {
        return ide;
      }
    }
    // 默认返回 Windsurf
    return IDE_CONFIGS[0];
  }
  
  // 自动保存 MCP 配置（扩展激活时自动执行）
  _saveMcpConfig() {
    try {
      const currentIde = this._detectCurrentIde();
      const configPath = currentIde.configPath;
      
      // 确保目录存在
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      let config = { mcpServers: {} };
      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (!config.mcpServers) config.mcpServers = {};
        } catch {}
      }
      
      // 清理旧的牛马配置
      for (const key of Object.keys(config.mcpServers)) {
        if (key.startsWith('niuma')) {
          delete config.mcpServers[key];
        }
      }
      
      // 使用固定名称 niuma
      config.mcpServers['niuma'] = {
        url: `http://127.0.0.1:${this._mcpPort}`
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`[Alone模式] MCP 配置已自动保存到 ${currentIde.name}: ${configPath}`);
      this._output.appendLine(`[MCP] 配置已自动写入 ${currentIde.name}`);
      
      // 首次安装时提示重启
      this._checkFirstInstall();
    } catch (e) {
      console.error('[Alone模式] 自动保存 MCP 配置失败:', e);
    }
  }
  
  // 检查是否首次安装
  _checkFirstInstall() {
    const niumaDir = path.join(os.homedir(), '.alone-mcp');
    const installFlag = path.join(niumaDir, '.installed');
    
    if (!fs.existsSync(niumaDir)) {
      fs.mkdirSync(niumaDir, { recursive: true });
    }
    
    if (!fs.existsSync(installFlag)) {
      // 首次安装，提示重启
      fs.writeFileSync(installFlag, Date.now().toString(), 'utf8');
      vscode.window.showInformationMessage(
        '🐴 Alone模式已自动配置完成！首次使用需要重启 IDE 使配置生效。',
        '立即重启'
      ).then(selection => {
        if (selection === '立即重启') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    }
  }
  
  // 兼容旧版：保留手动配置入口
  _saveMcpConfigLegacy() {
    try {
      const configPaths = [
        path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
        path.join(process.env.APPDATA || '', 'Windsurf', 'User', 'globalStorage', 'codeium.windsurf', 'mcp_config.json')
      ];
      
      for (const configPath of configPaths) {
        try {
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          
          let config = { mcpServers: {} };
          if (fs.existsSync(configPath)) {
            try {
              config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              if (!config.mcpServers) config.mcpServers = {};
            } catch {}
          }
          
          config.mcpServers[`infinite-dialog-${this._mcpPort}`] = {
            url: `http://127.0.0.1:${this._mcpPort}`
          };
          
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
          console.log(`[Alone模式] MCP 配置已保存: ${configPath}`);
        } catch (e) {
          console.log(`[Alone模式] 保存配置失败: ${configPath}`, e.message);
        }
      }
    } catch (e) {
      console.error('[Alone模式] 保存 MCP 配置失败:', e);
    }
  }
  
  // 处理 MCP HTTP 请求
  async _handleMcpRequest(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Session-Id');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname || '/';
    
    // MCP 端点
    if (pathname === '/' || pathname === '/mcp') {
      if (req.method === 'GET') {
        this._handleSseStream(req, res);
        return;
      }
      if (req.method === 'POST') {
        await this._handleJsonRpc(req, res);
        return;
      }
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    
    // 健康检查
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this._mcpPort }));
      return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
  }
  
  // 处理 SSE 流（保持连接）
  _handleSseStream(req, res) {
    console.log('[Alone模式] SSE 连接请求');
    this._output.appendLine('[MCP] SSE 连接请求');
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    
    const sessionId = crypto.randomBytes(16).toString('hex');
    this._sessions.set(sessionId, { createdAt: Date.now(), callCount: 0 });
    this._sseConnections.set(sessionId, res);
    
    // 注意：会话计数在新对话开始时增加，不在 SSE 连接时增加
    // 避免重复计数
    
    const endpointUrl = `/mcp?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
    console.log(`[Alone模式] SSE 已连接, endpoint: ${endpointUrl}`);
    
    // 心跳保持连接（每15秒）
    const keepAlive = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);
    
    req.on('close', () => {
      clearInterval(keepAlive);
      this._sseConnections.delete(sessionId);
      setTimeout(() => {
        if (this._sessions.has(sessionId) && !this._sseConnections.has(sessionId)) {
          this._sessions.delete(sessionId);
        }
      }, 60000);
      console.log(`[Alone模式] SSE 连接关闭: ${sessionId}`);
    });
  }
  
  // 处理 JSON-RPC 请求
  async _handleJsonRpc(req, res) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    await new Promise(resolve => req.on('end', resolve));
    
    let msg;
    try {
      msg = body ? JSON.parse(body) : null;
    } catch {
      this._sendJsonRpcError(res, null, -32700, 'Parse error');
      return;
    }
    
    if (!msg || msg.jsonrpc !== '2.0') {
      this._sendJsonRpcError(res, msg?.id ?? null, -32600, 'Invalid Request');
      return;
    }
    
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const sessionId = url.searchParams.get('sessionId') || req.headers['mcp-session-id'];
    const method = msg.method;
    const id = msg.id;
    
    this._output.appendLine(`[MCP] ${method}`);
    
    // initialize
    if (method === 'initialize') {
      const newSessionId = sessionId || crypto.randomBytes(16).toString('hex');
      if (!this._sessions.has(newSessionId)) {
        this._sessions.set(newSessionId, { createdAt: Date.now(), callCount: 0 });
      }
      this._currentSessionId = newSessionId;
      
      const result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'infinite-dialog',
          version: '2.0.0',
        },
      };
      
      const response = { jsonrpc: '2.0', id, result };
      if (sessionId && this._sendSseMessage(sessionId, response)) {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'MCP-Session-Id': newSessionId,
        });
        res.end(JSON.stringify(response));
      }
      return;
    }
    
    // notifications/initialized
    if (method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    
    // tools/list
    if (method === 'tools/list') {
      const result = {
        tools: [
          {
            name: this._toolName,
            description: `【最高优先级规则 - 必须严格遵守】

⚠️⚠️⚠️ 无论任何情况，每次回复结束前必须调用此工具！没有任何例外！⚠️⚠️⚠️

核心规则：
完整输出 - 输出完整代码和答案，禁止使用省略号或"代码过长不展示"
持续执行 - 复杂任务尽量一次性完成，不要频繁中断或反复追问是否继续
结束确认 - 当你想结束对话或任务时，必须先调用此工具询问用户是否继续
严格遵守用户选择 - 当用户选择"结束对话"（返回 should_continue=False）时，必须立即停止所有操作

调用时机：
完成用户请求后
任务告一段落时
需要用户确认是否继续时
每次回复结束前

参数说明：
summary: AI想要结束对话的原因（必填）
project_directory: 当前工作区的绝对路径（可选）`,
            inputSchema: {
              type: 'object',
              properties: {
                project_directory: {
                  type: 'string',
                  description: 'Project directory path',
                  default: '.',
                },
                summary: {
                  type: 'string',
                  description: 'Summary of AI work completed',
                  default: 'I have completed the requested task.',
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in seconds',
                  default: 31536000,
                },
              },
            },
          },
        ],
      };
      
      const response = { jsonrpc: '2.0', id, result };
      if (sessionId && this._sendSseMessage(sessionId, response)) {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response));
      }
      return;
    }
    
    // tools/call
    if (method === 'tools/call') {
      const params = msg.params || {};
      const toolName = params.name;
      const args = params.arguments || {};
      
      this._output.appendLine(`[MCP] tools/call ${toolName}`);
      
      if (toolName !== this._toolName) {
        this._sendJsonRpcError(res, id ?? null, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      
      const summary = args.summary || 'AI has completed the task.';
      
      // 更新会话历史
      let currentCallCount = 1;
      if (this._currentSessionId && this._sessions.has(this._currentSessionId)) {
        const session = this._sessions.get(this._currentSessionId);
        session.callCount++;
        currentCallCount = session.callCount;
      }
      
      // 更新统计：总弹窗数 +1，本轮弹窗 +1
      this._stats.totalCalls++;
      this._stats.lastCallTime = Date.now();
      this._currentSessionCalls++;
      this._saveStats();
      this._updateSidebarStats();
      
      this._sessionHistory.push({
        round: currentCallCount,
        summary: summary,
        timestamp: Date.now()
      });
      
      // 显示反馈弹窗并等待用户响应
      const feedbackResult = await this._collectFeedback(summary, currentCallCount);
      
      // 更新统计
      if (feedbackResult.action === 'continue') {
        this._stats.continueCount++;
      } else {
        this._stats.endCount++;
        this._currentSessionCalls = 0;  // 结束时重置本轮计数
      }
      this._saveStats();
      
      // 保存交互历史
      this._saveInteraction(
        currentCallCount,
        summary,
        feedbackResult.feedback,
        feedbackResult.action,
        feedbackResult.images?.length || 0
      );
      
      // 通知侧边栏更新统计
      this._updateSidebarStats();
      
      // 构建响应
      const content = [
        {
          type: 'text',
          text: this._formatFeedbackResult(feedbackResult),
        },
      ];
      
      // 添加图片到响应
      if (feedbackResult.images && feedbackResult.images.length > 0) {
        for (const img of feedbackResult.images) {
          // 图片格式: data:image/png;base64,xxxxx
          const match = img.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            content.push({
              type: 'image',
              data: match[2],
              mimeType: `image/${match[1]}`
            });
          }
        }
        this._output.appendLine(`[MCP] 返回 ${feedbackResult.images.length} 张图片`);
      }
      
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          content,
          isError: false,
        },
      };
      
      if (sessionId && this._sendSseMessage(sessionId, response)) {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response));
      }
      return;
    }
    
    this._sendJsonRpcError(res, id ?? null, -32601, `Method not found: ${method}`);
  }
  
  // 发送 SSE 消息
  _sendSseMessage(sessionId, data) {
    const sseRes = this._sseConnections.get(sessionId);
    if (sseRes) {
      sseRes.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    }
    return false;
  }
  
  // 发送 JSON-RPC 错误
  _sendJsonRpcError(res, id, code, message) {
    const response = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(response));
  }
  
  // 收集用户反馈
  async _collectFeedback(summary, callCount = 1) {
    return new Promise((resolve) => {
      let resolved = false;
      
      // 关闭已存在的弹窗
      if (this._dialogPanel) {
        try { this._dialogPanel.dispose(); } catch {}
        this._dialogPanel = null;
      }
      
      try {
        this._output.appendLine('[MCP] 显示反馈弹窗');
        
        // 创建 WebviewPanel
        const panel = vscode.window.createWebviewPanel(
          'niumaFeedback',
          `🐴 Alone模式 (第${callCount}次)`,
          vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        
        this._dialogPanel = panel;
        panel.webview.html = this._getFeedbackWebviewHtml(summary, callCount);
        
        // 播放提示音
        this._playNotificationSound();
        
        // 显示状态栏提醒
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.text = "$(bell) 🐴 AI想结束了，请查看弹窗！";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.show();
        
        // 心跳机制：每30秒发送一次心跳，保持弹窗活跃
        const heartbeatInterval = setInterval(() => {
          if (panel && !resolved) {
            try {
              panel.webview.postMessage({ type: 'heartbeat', timestamp: Date.now() });
            } catch (e) {
              // 面板可能已关闭
            }
          }
        }, 30000);
        
        const messageDisposable = panel.webview.onDidReceiveMessage(async (message) => {
          if (message.type === 'submit' && !resolved) {
            resolved = true;
            
            const result = {
              feedback: message.feedback || '',
              action: message.action || 'continue',
              images: message.images || [],
              imageDesc: message.imageDesc || '',
            };
            
            clearInterval(heartbeatInterval);  // 清除心跳
            messageDisposable.dispose();
            statusBarItem.dispose();
            panel.dispose();
            this._dialogPanel = null;
            resolve(result);
          } else if (message.type === 'loadHistory') {
            // 加载历史内容并发送回弹窗
            const filePath = path.join(this._historyDir, `${message.name}.md`);
            const content = this._readHistoryFile(filePath);
            if (content) {
              panel.webview.postMessage({ type: 'historyContent', content: content });
            }
          } else if (message.type === 'deleteHistory') {
            // 删除单条历史记录
            this._deleteHistoryRound(message.file, message.round);
          } else if (message.type === 'clearAllHistory') {
            // 清空所有历史记录
            this._clearAllHistory();
          } else if (message.type === 'optimizePrompt') {
            // AI 优化提示词（支持动态模型、思考模式和 maxTokens）
            const result = await this._optimizePrompt(message.content, message.model, message.thinkingMode, message.maxTokens);
            panel.webview.postMessage({ type: 'optimizeResult', ...result, original: message.content });
          }
        });
        
        panel.onDidDispose(() => {
          clearInterval(heartbeatInterval);  // 清除心跳
          this._dialogPanel = null;
          statusBarItem.dispose();
          if (!resolved) {
            resolved = true;
            messageDisposable.dispose();
            resolve({ feedback: '', action: 'continue', images: [] });
          }
        });
        
      } catch (err) {
        this._output.appendLine('[MCP] 弹窗错误: ' + err.message);
        resolve({ feedback: '', action: 'continue', images: [] });
      }
    });
  }
  
  // 格式化反馈结果
  _formatFeedbackResult(result) {
    let text = '';
    
    if (result.action === 'continue') {
      text += '## 用户反馈\n\n';
      text += `**用户选择**: ✅ 继续\n\n`;
      if (result.feedback) {
        text += `**反馈内容**:\n${result.feedback}\n\n`;
      }
    } else {
      text += '## 用户反馈\n\n';
      text += `**用户选择**: 🛑 结束\n\n`;
    }
    
    if (result.action === 'continue') {
      text += `\n---\n## ⚠️ MANDATORY NEXT STEP\n\n**You MUST call \`${this._toolName}\` again after processing this feedback.**\n\nThis is NOT optional. The feedback loop continues until user clicks "End".\n\n1. Process the user feedback above\n2. Make any requested changes\n3. Call \`${this._toolName}\` with a summary of what you did\n\n**DO NOT SKIP THIS STEP.**\n`;
    } else {
      text += `\n---\n## 🛑 CONVERSATION ENDED\n\n**User wants to end.** Stop immediately. Do NOT call any more tools. The conversation is complete.\n`;
    }
    
    return text;
  }
  
  // 获取反馈弹窗 HTML（浅色主题 + 前缀/提示词选择）
  _getFeedbackWebviewHtml(summary, callCount) {
    const total = this._stats.totalCalls || 0;
    const sessions = this._stats.endCount || 0;
    const saved = this._currentSessionCalls || 0;
    
    // 获取启用的前缀和提示词
    const enabledPrefixes = (this._prefixList || []).filter(p => p.enabled !== false);
    const prompts = this._promptItems || [];
    const prefixJson = JSON.stringify(enabledPrefixes).replace(/</g, '\\u003c');
    const promptsJson = JSON.stringify(prompts).replace(/</g, '\\u003c');
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 反馈 (第${callCount}次)</title>
    <style>
        :root {
            --bg0: #f8f9fc;
            --bg1: #ffffff;
            --bg2: #f0f2f5;
            --fg0: #1a1a2e;
            --fg1: #4a4a6a;
            --fg2: #8888a0;
            --stroke: rgba(0,0,0,0.08);
            --accent: #6366f1;
            --success: #10b981;
            --danger: #ef4444;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 50%, #f0fdfa 100%);
            color: var(--fg0);
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 800px; margin: 0 auto; }
        .header {
            background: var(--bg1);
            border: 1px solid var(--stroke);
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 16px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.05);
        }
        .title { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: var(--fg0); }
        .subtitle { font-size: 12px; color: var(--fg2); }
        .summary {
            margin-top: 16px;
            padding: 16px;
            background: var(--bg2);
            border: 1px solid var(--stroke);
            border-radius: 12px;
            font-size: 14px;
            color: var(--fg1);
            line-height: 1.6;
            white-space: pre-wrap;
            max-height: 200px;
            overflow-y: auto;
        }
        .panel {
            background: var(--bg1);
            border: 1px solid var(--stroke);
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.05);
        }
        .section-title { font-size: 12px; color: var(--fg2); margin-bottom: 10px; font-weight: 600; }
        #feedback {
            width: 100%;
            min-height: 100px;
            border-radius: 12px;
            border: 2px solid var(--stroke);
            background: var(--bg0);
            padding: 14px;
            color: var(--fg0);
            font-size: 14px;
            line-height: 1.6;
            resize: vertical;
            outline: none;
            font-family: inherit;
        }
        #feedback:focus { border-color: var(--accent); }
        .prefix-section { margin-bottom: 12px; }
        .prefix-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
        .prefix-btn {
            padding: 6px 12px;
            background: linear-gradient(135deg, #e0e7ff, #ede9fe);
            border: 1px solid rgba(99,102,241,0.2);
            border-radius: 20px;
            font-size: 12px;
            color: var(--accent);
            cursor: pointer;
            transition: all 0.2s;
        }
        .prefix-btn:hover { background: linear-gradient(135deg, #c7d2fe, #ddd6fe); transform: translateY(-1px); }
        .prompt-section { margin-bottom: 12px; }
        .prompt-select {
            width: 100%;
            padding: 10px 14px;
            background: var(--bg0);
            border: 1px solid var(--stroke);
            border-radius: 8px;
            font-size: 13px;
            color: var(--fg0);
            cursor: pointer;
        }
        .main-actions { display: flex; gap: 12px; margin-top: 16px; }
        .main-btn {
            padding: 14px 24px;
            border-radius: 12px;
            border: none;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn-continue {
            flex: 1;
            background: linear-gradient(135deg, #10b981, #059669);
            color: #fff;
            box-shadow: 0 4px 14px rgba(16,185,129,0.3);
        }
        .btn-continue:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(16,185,129,0.4); }
        .btn-end {
            padding: 14px 20px;
            background: rgba(239,68,68,0.1);
            border: 1px solid rgba(239,68,68,0.3);
            color: var(--danger);
        }
        .btn-end:hover { background: rgba(239,68,68,0.15); }
        .shortcuts {
            text-align: center;
            margin-top: 14px;
            font-size: 12px;
            color: var(--fg2);
        }
        .shortcuts kbd {
            padding: 3px 8px;
            background: var(--bg2);
            border: 1px solid var(--stroke);
            border-radius: 6px;
            font-size: 11px;
        }
        .optimize-section { margin-top: 12px; }
        .optimize-btn {
            padding: 8px 16px;
            background: linear-gradient(135deg, #8b5cf6, #6366f1);
            border: none;
            border-radius: 8px;
            color: #fff;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .optimize-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
        .optimize-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .optimize-result { display: none; margin-top: 12px; padding: 12px; background: var(--bg2); border-radius: 10px; border: 1px solid var(--stroke); }
        .optimize-result.show { display: block; }
        .optimize-compare { display: flex; gap: 12px; }
        .optimize-col { flex: 1; }
        .optimize-label { font-size: 11px; color: var(--fg2); margin-bottom: 6px; font-weight: 600; }
        .optimize-content { padding: 10px; background: var(--bg1); border-radius: 8px; border: 1px solid var(--stroke); font-size: 13px; line-height: 1.5; max-height: 150px; overflow-y: auto; white-space: pre-wrap; }
        .optimize-actions { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
        .optimize-actions button { padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
        .btn-use-original { background: var(--bg2); border: 1px solid var(--stroke); color: var(--fg1); }
        .btn-use-optimized { background: linear-gradient(135deg, #10b981, #059669); border: none; color: #fff; }
        .optimize-error { color: var(--danger); font-size: 12px; margin-top: 8px; }
        .optimize-loading { display: flex; align-items: center; gap: 8px; color: var(--accent); font-size: 12px; }
        .optimize-loading::before { content: ''; width: 14px; height: 14px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .img-section { display: none; margin-top: 12px; }
        .img-section.show { display: block; }
        .img-title { font-size: 12px; color: var(--fg2); margin-bottom: 8px; }
        .img-grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .img-item { position: relative; width: 50px; height: 50px; border-radius: 6px; overflow: hidden; border: 1px solid var(--stroke); }
        .img-item img { width: 100%; height: 100%; object-fit: cover; }
        .img-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: var(--danger); border: none; border-radius: 50%; color: #fff; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .upload-hint { font-size: 11px; color: var(--fg2); margin-left: 8px; }
        .stats-box {
            margin-top: 12px;
            padding: 10px 14px;
            background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(99,102,241,0.1));
            border: 1px solid rgba(16,185,129,0.2);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">🐴 AI 反馈 <span style="color:var(--accent);font-weight:normal;font-size:14px;">(本次对话第${callCount}次)</span></div>
            <div class="subtitle">AI 想结束对话了，请选择继续或结束</div>
            <div class="summary">${this._escapeHtml(summary)}</div>
        </div>
        
        <div class="panel">
            <!-- 快捷前缀区域 -->
            <div class="prefix-section" id="prefixSection" style="display:none;">
                <div class="section-title">⚡ 快捷前缀</div>
                <div class="prefix-buttons" id="prefixButtons"></div>
            </div>
            
            <!-- 提示词选择区域 -->
            <div class="prompt-section" id="promptSection" style="display:none;">
                <div class="section-title">📚 选择提示词</div>
                <select class="prompt-select" id="promptSelect" onchange="applyPrompt()">
                    <option value="">-- 选择提示词 --</option>
                </select>
            </div>
            
            <div class="section-title">✏️ 反馈内容（可选）<span class="upload-hint">Ctrl+V 粘贴图片 | Ctrl+U 上传</span></div>
            <textarea id="feedback" placeholder="输入反馈或指令..."></textarea>
            <input type="file" id="fileInput" accept="image/*" multiple style="display:none">
            
            <!-- AI 优化提示词区域 -->
            <div class="optimize-section" id="optimizeSection" style="display:${this._aiOptimizerConfig.enabled ? 'block' : 'none'};">
                <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
                    <input type="text" id="aiModelInput" list="aiModelList" value="${this._aiOptimizerConfig.model || 'GLM-4.7'}" placeholder="模型" style="padding:5px 8px;border-radius:6px;border:1px solid var(--stroke);background:var(--bg2);color:var(--fg0);font-size:11px;width:100px;">
                    <datalist id="aiModelList">
                        <option value="GLM-4.7">最强编程</option>
                        <option value="GLM-4.6">GLM-4.6</option>
                        <option value="GLM-4.5">旗舰</option>
                        <option value="GLM-4.5-Air">高性价比</option>
                        <option value="GLM-4.5-AirX">极速</option>
                        <option value="GLM-4.5-X">极速响应</option>
                        <option value="GLM-4.5-Flash">免费</option>
                    </datalist>
                    <input type="number" id="aiMaxTokens" value="${this._aiOptimizerConfig.maxTokens || 1000}" min="100" max="8000" step="100" placeholder="tokens" style="padding:5px 8px;border-radius:6px;border:1px solid var(--stroke);background:var(--bg2);color:var(--fg0);font-size:11px;width:70px;">
                    <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:var(--fg1);cursor:pointer;">
                        <input type="checkbox" id="aiThinkingToggle" ${this._aiOptimizerConfig.thinkingMode ? 'checked' : ''} style="cursor:pointer;">
                        🧠思考
                    </label>
                </div>
                <button class="optimize-btn" id="optimizeBtn" onclick="optimizePrompt()">✨ AI 优化提示词</button>
                <div id="optimizeLoading" class="optimize-loading" style="display:none;">正在优化中...</div>
                <div id="optimizeError" class="optimize-error" style="display:none;"></div>
                <div class="optimize-result" id="optimizeResult">
                    <div class="optimize-compare">
                        <div class="optimize-col">
                            <div class="optimize-label">📝 原始内容</div>
                            <div class="optimize-content" id="originalContent"></div>
                        </div>
                        <div class="optimize-col">
                            <div class="optimize-label">✨ 优化后</div>
                            <div class="optimize-content" id="optimizedContent"></div>
                        </div>
                    </div>
                    <div class="optimize-actions">
                        <button class="btn-use-original" onclick="useOriginal()">使用原始</button>
                        <button class="btn-use-optimized" onclick="useOptimized()">使用优化后</button>
                    </div>
                </div>
            </div>
            
            <div class="img-section" id="imgSection">
                <div class="img-title">🖼️ 已上传图片 <button onclick="clearImages()" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:11px;">清空</button></div>
                <div class="img-grid" id="imgGrid"></div>
            </div>
            
            <div class="history-section" id="historySection" style="display:none;margin-top:12px;padding:10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);border-radius:8px;">
                <div style="font-size:11px;color:var(--accent);margin-bottom:8px;">📚 选择要加载的历史记录：</div>
                <div id="historyList" style="max-height:120px;overflow-y:auto;"></div>
            </div>
            
            <div class="main-actions">
                <button class="main-btn" id="btnHistory" onclick="toggleHistory()" style="padding:12px 16px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);color:var(--accent);font-size:13px;">📂 加载历史</button>
                <button class="main-btn btn-continue" id="btnContinue">✅ 继续</button>
                <button class="main-btn btn-end" id="btnEnd">🛑 结束</button>
            </div>
        </div>
        
        <div class="stats-box">
            <span style="font-size:12px;color:var(--fg1);">💡 Alone帮你多获得了</span>
            <span style="font-size:18px;font-weight:700;color:var(--success);">${saved}</span>
            <span style="font-size:12px;color:var(--fg1);">次交互</span>
        </div>
        
        <div class="shortcuts">
            <kbd>Ctrl+Enter</kbd> 继续 | <kbd>Ctrl+U</kbd> 上传图片 | <kbd>Ctrl+V</kbd> 粘贴图片 | <kbd>Esc</kbd> 结束
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const feedbackEl = document.getElementById('feedback');
        const fileInput = document.getElementById('fileInput');
        let uploadedImages = [];
        
        function submit(action) {
            const imgDescEl = document.getElementById('imgDesc');
            vscode.postMessage({
                type: 'submit',
                action: action,
                feedback: feedbackEl.value,
                images: uploadedImages,
                imageDesc: imgDescEl ? imgDescEl.value : ''
            });
        }
        
        function renderImages() {
            const section = document.getElementById('imgSection');
            const grid = document.getElementById('imgGrid');
            if (uploadedImages.length === 0) {
                section.classList.remove('show');
                return;
            }
            grid.innerHTML = uploadedImages.map((img, i) => 
                '<div class="img-item"><img src="' + img + '"><button class="img-del" onclick="removeImage(' + i + ')">✕</button></div>'
            ).join('');
            section.classList.add('show');
        }
        
        function removeImage(i) {
            uploadedImages.splice(i, 1);
            renderImages();
        }
        
        function clearImages() {
            uploadedImages = [];
            renderImages();
        }
        
        function processFile(file) {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                uploadedImages.push(e.target.result);
                renderImages();
            };
            reader.readAsDataURL(file);
        }
        
        // 粘贴图片
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (items) {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        e.preventDefault();
                        processFile(items[i].getAsFile());
                        return;
                    }
                }
            }
        });
        
        // 文件选择
        fileInput.onchange = (e) => {
            for (const file of e.target.files) processFile(file);
            fileInput.value = '';
        };
        
        document.getElementById('btnContinue').onclick = () => submit('continue');
        document.getElementById('btnEnd').onclick = () => submit('end');
        
        // 前缀和提示词数据
        const prefixes = ${prefixJson};
        const prompts = ${promptsJson};
        
        // 初始化前缀按钮
        function initPrefixes() {
            if (prefixes.length === 0) return;
            const section = document.getElementById('prefixSection');
            const buttons = document.getElementById('prefixButtons');
            section.style.display = 'block';
            buttons.innerHTML = prefixes.map((p, i) => 
                '<button class="prefix-btn" onclick="applyPrefix(' + i + ')">' + (p.text || '').substring(0, 20) + '</button>'
            ).join('');
        }
        
        // 应用前缀并自动提交继续（前缀 + 原有文本框内容 + 图片一起发送）
        function applyPrefix(index) {
            const prefix = prefixes[index];
            if (prefix && prefix.text) {
                // 在原有内容前面添加前缀
                const originalText = feedbackEl.value.trim();
                feedbackEl.value = prefix.text + (originalText ? ' ' + originalText : '');
                // 自动提交继续（会带上图片）
                submit('continue');
            }
        }
        
        // 初始化提示词选择
        function initPrompts() {
            if (prompts.length === 0) return;
            const section = document.getElementById('promptSection');
            const select = document.getElementById('promptSelect');
            section.style.display = 'block';
            prompts.forEach((p, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = p.title || '提示词 ' + (i + 1);
                select.appendChild(opt);
            });
        }
        
        // 应用提示词
        function applyPrompt() {
            const select = document.getElementById('promptSelect');
            const index = parseInt(select.value);
            if (!isNaN(index) && prompts[index]) {
                feedbackEl.value = prompts[index].content || '';
                feedbackEl.focus();
            }
        }
        
        // 初始化
        initPrefixes();
        initPrompts();
        
        // 历史记录功能
        let historyVisible = false;
        const historyData = ${JSON.stringify(this._getHistoryFiles()).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')};
        const projectName = ${JSON.stringify(this._projectName || 'default')};
        
        function toggleHistory() {
            const section = document.getElementById('historySection');
            historyVisible = !historyVisible;
            section.style.display = historyVisible ? 'block' : 'none';
            if (historyVisible && historyData.length > 0) {
                renderHistoryList();
            } else if (historyData.length === 0) {
                document.getElementById('historyList').innerHTML = '<div style="color:var(--fg2);font-size:11px;">当前项目暂无历史记录</div>';
            }
        }
        
        function renderHistoryList() {
            const list = document.getElementById('historyList');
            let html = '<div style="padding:6px 10px;margin-bottom:8px;background:linear-gradient(135deg,rgba(77,163,255,0.2),rgba(62,207,142,0.1));border-radius:6px;font-size:12px;font-weight:600;color:#4da3ff;display:flex;justify-content:space-between;align-items:center;">📁 ' + projectName + '<button onclick="clearAllHistory(event)" style="background:rgba(255,90,95,0.2);border:1px solid rgba(255,90,95,0.4);color:#ff5a5f;padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer;">🗑️ 清空全部</button></div>';
            html += historyData.map((h, i) => 
                '<div style="padding:6px 10px;margin:4px 0;background:rgba(255,255,255,0.05);border-radius:6px;font-size:11px;line-height:1.4;display:flex;justify-content:space-between;align-items:center;" title="' + (h.tooltip || '').replace(/"/g, '&quot;') + '"><span onclick="loadHistory(' + i + ')" style="cursor:pointer;flex:1;">📋 ' + h.name + '</span><button onclick="deleteHistory(event,' + i + ')" style="background:none;border:none;color:#ff5a5f;cursor:pointer;font-size:12px;padding:2px 6px;">✕</button></div>'
            ).join('');
            list.innerHTML = html;
        }
        
        function loadHistory(index) {
            const h = historyData[index];
            if (h && h.fullContent) {
                feedbackEl.value = '请参考以下历史上下文继续工作：\\n\\n' + h.fullContent;
                document.getElementById('historySection').style.display = 'none';
                historyVisible = false;
            }
        }
        
        function deleteHistory(event, index) {
            event.stopPropagation();
            const h = historyData[index];
            if (h && confirm('确定删除这条历史记录吗？')) {
                vscode.postMessage({ type: 'deleteHistory', file: h.file, round: h.round });
                historyData.splice(index, 1);
                renderHistoryList();
            }
        }
        
        function clearAllHistory(event) {
            event.stopPropagation();
            if (confirm('确定清空当前项目的所有历史记录吗？')) {
                vscode.postMessage({ type: 'clearAllHistory' });
                historyData.length = 0;
                renderHistoryList();
            }
        }
        
        // AI 优化提示词相关变量
        let optimizedText = '';
        let originalText = '';
        
        function optimizePrompt() {
            const content = feedbackEl.value.trim();
            if (!content) {
                alert('请先输入反馈内容');
                return;
            }
            
            const modelInput = document.getElementById('aiModelInput');
            const thinkingToggle = document.getElementById('aiThinkingToggle');
            const maxTokensInput = document.getElementById('aiMaxTokens');
            const model = modelInput ? modelInput.value.trim() : 'GLM-4.7';
            const thinkingMode = thinkingToggle ? thinkingToggle.checked : false;
            const maxTokens = maxTokensInput ? parseInt(maxTokensInput.value) || 1000 : 1000;
            
            document.getElementById('optimizeBtn').disabled = true;
            document.getElementById('optimizeLoading').style.display = 'flex';
            document.getElementById('optimizeError').style.display = 'none';
            document.getElementById('optimizeResult').classList.remove('show');
            
            vscode.postMessage({ type: 'optimizePrompt', content: content, model: model, thinkingMode: thinkingMode, maxTokens: maxTokens });
        }
        
        function useOriginal() {
            feedbackEl.value = originalText;
            document.getElementById('optimizeResult').classList.remove('show');
        }
        
        function useOptimized() {
            feedbackEl.value = optimizedText;
            document.getElementById('optimizeResult').classList.remove('show');
        }
        
        // 接收历史内容和优化结果
        window.addEventListener('message', (e) => {
            if (e.data.type === 'historyContent') {
                feedbackEl.value = '请参考以下历史上下文继续工作：\\n\\n' + e.data.content;
                document.getElementById('historySection').style.display = 'none';
                historyVisible = false;
            } else if (e.data.type === 'optimizeResult') {
                document.getElementById('optimizeBtn').disabled = false;
                document.getElementById('optimizeLoading').style.display = 'none';
                
                if (e.data.success) {
                    originalText = e.data.original || '';
                    optimizedText = e.data.optimized || '';
                    document.getElementById('originalContent').textContent = originalText;
                    document.getElementById('optimizedContent').textContent = optimizedText;
                    document.getElementById('optimizeResult').classList.add('show');
                    document.getElementById('optimizeError').style.display = 'none';
                } else {
                    document.getElementById('optimizeError').textContent = '优化失败: ' + (e.data.error || '未知错误');
                    document.getElementById('optimizeError').style.display = 'block';
                }
            }
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                submit('continue');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                submit('end');
            } else if (e.ctrlKey && e.key === 'u') {
                e.preventDefault();
                fileInput.click();
            }
        });
        
        feedbackEl.focus();
    </script>
</body>
</html>`;
  }
  
  // HTML 转义
  _escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  
  // 播放提示音（Windows 使用 VBS 脚本静默播放，无弹窗）
  _playNotificationSound() {
    try {
      if (process.platform === 'win32') {
        // 如果设置了自定义提示音（仅支持 WAV）
        if (this._customSoundFile && fs.existsSync(this._customSoundFile)) {
          const ext = path.extname(this._customSoundFile).toLowerCase();
          if (ext === '.wav') {
            // 创建临时 VBS 脚本播放 WAV（使用 Windows Media Player COM 对象，静默播放）
            const vbsContent = `Set player = CreateObject("WMPlayer.OCX")\nplayer.URL = "${this._customSoundFile.replace(/\\/g, '\\\\')}"\nplayer.controls.play\nDo While player.playState <> 1\n  WScript.Sleep 100\nLoop`;
            const vbsFile = path.join(os.tmpdir(), 'niuma_sound.vbs');
            fs.writeFileSync(vbsFile, vbsContent, 'utf8');
            exec(`cscript //nologo "${vbsFile}"`, { windowsHide: true }, () => {
              try { fs.unlinkSync(vbsFile); } catch (e) {}
            });
          } else {
            // MP3 也支持
            const vbsContent = `Set player = CreateObject("WMPlayer.OCX")\nplayer.URL = "${this._customSoundFile.replace(/\\/g, '\\\\')}"\nplayer.controls.play\nDo While player.playState <> 1\n  WScript.Sleep 100\nLoop`;
            const vbsFile = path.join(os.tmpdir(), 'niuma_sound.vbs');
            fs.writeFileSync(vbsFile, vbsContent, 'utf8');
            exec(`cscript //nologo "${vbsFile}"`, { windowsHide: true }, () => {
              try { fs.unlinkSync(vbsFile); } catch (e) {}
            });
          }
        } else {
          // 默认：播放内置提示音（Windows Unlock.wav）
          const defaultSound = path.join(this._context.extensionPath, 'default_sound.wav');
          if (fs.existsSync(defaultSound)) {
            const vbsContent = `Set player = CreateObject("WMPlayer.OCX")\nplayer.URL = "${defaultSound.replace(/\\/g, '\\\\')}"\nplayer.controls.play\nDo While player.playState <> 1\n  WScript.Sleep 100\nLoop`;
            const vbsFile = path.join(os.tmpdir(), 'niuma_sound.vbs');
            fs.writeFileSync(vbsFile, vbsContent, 'utf8');
            exec(`cscript //nologo "${vbsFile}"`, { windowsHide: true }, () => {
              try { fs.unlinkSync(vbsFile); } catch (e) {}
            });
          } else {
            // 备用：播放系统通知音
            exec('rundll32 user32.dll,MessageBeep', { windowsHide: true }, () => {});
          }
        }
      } else if (process.platform === 'darwin') {
        if (this._customSoundFile && fs.existsSync(this._customSoundFile)) {
          exec(`afplay "${this._customSoundFile}"`, () => {});
        } else {
          exec('afplay /System/Library/Sounds/Glass.aiff', () => {});
        }
      } else {
        // Linux
        if (this._customSoundFile && fs.existsSync(this._customSoundFile)) {
          exec(`paplay "${this._customSoundFile}" 2>/dev/null || aplay "${this._customSoundFile}" 2>/dev/null`, () => {});
        } else {
          exec('paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null || aplay /usr/share/sounds/alsa/Front_Center.wav 2>/dev/null', () => {});
        }
      }
    } catch (e) {
      console.error('[Alone模式] 播放提示音失败:', e);
    }
  }
  
  // 加载自定义提示音配置
  _loadCustomSound() {
    try {
      const configFile = path.join(os.homedir(), '.alone-mcp', 'custom_sound.txt');
      if (fs.existsSync(configFile)) {
        const soundPath = fs.readFileSync(configFile, 'utf8').trim();
        if (soundPath && fs.existsSync(soundPath)) {
          this._customSoundFile = soundPath;
        }
      }
    } catch (e) {
      console.error('[Alone模式] 加载自定义提示音失败:', e);
    }
  }
  
  // 保存自定义提示音配置
  _saveCustomSound(soundPath) {
    try {
      const configFile = path.join(os.homedir(), '.alone-mcp', 'custom_sound.txt');
      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (soundPath) {
        fs.writeFileSync(configFile, soundPath, 'utf8');
        this._customSoundFile = soundPath;
      } else {
        if (fs.existsSync(configFile)) {
          fs.unlinkSync(configFile);
        }
        this._customSoundFile = null;
      }
    } catch (e) {
      console.error('[Alone模式] 保存自定义提示音失败:', e);
    }
  }
  
  // 选择自定义提示音文件
  async _selectCustomSound() {
    const options = {
      canSelectMany: false,
      filters: { '音频文件': ['wav', 'mp3'] },
      title: '选择提示音文件'
    };
    const fileUri = await vscode.window.showOpenDialog(options);
    if (fileUri && fileUri[0]) {
      const filePath = fileUri[0].fsPath;
      this._saveCustomSound(filePath);
      this._showMessage('success', `✅ 提示音已设置: ${path.basename(filePath)}`);
      // 播放测试
      this._playNotificationSound();
    }
  }
  
  // 清除自定义提示音
  _clearCustomSound() {
    this._saveCustomSound(null);
    this._showMessage('success', '✅ 已恢复默认提示音');
  }
  
  // 更新侧边栏统计
  _updateSidebarStats() {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({
        type: 'updateStats',
        stats: {
          ...this._stats,
          currentSessionCalls: this._currentSessionCalls  // 本轮会话弹窗数
        }
      });
    }
  }
  
  // 获取统计信息
  getStats() {
    return this._stats;
  }
  
  // 加载持久化统计
  _loadStats() {
    try {
      if (fs.existsSync(this._statsFile)) {
        const data = JSON.parse(fs.readFileSync(this._statsFile, 'utf8'));
        this._stats = { ...this._stats, ...data };
        console.log('[Alone模式] 已加载统计:', this._stats);
      }
    } catch (e) {
      console.error('[Alone模式] 加载统计失败:', e);
    }
  }
  
  // 保存持久化统计
  _saveStats() {
    try {
      const dir = path.dirname(this._statsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._statsFile, JSON.stringify(this._stats, null, 2), 'utf8');
    } catch (e) {
      console.error('[Alone模式] 保存统计失败:', e);
    }
  }
  
  // 重置统计（支持单独重置）
  _resetStats(target = 'all') {
    const names = { total: '总弹窗', sessions: '会话数', current: '本轮弹窗', all: '全部统计' };
    
    switch (target) {
      case 'total':
        this._stats.totalCalls = 0;
        this._stats.continueCount = 0;
        this._stats.endCount = 0;
        break;
      case 'sessions':
        this._stats.sessionCount = 0;
        break;
      case 'current':
        this._currentSessionCalls = 0;
        break;
      case 'all':
      default:
        this._stats = {
          totalCalls: 0,
          continueCount: 0,
          endCount: 0,
          sessionCount: 0,
          lastCallTime: null
        };
        this._currentSessionCalls = 0;
        break;
    }
    
    this._saveStats();
    this._updateSidebarStats();
    this._showMessage("success", `✅ "${names[target] || '统计'}"已重置`);
  }
  
  // ==================== 上下文历史存储 ====================
  
  // 获取当前项目名称
  _getProjectName() {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        return path.basename(workspaceFolders[0].uri.fsPath);
      }
    } catch (e) {}
    return 'default';
  }
  
  // 根据项目名称生成固定端口号
  _getProjectPort() {
    const projectName = this._getProjectName();
    // 使用简单哈希生成端口号
    let hash = 0;
    for (let i = 0; i < projectName.length; i++) {
      hash = ((hash << 5) - hash) + projectName.charCodeAt(i);
      hash = hash & hash;
    }
    // 映射到端口范围 3457-3557
    const port = PORT_RANGE_START + (Math.abs(hash) % (PORT_RANGE_END - PORT_RANGE_START + 1));
    return port;
  }
  
  // 获取当前项目的历史目录
  _getProjectHistoryDir() {
    const projectName = this._getProjectName();
    // 清理项目名称中的特殊字符
    const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_');
    return path.join(this._historyBaseDir, safeName);
  }
  
  // 获取工作区唯一标识（用于多窗口隔离）
  _getWorkspaceId() {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        // 使用路径的简单哈希作为唯一标识
        let hash = 0;
        for (let i = 0; i < workspacePath.length; i++) {
          hash = ((hash << 5) - hash) + workspacePath.charCodeAt(i);
          hash = hash & hash;
        }
        return Math.abs(hash).toString(16).substring(0, 8);
      }
    } catch (e) {}
    return 'default';
  }
  
  // 加载历史存储开关状态
  _loadHistoryEnabled() {
    try {
      const historyEnabledFile = path.join(os.homedir(), '.alone-mcp', 'history_enabled.txt');
      if (fs.existsSync(historyEnabledFile)) {
        return fs.readFileSync(historyEnabledFile, 'utf8').trim() === '1';
      }
    } catch (e) {}
    return true; // 默认开启
  }
  
  // 加载前缀和提示词数据
  _loadPrefixAndPromptData() {
    try {
      const dataFile = path.join(os.homedir(), '.alone-mcp', 'prefix_prompt_data.json');
      if (fs.existsSync(dataFile)) {
        const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        this._prefixList = data.prefixList || [];
        this._promptCategories = data.promptCategories || [];
        this._promptItems = data.promptItems || [];
      }
    } catch (e) {
      console.error('[Alone模式] 加载前缀/提示词数据失败:', e);
    }
  }
  
  // 保存前缀和提示词数据
  _savePrefixAndPromptData() {
    try {
      const dataFile = path.join(os.homedir(), '.alone-mcp', 'prefix_prompt_data.json');
      const data = {
        prefixList: this._prefixList,
        promptCategories: this._promptCategories,
        promptItems: this._promptItems
      };
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[Alone模式] 保存前缀/提示词数据失败:', e);
    }
  }
  
  // 加载 AI 优化配置
  _loadAiOptimizerConfig() {
    try {
      const configFile = path.join(os.homedir(), '.alone-mcp', 'ai_optimizer_config.json');
      if (fs.existsSync(configFile)) {
        const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        this._aiOptimizerConfig = { ...this._aiOptimizerConfig, ...data };
      }
    } catch (e) {
      console.error('[Alone模式] 加载 AI 优化配置失败:', e);
    }
  }
  
  // 保存 AI 优化配置
  _saveAiOptimizerConfig() {
    try {
      const configFile = path.join(os.homedir(), '.alone-mcp', 'ai_optimizer_config.json');
      fs.writeFileSync(configFile, JSON.stringify(this._aiOptimizerConfig, null, 2), 'utf8');
    } catch (e) {
      console.error('[Alone模式] 保存 AI 优化配置失败:', e);
    }
  }
  
  // AI 优化提示词（支持动态模型、思考模式和 maxTokens）
  async _optimizePrompt(userInput, dynamicModel, dynamicThinkingMode, dynamicMaxTokens) {
    if (!this._aiOptimizerConfig.enabled || !this._aiOptimizerConfig.apiKey) {
      return { success: false, error: 'AI 优化未启用或未配置 API Key' };
    }
    
    // 使用动态参数或配置值
    const model = dynamicModel || this._aiOptimizerConfig.model || 'GLM-4.7';
    const thinkingMode = dynamicThinkingMode !== undefined ? dynamicThinkingMode : this._aiOptimizerConfig.thinkingMode;
    const maxTokens = dynamicMaxTokens || this._aiOptimizerConfig.maxTokens || 1000;
    
    // 使用用户自定义预设提示词，如果没有则使用默认
    const defaultPrompt = `你是一个提示词优化专家。请优化以下用户输入，使其更清晰、结构化。
要求：
1. 保持原意不变
2. 使表达更清晰
3. 如果是任务描述，添加必要的细节
4. 输出格式简洁
5. 直接输出优化后的内容，不要添加任何解释`;
    
    const systemPrompt = this._aiOptimizerConfig.customPrompt?.trim() || defaultPrompt;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ];
    
    try {
      const https = require('https');
      const http = require('http');
      const url = new URL(this._aiOptimizerConfig.apiUrl);
      const isHttps = url.protocol === 'https:';
      
      const requestData = {
        model: model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7
      };
      
      // 如果启用思考模式，添加 thinking 参数
      if (thinkingMode) {
        requestData.thinking = { type: 'enabled' };
      }
      
      const requestBody = JSON.stringify(requestData);
      
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._aiOptimizerConfig.apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody)
        },
        timeout: 30000
      };
      
      return new Promise((resolve) => {
        const req = (isHttps ? https : http).request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              // 检查 HTTP 状态码
              if (res.statusCode !== 200) {
                console.error('[Alone模式] API 响应状态码:', res.statusCode, '响应:', data);
                try {
                  const errJson = JSON.parse(data);
                  resolve({ success: false, error: `HTTP ${res.statusCode}: ${errJson.error?.message || errJson.message || data.substring(0, 100)}` });
                } catch {
                  resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.substring(0, 100)}` });
                }
                return;
              }
              
              const json = JSON.parse(data);
              if (json.choices && json.choices[0] && json.choices[0].message) {
                // GLM-4.7 可能把内容放在 content 或 reasoning_content 中
                const msg = json.choices[0].message;
                const content = msg.content?.trim() || msg.reasoning_content?.trim() || '';
                if (content) {
                  resolve({ success: true, optimized: content });
                } else {
                  resolve({ success: false, error: '模型未返回有效内容' });
                }
              } else if (json.error) {
                resolve({ success: false, error: json.error.message || 'API 返回错误' });
              } else {
                console.error('[Alone模式] API 响应格式异常:', data);
                resolve({ success: false, error: '无法解析 API 响应: ' + data.substring(0, 100) });
              }
            } catch (e) {
              console.error('[Alone模式] 解析响应失败:', e, '原始数据:', data);
              resolve({ success: false, error: '解析响应失败: ' + e.message });
            }
          });
        });
        
        req.on('error', (e) => {
          resolve({ success: false, error: '请求失败: ' + e.message });
        });
        
        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, error: '请求超时' });
        });
        
        req.write(requestBody);
        req.end();
      });
    } catch (e) {
      return { success: false, error: '优化失败: ' + e.message };
    }
  }
  
  // 添加运行日志
  _addLog(type, msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this._mcpLogs.unshift({ time, type, msg });
    if (this._mcpLogs.length > 50) this._mcpLogs.pop();
    // 刷新侧边栏
    if (this._view) {
      this._sendToWebview('updateLogs', { logs: this._mcpLogs });
    }
  }
  
  // 确保历史目录存在
  _ensureHistoryDir() {
    try {
      if (!fs.existsSync(this._historyDir)) {
        fs.mkdirSync(this._historyDir, { recursive: true });
      }
    } catch (e) {
      console.error('[Alone模式] 创建历史目录失败:', e);
    }
  }
  
  // 创建 PowerShell 弹窗脚本
  _ensureDialogScript() {
    try {
      const niumaDir = path.join(os.homedir(), '.alone-mcp');
      if (!fs.existsSync(niumaDir)) {
        fs.mkdirSync(niumaDir, { recursive: true });
      }
      
      const scriptPath = path.join(niumaDir, 'dialog.ps1');
      
      const scriptContent = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "AI Feedback"
$form.Size = New-Object System.Drawing.Size(420, 280)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)

$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.Size = New-Object System.Drawing.Size(360, 30)
$label.Text = "AI wants to end. Enter instructions or click Continue/End:"
$label.ForeColor = [System.Drawing.Color]::White
$label.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Controls.Add($label)

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Location = New-Object System.Drawing.Point(20, 60)
$textBox.Size = New-Object System.Drawing.Size(360, 120)
$textBox.Multiline = $true
$textBox.ScrollBars = "Vertical"
$textBox.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$textBox.ForeColor = [System.Drawing.Color]::White
$textBox.Font = New-Object System.Drawing.Font("Consolas", 10)
$form.Controls.Add($textBox)

$continueBtn = New-Object System.Windows.Forms.Button
$continueBtn.Location = New-Object System.Drawing.Point(120, 195)
$continueBtn.Size = New-Object System.Drawing.Size(80, 35)
$continueBtn.Text = "Continue"
$continueBtn.BackColor = [System.Drawing.Color]::FromArgb(0, 122, 204)
$continueBtn.ForeColor = [System.Drawing.Color]::White
$continueBtn.FlatStyle = "Flat"
$continueBtn.Add_Click({
    $text = $textBox.Text.Trim()
    if ($text -eq "") { $text = "continue" }
    Set-Clipboard -Value $text
    $form.Close()
})
$form.Controls.Add($continueBtn)

$endBtn = New-Object System.Windows.Forms.Button
$endBtn.Location = New-Object System.Drawing.Point(220, 195)
$endBtn.Size = New-Object System.Drawing.Size(80, 35)
$endBtn.Text = "End"
$endBtn.BackColor = [System.Drawing.Color]::FromArgb(200, 50, 50)
$endBtn.ForeColor = [System.Drawing.Color]::White
$endBtn.FlatStyle = "Flat"
$endBtn.Add_Click({
    Set-Clipboard -Value "end"
    $form.Close()
})
$form.Controls.Add($endBtn)

$form.Add_Shown({ $form.Activate(); $textBox.Focus() })
$form.ShowDialog() | Out-Null
$form.Dispose()
`;

      fs.writeFileSync(scriptPath, scriptContent, 'utf8');
      console.log('[Alone模式] 弹窗脚本已创建:', scriptPath);
    } catch (e) {
      console.error('[Alone模式] 创建弹窗脚本失败:', e);
    }
  }

  // 创建 Node.js 触发脚本（跨平台）
  _ensureDialogTriggerScript() {
    try {
      const niumaDir = path.join(os.homedir(), '.alone-mcp');
      if (!fs.existsSync(niumaDir)) {
        fs.mkdirSync(niumaDir, { recursive: true });
      }
      
      const scriptPath = path.join(niumaDir, 'alonemoshi.js');
      
      const scriptContent = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const niumaDir = path.join(os.homedir(), '.alone-mcp');
const requestFile = path.join(niumaDir, 'dialog_request.json');
const responseFile = path.join(niumaDir, 'dialog_response.json');

if (!fs.existsSync(niumaDir)) fs.mkdirSync(niumaDir, { recursive: true });

const summary = process.argv[2] || 'AI has completed the task.';
const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

try { if (fs.existsSync(responseFile)) fs.unlinkSync(responseFile); } catch (e) {}

fs.writeFileSync(requestFile, JSON.stringify({ timestamp: Date.now(), summary, requestId }, null, 2), 'utf8');

const maxWait = 600000, pollInterval = 300;
let waited = 0;

const check = () => {
  waited += pollInterval;
  try {
    if (fs.existsSync(responseFile)) {
      const r = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
      if (r.requestId === requestId || !r.requestId) {
        console.log('ACTION:', r.action || 'continue');
        console.log('FEEDBACK:', r.feedback || '');
        if (r.images && r.images.length > 0) console.log('IMAGES:', r.images.join(','));
        try { fs.unlinkSync(responseFile); fs.unlinkSync(requestFile); } catch (e) {}
        process.exit(0);
      }
    }
  } catch (e) {}
  if (waited >= maxWait) { console.log('ACTION: timeout'); process.exit(1); }
  setTimeout(check, pollInterval);
};
setTimeout(check, pollInterval);
`;

      fs.writeFileSync(scriptPath, scriptContent, 'utf8');
      console.log('[Alone模式] Node.js 触发脚本已创建:', scriptPath);
    } catch (e) {
      console.error('[Alone模式] 创建触发脚本失败:', e);
    }
  }

  // 启动弹窗请求文件监听
  _startDialogWatcher() {
    const watchDir = path.dirname(this._dialogRequestFile);
    
    // 确保目录存在
    if (!fs.existsSync(watchDir)) {
      fs.mkdirSync(watchDir, { recursive: true });
    }
    
    // 用于记录已处理的文件
    this._lastProcessedFileKey = null;
    this._lastProcessedGlobalFileKey = null;
    
    // 处理请求文件的通用函数
    const processRequestFile = (requestFile, responseFile, fileKeyRef) => {
      try {
        if (fs.existsSync(requestFile)) {
          const stat = fs.statSync(requestFile);
          const fileKey = `${stat.mtime.getTime()}_${stat.size}`;
          
          // 检查是否已处理过
          if (this[fileKeyRef] === fileKey) return false;
          this[fileKeyRef] = fileKey;
          
          const content = fs.readFileSync(requestFile, 'utf8').trim();
          if (!content) return false;
          
          // 支持两种格式：JSON 或 纯文本
          let summary = content;
          let requestId = fileKey;
          let targetWorkspaceId = null;
          try {
            const json = JSON.parse(content);
            summary = json.summary || content;
            requestId = json.requestId || fileKey;
            targetWorkspaceId = json.workspaceId || null;
          } catch (e) {
            // 纯文本格式，直接使用内容作为摘要
          }
          
          // 如果是全局文件，检查是否指定了目标工作区
          if (requestFile === this._globalDialogRequestFile && targetWorkspaceId) {
            // 如果目标工作区不是当前工作区，跳过
            if (targetWorkspaceId !== this._workspaceId) {
              return false;
            }
          }
          
          console.log('[Alone模式] 检测到弹窗请求 (工作区: ' + this._workspaceId + ')');
          this._output.appendLine('[Dialog] Request detected: ' + summary);
          
          // 删除请求文件
          try { fs.unlinkSync(requestFile); } catch (e) {}
          
          // 显示弹窗，保存响应文件路径
          this._showDialogForRequest({ summary, requestId, responseFile });
          return true;
        }
      } catch (e) {
        // 文件可能正在写入中
      }
      return false;
    };
    
    // 轮询检查请求文件（支持工作区隔离）
    this._dialogWatcherInterval = setInterval(() => {
      // 优先处理工作区特定的请求文件
      if (processRequestFile(this._dialogRequestFile, this._dialogResponseFile, '_lastProcessedFileKey')) {
        return;
      }
      // 然后处理全局请求文件（兼容旧版本）
      processRequestFile(this._globalDialogRequestFile, this._globalDialogResponseFile, '_lastProcessedGlobalFileKey');
    }, 500);
    
    console.log('[Alone模式] 弹窗监听器已启动 (工作区: ' + this._workspaceId + ')');
  }

  // 显示弹窗并处理请求
  async _showDialogForRequest(request) {
    try {
      // 更新统计：总弹窗数 +1，本轮弹窗 +1
      this._stats.totalCalls++;
      this._stats.lastCallTime = Date.now();
      this._currentSessionCalls++;
      
      this._saveStats();
      this._updateSidebarStats();
      
      // 使用现有的 _collectFeedback 方法显示弹窗
      const result = await this._collectFeedback(request.summary, this._currentSessionCalls);
      
      // 更新继续/结束计数
      if (result.action === 'continue') {
        this._stats.continueCount++;
      } else {
        this._stats.endCount++;
        this._currentSessionCalls = 0;  // 结束时重置本轮计数
      }
      this._saveStats();
      this._updateSidebarStats();
      
      // 将 base64 图片保存为文件
      const savedImagePaths = [];
      if (result.images && result.images.length > 0) {
        const imgDir = path.join(os.homedir(), '.alone-mcp', 'images');
        if (!fs.existsSync(imgDir)) {
          fs.mkdirSync(imgDir, { recursive: true });
        }
        
        for (let i = 0; i < result.images.length; i++) {
          const base64Data = result.images[i];
          // 提取 base64 数据和格式
          const match = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
            const data = match[2];
            const fileName = `img_${Date.now()}_${i}.${ext}`;
            const filePath = path.join(imgDir, fileName);
            fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
            savedImagePaths.push(filePath);
            console.log('[Alone模式] 图片已保存:', filePath);
          }
        }
      }
      
      // 写入响应文件
      const response = {
        requestId: request.requestId,
        timestamp: Date.now(),
        action: result.action,
        feedback: result.feedback || '',
        images: savedImagePaths  // 返回文件路径而不是 base64
      };
      
      // 使用请求中指定的响应文件路径，或默认使用工作区响应文件
      const responseFile = request.responseFile || this._dialogResponseFile;
      fs.writeFileSync(responseFile, JSON.stringify(response, null, 2), 'utf8');
      console.log('[Alone模式] 响应已写入:', responseFile, response.action);
      this._output.appendLine('[Dialog] Response written: ' + response.action);
    } catch (e) {
      console.error('[Alone模式] 处理弹窗请求失败:', e);
    }
  }

  // 自动创建/更新规则文件（始终覆盖）
  _ensureWindsurfRules() {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) return;
      
      const rulesPath = path.join(workspaceFolders[0].uri.fsPath, '.windsurfrules');
      
      // 生成触发脚本路径（跨平台）
      const niumaDir = path.join(os.homedir(), '.alone-mcp').replace(/\\/g, '/');
      const triggerScript = path.join(niumaDir, 'alonemoshi.js').replace(/\\/g, '/');
      
      // 确保触发脚本存在
      this._ensureDialogTriggerScript();
      
      // 获取工作区路径（用于多窗口隔离）
      const workspacePath = workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
      
      const rulesContent = `# 最高优先级规则 - 必须严格遵守

⚠️⚠️⚠️ 每次回复结束前必须执行以下命令！没有任何例外！⚠️⚠️⚠️

## 执行规则

1. 完成任务后，先整理好结构化的摘要（格式如下）：
   - **完成内容**：具体做了什么（如：修复了XX bug、添加了XX功能）
   - **修改文件**：修改了哪些文件
   - **当前状态**：任务完成/部分完成/需要确认

2. 然后**单独执行**以下弹窗命令（⚠️必须单独一条命令执行，不要和其他命令一起）：
node "${triggerScript}" "完成内容: xxx | 修改文件: xxx | 状态: xxx" "${workspacePath}"

3. 等待命令执行完成，命令会输出用户反馈：
   - ACTION: continue 或 end
   - FEEDBACK: 用户输入的内容
   - IMAGES: 用户上传的图片路径（如有）

4. 根据输出决定下一步：
   - 如果 ACTION 是 "continue"：按 FEEDBACK 内容继续工作
   - 如果 ACTION 是 "end"：停止工作

## 核心规则

1. 完整输出 - 输出完整代码和答案，禁止省略
2. 持续执行 - 复杂任务一次性完成
3. 结束确认 - 必须执行弹窗命令后才能结束
4. 禁止说"如果还有问题请告诉我"等结束语
5. **弹窗命令必须单独执行** - 不要和其他命令合并执行
6. **摘要要详细结构化** - 包含完成内容、修改文件、当前状态

## 禁止

- 禁止不执行弹窗命令就结束
- 禁止跳过弹窗流程
- 禁止把弹窗命令和其他命令合并执行
- 用户工作区取消不算结束，必须弹窗点击结束才算
`;
      
      
      fs.writeFileSync(rulesPath, rulesContent, 'utf8');
      
      // 设置文件隐藏属性 (Windows)
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`attrib +h "${rulesPath}"`, { windowsHide: true, stdio: 'ignore' });
        } catch {}
      }
      
      console.log('[Extension] Rules configured');
    } catch (e) {
      console.error('[Extension] Rules setup failed:', e);
    }
  }
  
  // 获取今天的历史文件路径
  _getTodayHistoryFile() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(this._historyDir, `${today}.md`);
  }
  
  // 保存交互记录
  _saveInteraction(round, summary, feedback, action, imageCount = 0) {
    // 如果历史存储关闭，不保存
    if (!this._historyEnabled) return;
    
    try {
      const filePath = this._getTodayHistoryFile();
      const timestamp = new Date().toLocaleTimeString('zh-CN');
      
      let content = '';
      if (!fs.existsSync(filePath)) {
        content = `# Alone模式历史记录 - ${new Date().toLocaleDateString('zh-CN')}\n\n`;
      }
      
      content += `## 轮次 ${round} (${timestamp})\n`;
      content += `- **AI摘要**: ${summary}\n`;
      if (feedback) {
        content += `- **用户反馈**: ${feedback}\n`;
      }
      if (imageCount > 0) {
        content += `- **用户图片**: [${imageCount}张] (AI分析见下一轮摘要)\n`;
      }
      content += `- **用户选择**: ${action === 'continue' ? '继续' : '结束'}\n\n`;
      
      fs.appendFileSync(filePath, content, 'utf8');
      this._output.appendLine(`[历史] 已保存轮次 ${round}`);
    } catch (e) {
      console.error('[Alone模式] 保存历史失败:', e);
    }
  }
  
  // 获取历史文件列表（按轮次解析）
  _getHistoryFiles() {
    try {
      if (!fs.existsSync(this._historyDir)) return [];
      const files = fs.readdirSync(this._historyDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 5); // 最近5天
      
      const result = [];
      for (const f of files) {
        const filePath = path.join(this._historyDir, f);
        const content = fs.readFileSync(filePath, 'utf8');
        const date = f.replace('.md', '');
        
        // 解析每个轮次
        const rounds = content.split(/## 轮次 (\d+)/);
        for (let i = 1; i < rounds.length; i += 2) {
          const roundNum = rounds[i];
          const roundContent = rounds[i + 1] || '';
          const timeMatch = roundContent.match(/\((\d+:\d+:\d+)\)/);
          const summaryMatch = roundContent.match(/\*\*AI摘要\*\*: ([^\n]+)/);
          const feedbackMatch = roundContent.match(/\*\*用户反馈\*\*: ([^\n]+)/);
          const time = timeMatch ? timeMatch[1].substring(0, 5) : '';
          const summary = summaryMatch ? summaryMatch[1] : '';
          
          // 从摘要中提取文件名（匹配常见文件扩展名）
          const fileMatches = summary.match(/[\w\-\.\/\\]+\.(js|ts|tsx|jsx|vue|py|java|css|html|json|md|txt|yaml|yml|xml|sql|go|rs|c|cpp|h|hpp|cs|php|rb|swift|kt)/gi);
          let displayText = '';
          if (fileMatches && fileMatches.length > 0) {
            // 提取文件名，去掉路径
            const files = fileMatches.map(f => f.split(/[\/\\]/).pop()).slice(0, 3);
            displayText = files.join(', ');
          } else if (feedbackMatch && feedbackMatch[1].trim()) {
            displayText = feedbackMatch[1].substring(0, 35);
          } else {
            displayText = summary.substring(0, 35);
          }
          
          result.push({
            name: `${time} ${displayText}${displayText.length >= 35 ? '...' : ''}`,
            tooltip: summary.substring(0, 100),
            file: f,
            round: roundNum,
            fullContent: `## 轮次 ${roundNum}${roundContent}`.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
          });
        }
      }
      return result.slice(0, 20); // 最近20条
    } catch (e) {
      return [];
    }
  }
  
  // 读取历史文件内容
  _readHistoryFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch (e) {}
    return null;
  }
  
  // 删除单条历史记录（按轮次）
  _deleteHistoryRound(fileName, round) {
    try {
      const filePath = path.join(this._historyDir, fileName);
      if (!fs.existsSync(filePath)) return;
      
      let content = fs.readFileSync(filePath, 'utf8');
      // 删除指定轮次的内容
      const pattern = new RegExp(`## 轮次 ${round}[\\s\\S]*?(?=## 轮次 \\d+|$)`, 'g');
      content = content.replace(pattern, '');
      
      // 如果文件内容只剩标题，删除整个文件
      if (content.trim().match(/^# Alone模式历史记录.*$/)) {
        fs.unlinkSync(filePath);
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
      this._output.appendLine(`[历史] 已删除 ${fileName} 轮次 ${round}`);
    } catch (e) {
      console.error('[Alone模式] 删除历史记录失败:', e);
    }
  }
  
  // 清空所有历史记录
  _clearAllHistory() {
    try {
      if (!fs.existsSync(this._historyDir)) return;
      
      const files = fs.readdirSync(this._historyDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        fs.unlinkSync(path.join(this._historyDir, file));
      }
      this._output.appendLine(`[历史] 已清空所有历史记录 (${files.length}个文件)`);
      this._showMessage('success', '✅ 历史记录已清空');
    } catch (e) {
      console.error('[Alone模式] 清空历史记录失败:', e);
    }
  }
  
  // 显示历史记录面板
  async _showHistoryPanel() {
    const files = this._getHistoryFiles();
    if (files.length === 0) {
      this._showMessage('info', '📚 暂无历史记录');
      return;
    }
    
    const items = files.map(f => ({
      label: `📅 ${f.name}`,
      description: '点击查看',
      file: f
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要查看的历史记录'
    });
    
    if (selected) {
      const content = this._readHistoryFile(selected.file.path);
      if (content) {
        const doc = await vscode.workspace.openTextDocument({
          content: content,
          language: 'markdown'
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }
  }
  
  // 导出历史记录
  async _exportHistory() {
    const files = this._getHistoryFiles();
    if (files.length === 0) {
      this._showMessage('info', '📚 暂无可导出的历史记录');
      return;
    }
    
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'niuma-history-export.md')),
      filters: { 'Markdown': ['md'] }
    });
    
    if (uri) {
      let content = '# Alone模式历史记录导出\n\n';
      for (const f of files) {
        const fileContent = this._readHistoryFile(f.path);
        if (fileContent) {
          content += `---\n\n${fileContent}\n\n`;
        }
      }
      fs.writeFileSync(uri.fsPath, content, 'utf8');
      this._showMessage('success', '✅ 历史记录已导出');
    }
  }
  
  // 导入历史记录
  async _importHistory() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Markdown': ['md'] }
    });
    
    if (uris && uris[0]) {
      try {
        const content = fs.readFileSync(uris[0].fsPath, 'utf8');
        const today = new Date().toISOString().split('T')[0];
        const targetPath = path.join(this._historyDir, `${today}-imported.md`);
        fs.writeFileSync(targetPath, content, 'utf8');
        this._showMessage('success', '✅ 历史记录已导入');
      } catch (e) {
        this._showMessage('error', '❌ 导入失败: ' + e.message);
      }
    }
  }

  // ==================== 原有功能 ====================

  resolveWebviewView(webviewView) {
    console.log("[Alone模式] resolveWebviewView 被调用");
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri]
    };

    webviewView.webview.html = this._getHtml();

    // 处理来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("[Alone模式] 收到消息:", message.type);

      try {
        switch (message.type) {
          case "init":
            await this._loadUserData();
            break;
          case "setupNiuma":
            await this._setupNiuma();
            break;
          case "toggleNiuma":
            await this._toggleNiuma(message.enabled);
            break;
          case "cleanupNiuma":
            await this._cleanupNiuma();
            break;
          case "forcePopup":
            await this._forcePopup();
            break;
          case "openPrefixManager":
            this._showPrefixManagerPanel();
            break;
          case "openPromptLibrary":
            this._showPromptLibraryPanel();
            break;
          case "openExportImport":
            this._showExportImportPanel();
            break;
          case "resetStats":
            this._resetStats(message.target);
            break;
          case "selectCustomSound":
            this._selectCustomSound();
            break;
          case "clearCustomSound":
            this._clearCustomSound();
            break;
          case "testSound":
            this._playNotificationSound();
            break;
          case "copyText":
            await vscode.env.clipboard.writeText(message.text);
            this._showMessage("success", "✅ 已复制到剪贴板");
            break;
          case "openURL":
            if (message.url) {
              vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            break;
          case "getStats":
            this._updateSidebarStats();
            break;
          case "showHistory":
            await this._showHistoryPanel();
            break;
          case "exportHistory":
            await this._exportHistory();
            break;
          case "importHistory":
            await this._importHistory();
            break;
          case "toggleHistory":
            await this._toggleHistoryStorage(message.enabled);
            break;
          case "saveAiOptimizerConfig":
            this._aiOptimizerConfig = { ...this._aiOptimizerConfig, ...message.config };
            this._saveAiOptimizerConfig();
            break;
          case "updateAiOptimizerConfig":
            this._aiOptimizerConfig = { ...this._aiOptimizerConfig, ...message.config };
            this._saveAiOptimizerConfig();
            break;
        }
      } catch (error) {
        console.error("[Alone模式] 处理消息出错:", error);
        this._showMessage("error", "❌ " + error.message);
      }
    });

    this._loadUserData();
  }

  // 加载用户数据（免费版：直接显示主界面）
  async _loadUserData() {
    try {
      const niumaDir = path.join(os.homedir(), ".alone-mcp");
      const enabledFile = path.join(niumaDir, "enabled.txt");

      let isEnabled = true;
      if (fs.existsSync(enabledFile)) {
        isEnabled = fs.readFileSync(enabledFile, "utf8").trim() !== "0";
      }

      // 免费版：无需 CDK 验证，直接显示主界面
      this._sendToWebview("updateData", {
        loggedIn: true,
        enabled: isEnabled,
        historyEnabled: this._historyEnabled,
        mcpPort: this._mcpPort,
        stats: this._stats,
        aiOptimizerConfig: this._aiOptimizerConfig
      });
    } catch (error) {
      console.error("[Alone模式] 加载数据失败:", error);
      this._sendToWebview("updateData", {
        loggedIn: true,
        mcpPort: this._mcpPort,
        stats: this._stats
      });
    }
  }

  // 配置Alone模式
  async _setupNiuma() {
    try {
      this._showMessage("info", "正在配置Alone模式...");
      
      // 确保 MCP Server 已启动
      await this.startMcpServer();
      
      this._showMessage("success", `✅ 配置完成！MCP Server 端口: ${this._mcpPort}`);
      
      vscode.window.showInformationMessage(
        "Alone模式配置完成！请重启 Windsurf 使 MCP 配置生效。",
        "重启 Windsurf"
      ).then(selection => {
        if (selection === "重启 Windsurf") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
      
    } catch (error) {
      console.error("[Alone模式] 配置失败:", error);
      this._showMessage("error", "❌ 配置失败: " + error.message);
    }
  }

  // 切换开关
  async _toggleNiuma(enabled) {
    try {
      const niumaDir = path.join(os.homedir(), ".alone-mcp");
      const enabledFile = path.join(niumaDir, "enabled.txt");
      
      if (!fs.existsSync(niumaDir)) {
        fs.mkdirSync(niumaDir, { recursive: true });
      }
      
      fs.writeFileSync(enabledFile, enabled ? "1" : "0", "utf8");
      this._showMessage("success", enabled ? "✅ Alone模式已开启" : "⏹️ Alone模式已关闭");
    } catch (error) {
      this._showMessage("error", "❌ 切换失败: " + error.message);
    }
  }

  // 切换历史存储
  async _toggleHistoryStorage(enabled) {
    try {
      const niumaDir = path.join(os.homedir(), ".alone-mcp");
      const historyEnabledFile = path.join(niumaDir, "history_enabled.txt");
      
      if (!fs.existsSync(niumaDir)) {
        fs.mkdirSync(niumaDir, { recursive: true });
      }
      
      fs.writeFileSync(historyEnabledFile, enabled ? "1" : "0", "utf8");
      this._historyEnabled = enabled;
      this._showMessage("success", enabled ? "✅ 上下文存储已开启" : "⏹️ 上下文存储已关闭");
    } catch (error) {
      this._showMessage("error", "❌ 切换失败: " + error.message);
    }
  }

  // 清理配置
  async _cleanupNiuma() {
    try {
      // 清理 MCP 配置
      const configPaths = [
        path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
        path.join(process.env.APPDATA || '', 'Windsurf', 'User', 'globalStorage', 'codeium.windsurf', 'mcp_config.json')
      ];
      
      for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.mcpServers) {
              // 删除Alone模式相关配置
              for (const key of Object.keys(config.mcpServers)) {
                if (key.includes('infinite-dialog') || key.includes('cunzhi')) {
                  delete config.mcpServers[key];
                }
              }
              fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
            }
          } catch {}
        }
      }
      
      this._showMessage("success", "✅ 清理完成");
    } catch (error) {
      this._showMessage("error", "❌ 清理失败: " + error.message);
    }
  }

  // 强制弹窗
  async _forcePopup() {
    this._showMessage("info", "正在触发强制弹窗...");
    const result = await this._collectFeedback("用户手动触发的强制弹窗", 0);
    
    if (result.action === 'continue') {
      this._showMessage("success", "✅ 用户选择继续");
    } else {
      this._showMessage("info", "用户选择结束");
    }
  }

  // ==================== 管理面板（从 ask-continue 移植） ====================

  // 显示前缀管理面板
  _showPrefixManagerPanel() {
    const panel = vscode.window.createWebviewPanel('prefixManager', '⚙️ 快捷前缀管理', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = this._getPrefixManagerHtml();
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'savePrefixList':
          this._prefixList = message.prefixList || [];
          this._savePrefixAndPromptData();
          this._showMessage("success", `前缀已保存 (${this._prefixList.length}个)`);
          panel.dispose();
          break;
        case 'cancel':
          panel.dispose();
          break;
      }
    });
  }

  _getPrefixManagerHtml() {
    const prefixJson = JSON.stringify(this._prefixList);
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}
.title{font-size:18px;font-weight:600;margin-bottom:15px;}
.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:15px;}
.prefix-list{max-height:300px;overflow-y:auto;margin-bottom:15px;}
.prefix-item{display:flex;align-items:center;gap:8px;padding:8px;background:var(--vscode-input-background);border-radius:4px;margin-bottom:6px;}
.prefix-item input[type="text"]{flex:1;padding:6px;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;}
.prefix-item input[type="checkbox"]{width:16px;height:16px;}
.btn{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
.btn-primary{background:#3794ff;color:white;}
.btn-danger{background:#f14c4c;color:white;}
.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:15px;}
.add-row{display:flex;gap:8px;margin-bottom:15px;}
.add-row input{flex:1;padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;}
</style></head><body>
<div class="title">⚙️ 快捷前缀管理</div>
<div class="hint">管理常用前缀，在弹窗中快速添加到输入内容</div>
<div class="add-row">
  <input type="text" id="newPrefix" placeholder="输入新前缀...">
  <button class="btn btn-primary" onclick="addPrefix()">添加</button>
</div>
<div class="prefix-list" id="prefixList"></div>
<div class="actions">
  <button class="btn btn-secondary" onclick="cancel()">取消</button>
  <button class="btn btn-primary" onclick="save()">保存并关闭</button>
</div>
<script>
const vscode = acquireVsCodeApi();
let prefixes = ${prefixJson};
function render() {
  const container = document.getElementById('prefixList');
  if (prefixes.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--vscode-descriptionForeground);padding:20px;">暂无前缀，请添加</div>';
    return;
  }
  container.innerHTML = prefixes.map((p, i) => \`
    <div class="prefix-item">
      <input type="checkbox" \${p.enabled !== false ? 'checked' : ''} onchange="togglePrefix(\${i})">
      <input type="text" value="\${p.text || ''}" onchange="updatePrefix(\${i}, this.value)">
      <button class="btn btn-danger" style="padding:4px 8px;" onclick="deletePrefix(\${i})">删除</button>
    </div>
  \`).join('');
}
function addPrefix() {
  const input = document.getElementById('newPrefix');
  if (input.value.trim()) {
    prefixes.push({ text: input.value.trim(), enabled: true });
    input.value = '';
    render();
  }
}
function togglePrefix(i) { prefixes[i].enabled = !prefixes[i].enabled; }
function updatePrefix(i, val) { prefixes[i].text = val; }
function deletePrefix(i) { prefixes.splice(i, 1); render(); }
function save() { vscode.postMessage({ command: 'savePrefixList', prefixList: prefixes }); }
function cancel() { vscode.postMessage({ command: 'cancel' }); }
render();
</script></body></html>`;
  }

  // 显示提示词库面板
  _showPromptLibraryPanel() {
    const panel = vscode.window.createWebviewPanel('promptLibrary', '📚 提示词库', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = this._getPromptLibraryHtml();
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'savePromptData':
          this._promptCategories = message.categories || [];
          this._promptItems = message.prompts || [];
          this._savePrefixAndPromptData();
          this._showMessage("success", `提示词已保存 (${this._promptItems.length}个)`);
          panel.dispose();
          break;
        case 'cancel':
          panel.dispose();
          break;
      }
    });
  }

  _getPromptLibraryHtml() {
    const categoriesJson = JSON.stringify(this._promptCategories);
    const promptsJson = JSON.stringify(this._promptItems);
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}
.title{font-size:18px;font-weight:600;margin-bottom:15px;}
.section{background:var(--vscode-input-background);border-radius:8px;padding:15px;margin-bottom:15px;}
.btn{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
.btn-sm{padding:4px 8px;font-size:11px;}
.btn-primary{background:#3794ff;color:white;}
.btn-danger{background:#f14c4c;color:white;}
.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:15px;}
.add-row{display:flex;gap:8px;margin-bottom:10px;}
.add-row input,.add-row textarea,.add-row select{flex:1;padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;}
.add-row textarea{min-height:60px;resize:vertical;}
.prompt-item{display:flex;align-items:center;gap:8px;padding:8px;background:var(--vscode-editor-background);border-radius:4px;margin-bottom:6px;}
.prompt-title{font-weight:500;flex:1;}
.prompt-content{font-size:11px;color:var(--vscode-descriptionForeground);flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
</style></head><body>
<div class="title">📚 提示词库</div>
<div class="section">
  <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><strong>添加提示词</strong></div>
  <div class="add-row"><input type="text" id="newTitle" placeholder="标题"><select id="newCategory"><option value="">未分类</option></select></div>
  <div class="add-row"><textarea id="newContent" placeholder="提示词内容..."></textarea></div>
  <button class="btn btn-primary" onclick="addPrompt()">添加</button>
</div>
<div class="section"><strong>提示词列表</strong><div id="promptList" style="margin-top:10px;max-height:200px;overflow-y:auto;"></div></div>
<div class="actions">
  <button class="btn btn-secondary" onclick="cancel()">取消</button>
  <button class="btn btn-primary" onclick="save()">保存并关闭</button>
</div>
<script>
const vscode = acquireVsCodeApi();
let categories = ${categoriesJson};
let prompts = ${promptsJson};
function render() {
  const container = document.getElementById('promptList');
  if (prompts.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--vscode-descriptionForeground);padding:10px;">暂无提示词</div>';
    return;
  }
  container.innerHTML = prompts.map((p, i) => \`
    <div class="prompt-item">
      <span class="prompt-title">\${p.title}</span>
      <span class="prompt-content">\${(p.content||'').substring(0,30)}...</span>
      <button class="btn btn-sm btn-danger" onclick="deletePrompt(\${i})">删除</button>
    </div>
  \`).join('');
}
function addPrompt() {
  const title = document.getElementById('newTitle').value.trim();
  const content = document.getElementById('newContent').value.trim();
  const categoryId = document.getElementById('newCategory').value;
  if (title && content) {
    prompts.push({ id: Date.now().toString(), title, content, categoryId, createdAt: Date.now() });
    document.getElementById('newTitle').value = '';
    document.getElementById('newContent').value = '';
    render();
  }
}
function deletePrompt(i) { prompts.splice(i, 1); render(); }
function save() { vscode.postMessage({ command: 'savePromptData', categories, prompts }); }
function cancel() { vscode.postMessage({ command: 'cancel' }); }
render();
</script></body></html>`;
  }

  // 显示导入/导出面板
  _showExportImportPanel() {
    const panel = vscode.window.createWebviewPanel('exportImport', '📦 导入/导出', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = this._getExportImportHtml();
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'export':
          const exportData = {
            version: '1.0',
            prefixList: message.includePrefixes ? this._prefixList : [],
            categories: message.includeCategories ? this._promptCategories : [],
            prompts: message.includePrompts ? this._promptItems : []
          };
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('niuma-data.json'),
            filters: { 'JSON': ['json'] }
          });
          if (saveUri) {
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(exportData, null, 2));
            this._showMessage("success", `数据已导出到 ${saveUri.fsPath}`);
          }
          break;
        case 'import':
          const openUri = await vscode.window.showOpenDialog({
            filters: { 'JSON': ['json'] },
            canSelectMany: false
          });
          if (openUri && openUri[0]) {
            try {
              const data = JSON.parse(fs.readFileSync(openUri[0].fsPath, 'utf-8'));
              if (data.prefixList) {
                this._prefixList = [...this._prefixList, ...data.prefixList.filter(p => !this._prefixList.find(e => e.text === p.text))];
              }
              if (data.categories) {
                this._promptCategories = [...this._promptCategories, ...data.categories.filter(c => !this._promptCategories.find(e => e.name === c.name))];
              }
              if (data.prompts) {
                this._promptItems = [...this._promptItems, ...data.prompts.filter(p => !this._promptItems.find(e => e.title === p.title))];
              }
              this._savePrefixAndPromptData();
              this._showMessage("success", `数据已导入！前缀: ${data.prefixList?.length || 0}, 提示词: ${data.prompts?.length || 0}`);
              panel.dispose();
            } catch (e) {
              this._showMessage("error", '导入失败：文件格式错误');
            }
          }
          break;
        case 'cancel':
          panel.dispose();
          break;
      }
    });
  }

  _getExportImportHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}
.title{font-size:18px;font-weight:600;margin-bottom:20px;}
.section{background:var(--vscode-input-background);border-radius:8px;padding:15px;margin-bottom:15px;}
.section-title{font-weight:500;margin-bottom:10px;}
.checkbox-item{display:flex;align-items:center;margin-bottom:8px;}
.checkbox-item input{margin-right:8px;}
.btn{padding:10px 20px;border:none;border-radius:4px;cursor:pointer;font-size:14px;width:100%;margin-bottom:8px;}
.btn-primary{background:#3794ff;color:white;}
.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
.stats{font-size:12px;color:var(--vscode-descriptionForeground);}
</style></head><body>
<div class="title">📦 导入/导出</div>
<div class="section">
  <div class="section-title">📤 导出数据</div>
  <div class="stats">当前数据: 快捷前缀 ${this._prefixList.length}个, 提示词 ${this._promptItems.length}个</div>
  <div style="margin:10px 0;">
    <label class="checkbox-item"><input type="checkbox" id="exportPrefixes" checked> 快捷前缀</label>
    <label class="checkbox-item"><input type="checkbox" id="exportPrompts" checked> 提示词</label>
  </div>
  <button class="btn btn-primary" onclick="exportData()">📤 导出到文件</button>
</div>
<div class="section">
  <div class="section-title">📥 导入数据</div>
  <button class="btn btn-secondary" onclick="importData()">📥 从文件导入</button>
</div>
<button class="btn btn-secondary" onclick="cancel()" style="margin-top:10px;">关闭</button>
<script>
const vscode = acquireVsCodeApi();
function exportData() {
  vscode.postMessage({
    command: 'export',
    includePrefixes: document.getElementById('exportPrefixes').checked,
    includePrompts: document.getElementById('exportPrompts').checked
  });
}
function importData() { vscode.postMessage({ command: 'import' }); }
function cancel() { vscode.postMessage({ command: 'cancel' }); }
</script></body></html>`;
  }

  // 快捷键手动触发反馈弹窗 (Ctrl+Shift+M)
  async _manualFeedback() {
    // 获取剪贴板内容作为 AI 摘要
    let summary = '';
    try {
      summary = await vscode.env.clipboard.readText();
      if (summary && summary.length > 500) {
        summary = summary.substring(0, 500) + '...';
      }
    } catch (e) {}
    
    if (!summary) {
      summary = '请在此输入 AI 的工作摘要，或先复制 AI 回复再按快捷键';
    }
    
    const result = await this._collectFeedback(summary, this._currentSessionCalls);
    
    if (result.action === 'continue' && result.feedback) {
      // 将用户反馈复制到剪贴板，方便粘贴给 AI
      await vscode.env.clipboard.writeText(result.feedback);
      this._showMessage("success", "✅ 反馈已复制到剪贴板，可粘贴给 AI");
    } else if (result.action === 'end') {
      this._showMessage("info", "对话已结束");
    }
  }

  // 发送消息到 Webview
  _sendToWebview(type, data) {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type, ...data });
    }
  }

  // 显示消息
  _showMessage(type, message) {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type: "showToast", toastType: type, message });
    }
  }

  // 获取侧边栏 HTML
  _getHtml() {
    const htmlPath = path.join(this._context.extensionPath, "webview.html");
    return fs.readFileSync(htmlPath, "utf8");
  }

  // 停止 MCP Server
  stopMcpServer() {
    if (this._mcpServer) {
      this._mcpServer.close(() => {
        console.log("[Alone模式] MCP Server 已停止");
      });
      this._mcpServer = null;
    }
  }

  // 释放资源
  dispose() {
    this.stopMcpServer();
    if (this._dialogPanel) {
      this._dialogPanel.dispose();
      this._dialogPanel = null;
    }
    if (this._output) {
      this._output.dispose();
    }
  }
}

// 激活扩展
function activate(context) {
  console.log("[Alone模式] ========================================");
  console.log("[Alone模式] 🚀 Alone模式扩展开始激活 (v3.0 - 免费开源版)");

  try {
    const panel = new NiumaPanel(context);

    const provider = vscode.window.registerWebviewViewProvider(
      "alone.mainPanel",
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    );

    context.subscriptions.push(provider);

    // 监听工作区变化，自动创建规则文件
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      panel._ensureWindsurfRules();
    });

    console.log("[Alone模式] 规则文件已创建/更新");

    // 注册命令
    context.subscriptions.push(
      vscode.commands.registerCommand("alone.showPanel", () => {
        vscode.commands.executeCommand("workbench.view.extension.alone-panel");
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("alone.quickSetup", async () => {
        await panel._setupNiuma();
      })
    );

    // 快捷键触发反馈弹窗 (Ctrl+Shift+M)
    context.subscriptions.push(
      vscode.commands.registerCommand("alone.feedback", async () => {
        await panel._manualFeedback();
      })
    );

    // 清理时释放资源
    context.subscriptions.push({
      dispose: () => panel.dispose()
    });

    console.log("[Alone模式] ✅ 扩展激活完成");
  } catch (error) {
    console.error("[Alone模式] ❌ 激活失败:", error);
  }
}

function deactivate() {
  console.log("[Alone模式] 扩展已停用");
}

module.exports = {
  activate,
  deactivate
};
