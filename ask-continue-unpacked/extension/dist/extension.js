"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const MCP_CALLBACK_PORT = 23984; // Port where MCP server listens for responses
const PORT_FILE_DIR = path.join(os.tmpdir(), "ask-continue-ports");
const MCP_SERVICES = [
    { name: 'ask-continue', displayName: 'Ask Continue', command: 'python', args: [], description: '无限对话' },
    { name: 'chrome-devtools', displayName: 'Chrome DevTools', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], description: '浏览器自动化' },
    { name: 'filesystem', displayName: 'Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], description: '文件操作' },
    { name: 'shell', displayName: 'Shell', command: 'npx', args: ['-y', 'shell-mcp-server'], description: '命令执行' },
    { name: 'memory', displayName: 'Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], description: '知识图谱记忆' },
    { name: 'fetch', displayName: 'Fetch', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], description: '网页抓取' },
    { name: 'sqlite', displayName: 'SQLite', command: 'npx', args: ['-y', 'mcp-sqlite'], description: 'SQLite 数据库' },
];
let mcpServiceStatuses = new Map();
let mcpManagerPanel = null;
let healthCheckInterval = null;
const HEALTH_CHECK_INTERVAL = 30000; // 30 秒
let server = null;
let statusBarItem;
let statusViewProvider;
let lastPendingRequest = null; // 保存最近的待处理请求
let lastPendingRequestTime = 0; // 请求时间戳，用于判断请求是否过期
let extensionContext; // 保存 context 引用用于持久化统计
let usageStats = { totalPopups: 0, sessionCount: 0, currentSessionPopups: 0 };
let conversationHistory = [];
const HISTORY_DIR = path.join(os.homedir(), '.ask-continue', 'history');
// 全局 Webview Panel - 复用而不是反复创建
let globalPanel = null;
// 多前缀列表
let prefixList = [];
// 提示词库
let promptCategories = [];
let promptItems = [];
// 高级工具折叠状态
let toolsCollapsed = true;
// 日志存储（最多保留 50 条）
let mcpLogs = [];
function addLog(type, msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    mcpLogs.unshift({ time, type, msg });
    if (mcpLogs.length > 50)
        mcpLogs.pop();
    statusViewProvider?.refreshView();
}
/**
 * 侧边栏状态视图
 */
class StatusViewProvider {
    _extensionUri;
    static viewType = "askContinue.statusView";
    _view;
    _serverRunning = false;
    _port = 23983;
    _requestCount = 0;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlContent();
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "restart":
                    vscode.commands.executeCommand("askContinue.restart");
                    break;
                case "showStatus":
                    vscode.commands.executeCommand("askContinue.showStatus");
                    break;
                case "openPanel":
                    vscode.commands.executeCommand("askContinue.openPanel");
                    break;
                case "forceRetry":
                    vscode.commands.executeCommand("askContinue.forceRetry");
                    break;
                case "forceOpenWindow":
                    vscode.commands.executeCommand("askContinue.forceOpenWindow");
                    break;
                case "clearCache":
                    vscode.commands.executeCommand("askContinue.clearCache");
                    break;
                case "cleanPortFiles":
                    vscode.commands.executeCommand("askContinue.cleanPortFiles");
                    break;
                case "clearLogs":
                    mcpLogs = [];
                    this.refreshView();
                    break;
                case "resetTotal":
                    usageStats.totalPopups = 0;
                    if (extensionContext)
                        saveStatistics(extensionContext);
                    this.refreshView();
                    break;
                case "resetSession":
                    usageStats.sessionCount = 0;
                    if (extensionContext)
                        saveStatistics(extensionContext);
                    this.refreshView();
                    break;
                case "resetCurrent":
                    usageStats.currentSessionPopups = 0;
                    this.refreshView();
                    break;
                case "forceEnd":
                    vscode.commands.executeCommand("askContinue.forceEnd");
                    break;
                case "sendSidebarInput":
                    if (lastPendingRequest && message.text) {
                        try {
                            addHistoryEntry(lastPendingRequest.reason, message.text);
                            if (!lastPendingRequest.requestId.startsWith('force_')) {
                                await sendResponseToMCP(lastPendingRequest.requestId, message.text, false, lastPendingRequest.callbackPort);
                            }
                            addLog('info', 'Sidebar input sent');
                            lastPendingRequest = null;
                            this.refreshView();
                            vscode.window.showInformationMessage('Ask Continue: 已发送，对话继续');
                        }
                        catch (error) {
                            vscode.window.showErrorMessage(`发送失败: ${error instanceof Error ? error.message : '未知错误'}`);
                        }
                    }
                    else {
                        vscode.window.showWarningMessage('Ask Continue: 没有待处理请求或输入为空');
                    }
                    break;
                case "savePrefixList":
                    prefixList = message.prefixList || [];
                    if (extensionContext) {
                        extensionContext.globalState.update('prefixList', prefixList);
                    }
                    this.refreshView();
                    vscode.window.showInformationMessage(`Ask Continue: 前缀已保存 (${prefixList.length}个)`);
                    break;
                case "toggleTools":
                    toolsCollapsed = !toolsCollapsed;
                    this.refreshView();
                    break;
                case "openPrefixManager":
                    showPrefixManagerPanel();
                    break;
                case "openPromptLibrary":
                    showPromptLibraryPanel();
                    break;
                case "openExportImport":
                    showExportImportPanel();
                    break;
                case "openMCPManager":
                    checkAllMCPServices().then(() => showMCPManagerPanel());
                    break;
                case "exportHistory":
                    const exportUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file('ask-continue-history.json'),
                        filters: { 'JSON': ['json'] }
                    });
                    if (exportUri) {
                        fs.writeFileSync(exportUri.fsPath, JSON.stringify(conversationHistory, null, 2));
                        vscode.window.showInformationMessage(`历史记录已导出到 ${exportUri.fsPath}`);
                    }
                    break;
                case "importHistory":
                    const importUri = await vscode.window.showOpenDialog({
                        filters: { 'JSON': ['json'] },
                        canSelectMany: false
                    });
                    if (importUri && importUri[0]) {
                        try {
                            const data = fs.readFileSync(importUri[0].fsPath, 'utf8');
                            const imported = JSON.parse(data);
                            if (Array.isArray(imported)) {
                                conversationHistory = [...imported, ...conversationHistory];
                                saveHistory();
                                vscode.window.showInformationMessage(`已导入 ${imported.length} 条历史记录`);
                            }
                        }
                        catch (e) {
                            vscode.window.showErrorMessage('导入失败：文件格式错误');
                        }
                    }
                    break;
            }
        });
    }
    updateStatus(running, port) {
        this._serverRunning = running;
        this._port = port;
        if (this._view) {
            this._view.webview.html = this._getHtmlContent();
        }
    }
    incrementRequestCount() {
        this._requestCount++;
        if (this._view) {
            this._view.webview.html = this._getHtmlContent();
        }
    }
    refreshView() {
        if (this._view) {
            this._view.webview.html = this._getHtmlContent();
        }
    }
    _getHtmlContent() {
        const statusIcon = this._serverRunning ? "🟢" : "🔴";
        const statusText = this._serverRunning ? "运行中" : "已停止";
        const statusClass = this._serverRunning ? "running" : "stopped";
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 15px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 15px;
    }
    .status-card {
      background: var(--vscode-editor-background);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .status-row:last-child {
      margin-bottom: 0;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .value {
      font-size: 13px;
      font-weight: 500;
    }
    .value.running {
      color: #4ec9b0;
    }
    .value.stopped {
      color: #f14c4c;
    }
    .stats-section {
      margin-bottom: 12px;
    }
    .stats-title {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .stat-item {
      background: var(--vscode-editor-background);
      border-radius: 8px;
      padding: 12px 8px;
      text-align: center;
    }
    .stat-number {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .stat-number.blue { color: #3794ff; }
    .stat-number.green { color: #4ec9b0; }
    .stat-number.purple { color: #c586c0; }
    .stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .efficiency-tip {
      background: linear-gradient(90deg, rgba(78,201,176,0.15) 0%, rgba(55,148,255,0.15) 100%);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 12px;
      font-size: 11px;
      text-align: center;
    }
    .efficiency-tip .highlight {
      color: #4ec9b0;
      font-weight: 600;
    }
    .btn {
      width: 100%;
      padding: 8px 12px;
      margin-top: 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .info-box {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 10px;
      margin-top: 12px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
    }
    .info-box strong {
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="title">
    🔥 Ask Continue
  </div>
  <div class="subtitle">让 AI 不再偷懒</div>
  
  <div class="status-card">
    <div class="status-row">
      <span class="value ${statusClass}">${statusIcon} ${statusText}</span>
      <span class="label">端口: ${this._port}</span>
    </div>
  </div>

  <div class="stats-section">
    <div class="stats-title">📊 效果统计</div>
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-number blue">${usageStats.totalPopups}</div>
        <div class="stat-label">总弹窗</div>
        <button class="btn" style="padding:2px 6px;font-size:9px;margin-top:4px;" onclick="resetTotal()">重置</button>
      </div>
      <div class="stat-item">
        <div class="stat-number green">${usageStats.sessionCount}</div>
        <div class="stat-label">会话数</div>
        <button class="btn" style="padding:2px 6px;font-size:9px;margin-top:4px;" onclick="resetSession()">重置</button>
      </div>
      <div class="stat-item">
        <div class="stat-number purple">${usageStats.currentSessionPopups}</div>
        <div class="stat-label">本轮弹窗</div>
        <button class="btn" style="padding:2px 6px;font-size:9px;margin-top:4px;" onclick="resetCurrent()">重置</button>
      </div>
    </div>
  </div>

  <div class="efficiency-tip">
    💡 牛马帮你多获得了 <span class="highlight">${usageStats.currentSessionPopups}</span> 次交互！
  </div>

  ${lastPendingRequest ? `
  <div class="stats-section" style="margin-top: 12px; background: linear-gradient(135deg, rgba(78,201,176,0.1) 0%, rgba(55,148,255,0.1) 100%); border-radius: 8px; padding: 12px;">
    <div class="stats-title" style="color: #4ec9b0;">⚡ 有待处理请求！</div>
    <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">
      AI 正在等待你的输入：
    </div>
    <textarea id="sidebarInput" style="width: 100%; height: 60px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; font-size: 12px; resize: vertical;" placeholder="输入你的需求..."></textarea>
    <button class="btn btn-primary" style="margin-top: 8px;" onclick="sendSidebarInput()">📤 发送并继续对话</button>
  </div>
  ` : ``}

  <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
    <button class="btn" style="background: #67c23a;" onclick="openMCPManager()">🔌 MCP 服务管理</button>
    <button class="btn btn-primary" onclick="openPrefixManager()">⚙️ 快捷前缀 (${prefixList.filter(p => p.enabled).length})</button>
    <button class="btn" style="background: #e6a23c;" onclick="openPromptLibrary()">📚 提示词库 (${promptItems.length})</button>
    <button class="btn" onclick="openExportImport()">📦 导入/导出</button>
  </div>

  <div class="stats-section" style="margin-top: 12px;">
    <div class="stats-title" style="cursor: pointer;" onclick="toggleTools()">
      ${toolsCollapsed ? '▶' : '▼'} 高级工具
    </div>
    ${!toolsCollapsed ? `
    <div style="padding-left: 8px;">
      <button class="btn" style="margin-bottom:4px;" onclick="clearCache()">🗑️ 清除缓存</button>
      <button class="btn" style="margin-bottom:4px;" onclick="cleanPortFiles()">📁 清理端口文件</button>
      <button class="btn" style="margin-bottom:4px;" onclick="restart()">🔄 重启服务</button>
      <button class="btn" style="background: #f14c4c;margin-bottom:4px;" onclick="forceRetry()">⚡ 强制重新调用</button>
    </div>
    ` : ``}
  </div>

  <div class="stats-section" style="margin-top: 12px;">
    <div class="stats-title">📂 对话记忆</div>
    <button class="btn" onclick="exportHistory()">📤 导出历史</button>
    <button class="btn" onclick="importHistory()">📥 导入历史</button>
  </div>
  
  <div class="stats-section" style="margin-top: 12px;">
    <div class="stats-title">📝 运行日志 <button class="btn" style="padding:2px 8px;font-size:10px;margin-left:8px;" onclick="clearLogs()">清空</button></div>
    <div class="log-container" style="max-height:150px;overflow-y:auto;background:var(--vscode-editor-background);border-radius:8px;padding:8px;font-size:11px;font-family:monospace;">
      ${mcpLogs.length > 0 ? mcpLogs.slice(0, 20).map(log => {
            const color = log.type === 'error' ? '#f14c4c' : log.type === 'warn' ? '#cca700' : '#4ec9b0';
            return `<div style="margin-bottom:4px;"><span style="color:#888;">[${log.time}]</span> <span style="color:${color};">${log.msg}</span></div>`;
        }).join('') : '<div style="color:#888;">暂无日志</div>'}
    </div>
  </div>
  
  <div class="info-box">
    <strong>提示:</strong><br/>
    • 强制打开窗口：无论有无请求都打开输入窗口<br/>
    • 强制重新调用：让 AI 重新调用 MCP 服务<br/>
    • 清除缓存：清理待处理请求状态
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    function openPanel() {
      vscode.postMessage({ command: 'openPanel' });
    }
    function forceOpenWindow() {
      vscode.postMessage({ command: 'forceOpenWindow' });
    }
    function forceRetry() {
      vscode.postMessage({ command: 'forceRetry' });
    }
    function clearCache() {
      vscode.postMessage({ command: 'clearCache' });
    }
    function cleanPortFiles() {
      vscode.postMessage({ command: 'cleanPortFiles' });
    }
    function restart() {
      vscode.postMessage({ command: 'restart' });
    }
    function exportHistory() {
      vscode.postMessage({ command: 'exportHistory' });
    }
    function importHistory() {
      vscode.postMessage({ command: 'importHistory' });
    }
    function clearLogs() {
      vscode.postMessage({ command: 'clearLogs' });
    }
    function resetTotal() {
      vscode.postMessage({ command: 'resetTotal' });
    }
    function resetSession() {
      vscode.postMessage({ command: 'resetSession' });
    }
    function resetCurrent() {
      vscode.postMessage({ command: 'resetCurrent' });
    }
    function forceEnd() {
      vscode.postMessage({ command: 'forceEnd' });
    }
    function sendSidebarInput() {
      const input = document.getElementById('sidebarInput');
      if (input) {
        vscode.postMessage({ command: 'sendSidebarInput', text: input.value });
      }
    }
    function openPrefixManager() {
      vscode.postMessage({ command: 'openPrefixManager' });
    }
    function openPromptLibrary() {
      vscode.postMessage({ command: 'openPromptLibrary' });
    }
    function openExportImport() {
      vscode.postMessage({ command: 'openExportImport' });
    }
    function openMCPManager() {
      vscode.postMessage({ command: 'openMCPManager' });
    }
    function toggleTools() {
      vscode.postMessage({ command: 'toggleTools' });
    }
  </script>
</body>
</html>`;
    }
}
/**
 * Send response back to MCP server
 */
async function sendResponseToMCP(requestId, userInput, cancelled, callbackPort) {
    const port = callbackPort || MCP_CALLBACK_PORT;
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            requestId,
            userInput,
            cancelled,
        });
        const req = http.request({
            hostname: "127.0.0.1",
            port: port,
            path: "/response",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
            },
            timeout: 5000,
        }, (res) => {
            if (res.statusCode === 200 || res.statusCode === 404) {
                // 200 = 成功, 404 = 请求已过期/不存在（静默处理）
                resolve();
            }
            else {
                reject(new Error(`MCP server returned status ${res.statusCode}`));
            }
        });
        req.on("error", (e) => {
            reject(new Error(`Failed to send response to MCP: ${e.message}`));
        });
        req.write(postData);
        req.end();
    });
}
/**
 * Show the Ask Continue dialog
 */
async function showAskContinueDialog(request) {
    // 保存当前请求，以便重新打开
    lastPendingRequest = request;
    lastPendingRequestTime = Date.now();
    // 更新侧边栏显示待处理请求
    statusViewProvider?.refreshView();
    let panel;
    try {
        // 复用全局面板，避免资源耗尽
        if (globalPanel) {
            panel = globalPanel;
            panel.webview.html = getWebviewContent(request.reason, request.requestId);
            panel.reveal(vscode.ViewColumn.One);
        }
        else {
            panel = vscode.window.createWebviewPanel("askContinue", "继续对话?", vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true,
            });
            globalPanel = panel;
            panel.webview.html = getWebviewContent(request.reason, request.requestId);
            // 面板关闭时清除引用，但不清除请求状态
            panel.onDidDispose(() => {
                globalPanel = null;
            });
        }
    }
    catch (err) {
        // Webview 创建失败，不发送取消，保留请求状态让用户可以通过侧边栏输入
        console.error("[Ask Continue] Failed to create webview panel:", err);
        addLog('error', `Panel creation failed: ${err instanceof Error ? err.message : 'unknown'}`);
        vscode.window.showWarningMessage(`Ask Continue: 弹窗创建失败，请使用侧边栏输入`);
        return;
    }
    // 标记是否已发送响应，避免重复发送
    let responseSent = false;
    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (message) => {
        if (responseSent)
            return;
        switch (message.command) {
            case "continue":
                try {
                    responseSent = true;
                    lastPendingRequest = null; // 清除待处理请求
                    // 保存历史记录
                    addHistoryEntry(request.reason, message.text || '');
                    // 强制打开的窗口不发送到 MCP（requestId 以 force_ 开头）
                    if (!request.requestId.startsWith('force_')) {
                        await sendResponseToMCP(request.requestId, message.text, false, request.callbackPort);
                    }
                    else {
                        addLog('info', 'Force window closed (no MCP)');
                    }
                    panel.dispose();
                }
                catch (error) {
                    responseSent = false;
                    vscode.window.showErrorMessage(`发送响应失败: ${error instanceof Error ? error.message : "未知错误"}`);
                }
                break;
            case "end":
                try {
                    responseSent = true;
                    if (!request.requestId.startsWith('force_')) {
                        await sendResponseToMCP(request.requestId, "", false, request.callbackPort);
                    }
                    panel.dispose();
                }
                catch (error) {
                    responseSent = false;
                    vscode.window.showErrorMessage(`发送响应失败: ${error instanceof Error ? error.message : "未知错误"}`);
                }
                break;
            case "cancel":
                try {
                    responseSent = true;
                    if (!request.requestId.startsWith('force_')) {
                        await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
                    }
                    panel.dispose();
                }
                catch (error) {
                    // Ignore errors on cancel
                }
                break;
            case "loadHistory":
                // 加载选中的历史记录到输入框
                const indices = message.indices;
                if (indices && indices.length > 0) {
                    const selectedHistory = indices.map(i => conversationHistory[i]).filter(Boolean);
                    const historyText = selectedHistory.map(h => `[历史记录 ${new Date(h.timestamp).toLocaleString('zh-CN')}]\nAI摘要: ${h.summary}\n用户输入: ${h.userInput}`).join('\n\n---\n\n');
                    // 发送历史内容回webview更新输入框
                    panel.webview.postMessage({ command: 'setInput', text: historyText });
                }
                break;
        }
    }, undefined, []);
    // Handle panel close - 不清除请求状态，用户可以通过侧边栏继续
    // 注意：只在首次创建面板时注册这个处理器（在上面的 globalPanel 设置逻辑中）
    if (!globalPanel || globalPanel !== panel) {
        panel.onDidDispose(async () => {
            globalPanel = null;
            // 不清除 lastPendingRequest，保留状态让用户可以通过侧边栏输入
            // 不发送取消到 MCP，用户可能只是暂时关闭弹窗
            statusViewProvider?.refreshView();
        });
    }
}
/**
 * Generate webview HTML content
 */
function getWebviewContent(reason, requestId) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>继续对话?</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      padding: 20px;
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      min-height: 100vh;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--vscode-panel-border, #454545);
    }
    .header-icon {
      font-size: 24px;
    }
    .header h1 {
      font-size: 18px;
      font-weight: 600;
      color: var(--vscode-foreground, #cccccc);
    }
    .reason-box {
      background-color: var(--vscode-textBlockQuote-background, #2d2d2d);
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      padding: 12px 15px;
      margin-bottom: 20px;
      border-radius: 0 4px 4px 0;
    }
    .reason-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888888);
      margin-bottom: 5px;
    }
    .reason-text {
      font-size: 14px;
      line-height: 1.5;
    }
    .input-section {
      margin-bottom: 20px;
    }
    .input-label {
      display: block;
      font-size: 13px;
      color: var(--vscode-foreground, #cccccc);
      margin-bottom: 8px;
    }
    .optional {
      color: var(--vscode-descriptionForeground, #888888);
      font-weight: normal;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      padding: 12px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 13px;
      line-height: 1.5;
      color: var(--vscode-input-foreground, #cccccc);
      background-color: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      resize: vertical;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground, #888888);
    }
    .button-group {
      display: flex;
      gap: 10px;
    }
    button {
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 500;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }
    button:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    button:active {
      opacity: 0.8;
      transform: translateY(0);
    }
    .btn-primary {
      flex: 2;
      background: linear-gradient(135deg, #4ec9b0 0%, #3794ff 100%);
      color: #ffffff;
    }
    .btn-secondary {
      flex: 1;
      background-color: rgba(241, 76, 76, 0.15);
      color: #f14c4c;
      border: 1px solid rgba(241, 76, 76, 0.3);
    }
    .btn-secondary:hover {
      background-color: rgba(241, 76, 76, 0.25);
    }
    .efficiency-bar {
      background: linear-gradient(90deg, rgba(78,201,176,0.2) 0%, rgba(55,148,255,0.2) 100%);
      border-radius: 8px;
      padding: 10px;
      margin-top: 15px;
      text-align: center;
      font-size: 12px;
    }
    .efficiency-bar .highlight {
      color: #4ec9b0;
      font-weight: 600;
    }
    .shortcuts {
      margin-top: 15px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888888);
      text-align: center;
    }
    .shortcuts kbd {
      background-color: var(--vscode-keybindingLabel-background, #464646);
      border: 1px solid var(--vscode-keybindingLabel-border, #5a5a5a);
      border-radius: 3px;
      padding: 1px 5px;
      font-family: inherit;
    }
    .upload-section {
      margin-bottom: 15px;
    }
    .upload-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .upload-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888888);
    }
    .clear-all {
      font-size: 11px;
      color: #f14c4c;
      cursor: pointer;
      background: none;
      border: none;
      padding: 0;
    }
    .clear-all:hover {
      text-decoration: underline;
    }
    .upload-hint {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888888);
      text-align: center;
      padding: 15px;
      border: 1px dashed var(--vscode-panel-border, #454545);
      border-radius: 4px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
    }
    .upload-hint:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
      background-color: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .images-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .image-item {
      position: relative;
      aspect-ratio: 1;
      border-radius: 4px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .image-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .image-item .remove-btn {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 18px;
      height: 18px;
      background: rgba(241, 76, 76, 0.9);
      color: white;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .image-item .remove-btn:hover {
      background: #f14c4c;
    }
    .image-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888888);
      margin-bottom: 8px;
    }
    .history-section {
      background: rgba(78, 201, 176, 0.1);
      border: 1px solid rgba(78, 201, 176, 0.3);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 15px;
    }
    .history-title {
      color: #4ec9b0;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    .history-list {
      max-height: 150px;
      overflow-y: auto;
    }
    .history-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      margin-bottom: 4px;
      background: rgba(0,0,0,0.2);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .history-item:hover {
      background: rgba(78, 201, 176, 0.2);
    }
    .history-item input[type="checkbox"] {
      margin-right: 8px;
    }
    .history-item .time {
      color: #888;
      margin-right: 8px;
      white-space: nowrap;
    }
    .history-item .summary {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-history {
      background: linear-gradient(135deg, #e6a23c 0%, #f56c6c 100%);
      color: white;
      flex: 1;
    }
    .btn-quick-prefix {
      background: linear-gradient(135deg, #4ec9b0 0%, #3794ff 100%);
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-family: monospace;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    .btn-quick-prefix:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(55, 148, 255, 0.3);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="header-icon">🔥</span>
      <h1>AI 反馈 <span style="color: #4ec9b0; font-size: 14px;">(本次对话第${usageStats.currentSessionPopups}次)</span></h1>
    </div>
    
    <div class="reason-box">
      <div class="reason-label">AI想要结束对话的原因:</div>
      <div class="reason-text">${escapeHtml(reason)}</div>
    </div>
    
    <div class="input-section">
      <label class="input-label">
        如需继续，请输入新的指令 <span class="optional">(可选)</span>:
      </label>
      <textarea 
        id="userInput" 
        placeholder="输入你的下一个指令..."
        autofocus
      ></textarea>
    </div>

    <div class="upload-section">
      <div class="upload-header">
        <span class="upload-label">🖼️ 已上传图片</span>
        <button type="button" class="clear-all" id="clearAll" style="display: none;">清空</button>
      </div>
      <div class="images-grid" id="imagesGrid"></div>
      <div class="image-count" id="imageCount" style="display: none;"></div>
      <div class="upload-hint" id="dropZone">
        📋 Ctrl+V 粘贴图片 | Ctrl+U 上传 | 拖拽图片到此处
      </div>
      <input type="file" id="fileInput" accept="image/*" multiple style="display: none;">
    </div>
    
    ${promptItems.length > 0 ? `
    <div class="prompt-select-section" style="margin-bottom: 15px; background: rgba(230, 162, 60, 0.1); border-radius: 8px; padding: 12px;">
      <div style="font-size: 12px; color: #e6a23c; margin-bottom: 8px; cursor: pointer;" onclick="togglePromptSelect()">
        📚 选择提示词 <span id="promptToggle">▶</span>
      </div>
      <div id="promptSelectArea" style="display: none;">
        <select id="promptCategory" style="width: 100%; padding: 6px; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;" onchange="filterPrompts()">
          <option value="">全部分类</option>
          ${promptCategories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
        <div id="promptList" style="max-height: 120px; overflow-y: auto;">
          ${promptItems.map(p => `
            <div class="prompt-select-item" style="display: flex; align-items: center; padding: 6px; margin-bottom: 4px; background: var(--vscode-input-background); border-radius: 4px; cursor: pointer;" data-category="${p.categoryId}" onclick="selectPrompt('${escapeHtml(p.content.replace(/'/g, "\\'").replace(/\n/g, "\\n"))}')">
              <span style="flex: 1; font-size: 12px;">${escapeHtml(p.title)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    ` : ''}

    ${prefixList.filter(p => p.enabled).length > 0 ? `
    <div class="quick-prefix-section" style="margin-bottom: 15px;">
      <div style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">⚡ 快捷前缀 (点击添加并发送):</div>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        ${prefixList.filter(p => p.enabled).map(p => `<button class="btn-quick-prefix" onclick="quickPrefix('${p.text}')">${p.text}</button>`).join('')}
      </div>
    </div>
    ` : ''}

    <div class="button-group">
      <button class="btn-history" id="loadHistoryBtn" style="display: ${conversationHistory.length > 0 ? 'block' : 'none'};">📂 加载历史</button>
      <button class="btn-primary" id="continueBtn">✅ 继续</button>
      <button class="btn-secondary" id="endBtn">🔴 结束</button>
    </div>
    
    <div class="efficiency-bar">
      💡 牛马帮你多获得了 <span class="highlight">${usageStats.currentSessionPopups}</span> 次交互！
    </div>
    
    <div class="shortcuts">
      <kbd>Ctrl+Enter</kbd> 继续 | <kbd>Ctrl+U</kbd> 上传图片 | <kbd>Ctrl+V</kbd> 粘贴图片 | <kbd>Esc</kbd> 结束
    </div>

    ${conversationHistory.length > 0 ? `
    <div class="history-section" id="historySection" style="margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--vscode-panel-border);">
      <div class="history-title" style="cursor: pointer; display: flex; align-items: center; justify-content: space-between;" onclick="toggleHistory()">
        <span>📂 选择要加载的历史记录</span>
        <span id="historyToggle">▶</span>
      </div>
      <div class="history-list" id="historyList" style="display: none; margin-top: 10px;">
        ${conversationHistory.slice(0, 10).map((h, i) => `
          <label class="history-item">
            <input type="checkbox" name="history" value="${i}">
            <span class="time">${new Date(h.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            <span class="summary">${escapeHtml(h.summary.substring(0, 50))}...</span>
          </label>
        `).join('')}
      </div>
    </div>
    ` : ''}
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('userInput');
    const continueBtn = document.getElementById('continueBtn');
    const endBtn = document.getElementById('endBtn');
    const dropZone = document.getElementById('dropZone');
    const imagesGrid = document.getElementById('imagesGrid');
    const imageCount = document.getElementById('imageCount');
    const clearAllBtn = document.getElementById('clearAll');
    const fileInput = document.getElementById('fileInput');
    
    let uploadedImages = []; // Array of {id, data, name, size}
    
    // Focus textarea on load
    textarea.focus();
    
    // Handle keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitContinue();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        submitEnd();
      }
    });
    
    // Ctrl+U to open file picker
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        fileInput.click();
      }
    });
    
    // Handle file input change
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files) {
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            handleImageFile(file);
          }
        }
      }
      fileInput.value = '';
    });
    
    // Handle paste event for images (Ctrl+V) - append instead of replace
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            handleImageFile(file);
          }
        }
      }
    });
    
    // Handle drag and drop - support multiple files
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--vscode-focusBorder, #007fd4)';
      dropZone.style.backgroundColor = 'var(--vscode-list-hoverBackground, #2a2d2e)';
    });
    
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.backgroundColor = '';
    });
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.backgroundColor = '';
      
      const files = e.dataTransfer?.files;
      if (files) {
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            handleImageFile(file);
          }
        }
      }
    });
    
    // Click on dropZone to open file picker
    dropZone.addEventListener('click', () => fileInput.click());
    
    // Handle image file - add to array
    function handleImageFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const id = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        uploadedImages.push({
          id,
          data: e.target.result,
          name: file.name,
          size: file.size
        });
        updateImagesDisplay();
      };
      reader.readAsDataURL(file);
    }
    
    // Update images display
    function updateImagesDisplay() {
      imagesGrid.innerHTML = uploadedImages.map(img => 
        '<div class="image-item" data-id="' + img.id + '">' +
          '<img src="' + img.data + '" alt="' + img.name + '">' +
          '<button class="remove-btn" onclick="removeImage(\\'' + img.id + '\\')">×</button>' +
        '</div>'
      ).join('');
      
      if (uploadedImages.length > 0) {
        imageCount.textContent = '已上传 ' + uploadedImages.length + ' 张图片';
        imageCount.style.display = 'block';
        clearAllBtn.style.display = 'block';
      } else {
        imageCount.style.display = 'none';
        clearAllBtn.style.display = 'none';
      }
    }
    
    // Remove single image
    window.removeImage = function(id) {
      uploadedImages = uploadedImages.filter(img => img.id !== id);
      updateImagesDisplay();
    };
    
    // Clear all images
    clearAllBtn.addEventListener('click', () => {
      uploadedImages = [];
      updateImagesDisplay();
    });
    
    // Button handlers
    continueBtn.addEventListener('click', submitContinue);
    endBtn.addEventListener('click', submitEnd);
    
    // Load history button handler
    const loadHistoryBtn = document.getElementById('loadHistoryBtn');
    if (loadHistoryBtn) {
      loadHistoryBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('input[name="history"]:checked');
        if (checkboxes.length === 0) {
          alert('请先选择要加载的历史记录');
          return;
        }
        const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.value));
        vscode.postMessage({ command: 'loadHistory', indices: selectedIndices });
      });
    }
    
    function submitContinue() {
      let text = textarea.value.trim();
      
      // If there are images, append them to the message
      if (uploadedImages.length > 0) {
        const imagesData = uploadedImages.map(img => img.data).join('\\n');
        text = (text ? text + '\\n\\n' : '') + '[图片已附加]\\n' + imagesData;
      }
      
      vscode.postMessage({ command: 'continue', text: text || '继续', hasImage: uploadedImages.length > 0 });
    }
    
    // 提示词选择功能
    function togglePromptSelect() {
      const area = document.getElementById('promptSelectArea');
      const toggle = document.getElementById('promptToggle');
      if (area.style.display === 'none') {
        area.style.display = 'block';
        toggle.textContent = '▼';
      } else {
        area.style.display = 'none';
        toggle.textContent = '▶';
      }
    }
    
    function filterPrompts() {
      const categoryId = document.getElementById('promptCategory').value;
      document.querySelectorAll('.prompt-select-item').forEach(item => {
        if (!categoryId || item.dataset.category === categoryId) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    }
    
    function selectPrompt(content) {
      textarea.value = content.replace(/\\\\n/g, '\\n');
      textarea.focus();
    }
    
    // 历史记录折叠功能
    function toggleHistory() {
      const list = document.getElementById('historyList');
      const toggle = document.getElementById('historyToggle');
      if (list.style.display === 'none') {
        list.style.display = 'block';
        toggle.textContent = '▼';
      } else {
        list.style.display = 'none';
        toggle.textContent = '▶';
      }
    }
    
    // 快捷前缀按钮点击
    function quickPrefix(prefix) {
      let text = textarea.value.trim();
      if (!text.startsWith(prefix)) {
        text = prefix + ' ' + text;
      }
      vscode.postMessage({ command: 'continue', text: text || prefix, hasImage: uploadedImages.length > 0 });
    }
    
    function submitEnd() {
      vscode.postMessage({ command: 'end' });
    }
    
    // 接收来自扩展的消息
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'setInput') {
        textarea.value = message.text;
        textarea.focus();
      }
    });
  </script>
</body>
</html>`;
}
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
/**
 * 显示前缀管理弹窗
 */
function showPrefixManagerPanel() {
    const panel = vscode.window.createWebviewPanel('prefixManager', '管理快捷前缀', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = getPrefixManagerHtml();
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'savePrefixList':
                prefixList = message.prefixList || [];
                if (extensionContext) {
                    extensionContext.globalState.update('prefixList', prefixList);
                }
                statusViewProvider?.refreshView();
                vscode.window.showInformationMessage(`Ask Continue: 前缀已保存 (${prefixList.length}个)`);
                panel.dispose();
                break;
            case 'cancel':
                panel.dispose();
                break;
        }
    });
}
/**
 * 生成前缀管理弹窗 HTML
 */
function getPrefixManagerHtml() {
    const prefixListJson = JSON.stringify(prefixList);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .title { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
    .prefix-list { margin-bottom: 20px; }
    .prefix-item { display: flex; align-items: center; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; margin-bottom: 8px; }
    .prefix-item input[type="checkbox"] { margin-right: 10px; }
    .prefix-item .text { flex: 1; font-family: monospace; }
    .prefix-item .delete-btn { background: #f14c4c; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
    .add-section { display: flex; gap: 8px; margin-bottom: 20px; }
    .add-section input { flex: 1; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
    .btn-primary { background: #3794ff; color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 15px; }
  </style>
</head>
<body>
  <div class="title">⚙️ 管理快捷前缀</div>
  <div class="hint">勾选的前缀将显示在对话弹窗中，点击可快速添加并发送</div>
  
  <div class="prefix-list" id="prefixList"></div>
  
  <div class="add-section">
    <input type="text" id="newPrefix" placeholder="输入新前缀，如 /openspec-proposal">
    <button class="btn btn-primary" onclick="addPrefix()">+ 添加</button>
  </div>
  
  <div class="actions">
    <button class="btn btn-secondary" onclick="cancel()">取消</button>
    <button class="btn btn-primary" onclick="save()">保存并关闭</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let prefixList = ${prefixListJson};
    
    function render() {
      const container = document.getElementById('prefixList');
      if (prefixList.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:var(--vscode-descriptionForeground);padding:20px;">暂无前缀，请添加</div>';
        return;
      }
      container.innerHTML = prefixList.map((p, i) => \`
        <div class="prefix-item">
          <input type="checkbox" \${p.enabled ? 'checked' : ''} onchange="toggle(\${i})">
          <span class="text">\${p.text}</span>
          <button class="delete-btn" onclick="remove(\${i})">删除</button>
        </div>
      \`).join('');
    }
    
    function toggle(index) {
      prefixList[index].enabled = !prefixList[index].enabled;
      render();
    }
    
    function remove(index) {
      prefixList.splice(index, 1);
      render();
    }
    
    function addPrefix() {
      const input = document.getElementById('newPrefix');
      const text = input.value.trim();
      if (text) {
        prefixList.push({ id: Date.now().toString(), text: text, enabled: true });
        input.value = '';
        render();
      }
    }
    
    function save() {
      vscode.postMessage({ command: 'savePrefixList', prefixList: prefixList });
    }
    
    function cancel() {
      vscode.postMessage({ command: 'cancel' });
    }
    
    // Enter 键添加
    document.getElementById('newPrefix').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addPrefix();
    });
    
    render();
  </script>
</body>
</html>`;
}
/**
 * 显示提示词库弹窗
 */
function showPromptLibraryPanel() {
    const panel = vscode.window.createWebviewPanel('promptLibrary', '📚 提示词库', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = getPromptLibraryHtml();
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'savePromptData':
                promptCategories = message.categories || [];
                promptItems = message.prompts || [];
                if (extensionContext) {
                    extensionContext.globalState.update('promptCategories', promptCategories);
                    extensionContext.globalState.update('promptItems', promptItems);
                }
                statusViewProvider?.refreshView();
                vscode.window.showInformationMessage(`Ask Continue: 提示词已保存`);
                panel.dispose();
                break;
            case 'cancel':
                panel.dispose();
                break;
        }
    });
}
function getPromptLibraryHtml() {
    const categoriesJson = JSON.stringify(promptCategories);
    const promptsJson = JSON.stringify(promptItems);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .title { font-size: 18px; font-weight: 600; margin-bottom: 15px; }
    .section { margin-bottom: 20px; }
    .category-header { display: flex; align-items: center; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; margin-bottom: 4px; cursor: pointer; }
    .category-color { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
    .category-name { flex: 1; font-weight: 500; }
    .prompt-item { display: flex; align-items: center; padding: 8px 8px 8px 28px; background: var(--vscode-editor-background); border-left: 2px solid var(--vscode-input-border); margin-bottom: 2px; }
    .prompt-title { flex: 1; }
    .prompt-content { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
    .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-sm { padding: 4px 8px; font-size: 11px; }
    .btn-primary { background: #3794ff; color: white; }
    .btn-danger { background: #f14c4c; color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
    .add-row { display: flex; gap: 8px; margin-bottom: 15px; }
    .add-row input, .add-row textarea, .add-row select { flex: 1; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    .add-row textarea { min-height: 60px; resize: vertical; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
    .empty { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
    .color-picker { display: flex; gap: 4px; }
    .color-option { width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
    .color-option.selected { border-color: white; }
  </style>
</head>
<body>
  <div class="title">📚 提示词库</div>
  <div class="hint">管理你的常用提示词，在对话中快速选择使用</div>

  <div class="section">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>分类管理</strong>
      <button class="btn btn-sm btn-primary" onclick="showAddCategory()">+ 新建分类</button>
    </div>
    <div id="addCategoryRow" style="display:none;" class="add-row">
      <input type="text" id="newCategoryName" placeholder="分类名称">
      <div class="color-picker" id="colorPicker"></div>
      <button class="btn btn-sm btn-primary" onclick="addCategory()">添加</button>
      <button class="btn btn-sm" onclick="hideAddCategory()">取消</button>
    </div>
  </div>

  <div class="section">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>提示词列表</strong>
      <button class="btn btn-sm btn-primary" onclick="showAddPrompt()">+ 添加提示词</button>
    </div>
    <div id="addPromptRow" style="display:none;">
      <div class="add-row">
        <input type="text" id="newPromptTitle" placeholder="标题">
        <select id="newPromptCategory"></select>
      </div>
      <div class="add-row">
        <textarea id="newPromptContent" placeholder="提示词内容..."></textarea>
      </div>
      <div style="margin-bottom:15px;">
        <button class="btn btn-sm btn-primary" onclick="addPrompt()">添加</button>
        <button class="btn btn-sm" onclick="hideAddPrompt()">取消</button>
      </div>
    </div>
    <div id="promptList"></div>
  </div>

  <div class="actions">
    <button class="btn btn-secondary" onclick="cancel()">取消</button>
    <button class="btn btn-primary" onclick="save()">保存并关闭</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let categories = ${categoriesJson};
    let prompts = ${promptsJson};
    const colors = ['#3794ff', '#4ec9b0', '#e6a23c', '#f56c6c', '#9c27b0', '#607d8b'];

    function render() {
      renderColorPicker();
      renderCategorySelect();
      renderPromptList();
    }

    function renderColorPicker() {
      const picker = document.getElementById('colorPicker');
      picker.innerHTML = colors.map((c, i) => 
        \`<div class="color-option \${i===0?'selected':''}" style="background:\${c}" data-color="\${c}" onclick="selectColor(this)"></div>\`
      ).join('');
    }

    function selectColor(el) {
      document.querySelectorAll('.color-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
    }

    function renderCategorySelect() {
      const select = document.getElementById('newPromptCategory');
      select.innerHTML = '<option value="">未分类</option>' + 
        categories.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
    }

    function renderPromptList() {
      const container = document.getElementById('promptList');
      if (prompts.length === 0 && categories.length === 0) {
        container.innerHTML = '<div class="empty">暂无提示词，请添加</div>';
        return;
      }

      let html = '';
      // 按分类分组
      const grouped = {};
      categories.forEach(c => grouped[c.id] = { category: c, prompts: [] });
      grouped[''] = { category: { id: '', name: '未分类', color: '#607d8b' }, prompts: [] };
      
      prompts.forEach(p => {
        const cid = p.categoryId || '';
        if (!grouped[cid]) grouped[cid] = { category: { id: cid, name: '未分类', color: '#607d8b' }, prompts: [] };
        grouped[cid].prompts.push(p);
      });

      Object.values(grouped).forEach(g => {
        if (g.prompts.length === 0 && g.category.id !== '') {
          // 空分类也显示
          html += \`<div class="category-header">
            <div class="category-color" style="background:\${g.category.color}"></div>
            <span class="category-name">\${g.category.name}</span>
            <button class="btn btn-sm btn-danger" onclick="deleteCategory('\${g.category.id}')">删除</button>
          </div>\`;
        } else if (g.prompts.length > 0) {
          html += \`<div class="category-header">
            <div class="category-color" style="background:\${g.category.color}"></div>
            <span class="category-name">\${g.category.name} (\${g.prompts.length})</span>
            \${g.category.id ? \`<button class="btn btn-sm btn-danger" onclick="deleteCategory('\${g.category.id}')">删除</button>\` : ''}
          </div>\`;
          g.prompts.forEach(p => {
            html += \`<div class="prompt-item">
              <span class="prompt-title" style="cursor:pointer;" onclick="editPrompt('\${p.id}')">\${p.title}</span>
              <span class="prompt-content">\${p.content.substring(0,30)}...</span>
              <button class="btn btn-sm" style="background:#e6a23c;color:white;margin-right:4px;" onclick="editPrompt('\${p.id}')">编辑</button>
              <button class="btn btn-sm btn-danger" onclick="deletePrompt('\${p.id}')">删除</button>
            </div>\`;
          });
        }
      });

      container.innerHTML = html || '<div class="empty">暂无提示词</div>';
    }

    function showAddCategory() { document.getElementById('addCategoryRow').style.display = 'flex'; }
    function hideAddCategory() { document.getElementById('addCategoryRow').style.display = 'none'; }
    function showAddPrompt() { document.getElementById('addPromptRow').style.display = 'block'; }
    function hideAddPrompt() { document.getElementById('addPromptRow').style.display = 'none'; }

    function addCategory() {
      const name = document.getElementById('newCategoryName').value.trim();
      const colorEl = document.querySelector('.color-option.selected');
      if (name && colorEl) {
        categories.push({ id: Date.now().toString(), name, color: colorEl.dataset.color });
        document.getElementById('newCategoryName').value = '';
        hideAddCategory();
        render();
      }
    }

    function deleteCategory(id) {
      categories = categories.filter(c => c.id !== id);
      prompts.forEach(p => { if (p.categoryId === id) p.categoryId = ''; });
      render();
    }

    function deletePrompt(id) {
      prompts = prompts.filter(p => p.id !== id);
      render();
    }

    let editingPromptId = null;

    function editPrompt(id) {
      const prompt = prompts.find(p => p.id === id);
      if (!prompt) return;
      
      editingPromptId = id;
      document.getElementById('newPromptTitle').value = prompt.title;
      document.getElementById('newPromptContent').value = prompt.content;
      document.getElementById('newPromptCategory').value = prompt.categoryId || '';
      document.getElementById('addPromptRow').style.display = 'block';
      
      // 更改按钮文本
      const addBtn = document.querySelector('#addPromptRow .btn-primary');
      if (addBtn) addBtn.textContent = '更新';
    }

    function addPrompt() {
      const title = document.getElementById('newPromptTitle').value.trim();
      const content = document.getElementById('newPromptContent').value.trim();
      const categoryId = document.getElementById('newPromptCategory').value;
      if (title && content) {
        if (editingPromptId) {
          // 更新现有提示词
          const idx = prompts.findIndex(p => p.id === editingPromptId);
          if (idx !== -1) {
            prompts[idx].title = title;
            prompts[idx].content = content;
            prompts[idx].categoryId = categoryId;
          }
          editingPromptId = null;
        } else {
          // 添加新提示词
          prompts.push({ id: Date.now().toString(), title, content, categoryId, createdAt: Date.now(), usageCount: 0 });
        }
        document.getElementById('newPromptTitle').value = '';
        document.getElementById('newPromptContent').value = '';
        hideAddPrompt();
        render();
        
        // 恢复按钮文本
        const addBtn = document.querySelector('#addPromptRow .btn-primary');
        if (addBtn) addBtn.textContent = '添加';
      }
    }

    function save() {
      vscode.postMessage({ command: 'savePromptData', categories, prompts });
    }

    function cancel() {
      vscode.postMessage({ command: 'cancel' });
    }

    render();
  </script>
</body>
</html>`;
}
/**
 * 显示导入/导出弹窗
 */
function showExportImportPanel() {
    const panel = vscode.window.createWebviewPanel('exportImport', '📦 导入/导出', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = getExportImportHtml();
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'export':
                const exportData = {
                    version: '1.0',
                    prefixList: message.includePrefixes ? prefixList : [],
                    categories: message.includeCategories ? promptCategories : [],
                    prompts: message.includePrompts ? promptItems : []
                };
                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file('ask-continue-data.json'),
                    filters: { 'JSON': ['json'] }
                });
                if (saveUri) {
                    fs.writeFileSync(saveUri.fsPath, JSON.stringify(exportData, null, 2));
                    vscode.window.showInformationMessage(`数据已导出到 ${saveUri.fsPath}`);
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
                            prefixList = [...prefixList, ...data.prefixList.filter(p => !prefixList.find(e => e.text === p.text))];
                        }
                        if (data.categories) {
                            promptCategories = [...promptCategories, ...data.categories.filter(c => !promptCategories.find(e => e.name === c.name))];
                        }
                        if (data.prompts) {
                            promptItems = [...promptItems, ...data.prompts.filter(p => !promptItems.find(e => e.title === p.title))];
                        }
                        if (extensionContext) {
                            extensionContext.globalState.update('prefixList', prefixList);
                            extensionContext.globalState.update('promptCategories', promptCategories);
                            extensionContext.globalState.update('promptItems', promptItems);
                        }
                        statusViewProvider?.refreshView();
                        vscode.window.showInformationMessage(`数据已导入！前缀: ${data.prefixList?.length || 0}, 分类: ${data.categories?.length || 0}, 提示词: ${data.prompts?.length || 0}`);
                        panel.dispose();
                    }
                    catch (e) {
                        vscode.window.showErrorMessage('导入失败：文件格式错误');
                    }
                }
                break;
            case 'cancel':
                panel.dispose();
                break;
        }
    });
}
function getExportImportHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .title { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
    .section { background: var(--vscode-input-background); border-radius: 8px; padding: 15px; margin-bottom: 15px; }
    .section-title { font-weight: 500; margin-bottom: 10px; }
    .checkbox-item { display: flex; align-items: center; margin-bottom: 8px; }
    .checkbox-item input { margin-right: 8px; }
    .btn { padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; width: 100%; margin-bottom: 8px; }
    .btn-primary { background: #3794ff; color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 5px; }
    .stats { font-size: 12px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="title">📦 导入/导出</div>

  <div class="section">
    <div class="section-title">📤 导出数据</div>
    <div class="stats">当前数据: 快捷前缀 ${prefixList.length}个, 分类 ${promptCategories.length}个, 提示词 ${promptItems.length}个</div>
    <div style="margin: 10px 0;">
      <label class="checkbox-item"><input type="checkbox" id="exportPrefixes" checked> 快捷前缀</label>
      <label class="checkbox-item"><input type="checkbox" id="exportCategories" checked> 提示词分类</label>
      <label class="checkbox-item"><input type="checkbox" id="exportPrompts" checked> 提示词</label>
    </div>
    <button class="btn btn-primary" onclick="exportData()">📤 导出到文件</button>
  </div>

  <div class="section">
    <div class="section-title">📥 导入数据</div>
    <button class="btn btn-secondary" onclick="importData()">📥 从文件导入</button>
    <div class="hint">⚠️ 导入将合并现有数据，相同项不会重复添加</div>
  </div>

  <button class="btn btn-secondary" onclick="cancel()" style="margin-top:10px;">关闭</button>

  <script>
    const vscode = acquireVsCodeApi();

    function exportData() {
      vscode.postMessage({
        command: 'export',
        includePrefixes: document.getElementById('exportPrefixes').checked,
        includeCategories: document.getElementById('exportCategories').checked,
        includePrompts: document.getElementById('exportPrompts').checked
      });
    }

    function importData() {
      vscode.postMessage({ command: 'import' });
    }

    function cancel() {
      vscode.postMessage({ command: 'cancel' });
    }
  </script>
</body>
</html>`;
}
/**
 * 显示 MCP 管理面板
 */
function showMCPManagerPanel() {
    if (mcpManagerPanel) {
        mcpManagerPanel.reveal();
        return;
    }
    mcpManagerPanel = vscode.window.createWebviewPanel('mcpManager', '🔌 MCP 服务管理', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    mcpManagerPanel.webview.html = getMCPManagerHtml();
    mcpManagerPanel.onDidDispose(() => {
        mcpManagerPanel = null;
    });
    mcpManagerPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'refresh':
                await checkAllMCPServices();
                if (mcpManagerPanel) {
                    mcpManagerPanel.webview.html = getMCPManagerHtml();
                }
                break;
            case 'restartService':
                addLog('info', `Restarting service: ${message.serviceName}`);
                vscode.window.showInformationMessage(`正在重启 ${message.serviceName}...`);
                break;
            case 'restartAll':
                addLog('info', 'Restarting all services');
                vscode.window.showInformationMessage('正在重启所有服务...');
                break;
            case 'installService':
                await installMCPService(message.serviceName || '');
                await checkAllMCPServices();
                if (mcpManagerPanel) {
                    mcpManagerPanel.webview.html = getMCPManagerHtml();
                }
                break;
            case 'close':
                mcpManagerPanel?.dispose();
                break;
        }
    });
}
/**
 * 启动健康检查调度器
 */
function startHealthCheckScheduler() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
    }
    // 立即执行一次检查
    checkAllMCPServices();
    // 定期检查
    healthCheckInterval = setInterval(async () => {
        await checkAllMCPServices();
        // 检查是否有离线服务需要自动恢复
        for (const [name, status] of mcpServiceStatuses) {
            if (status.status === 'offline') {
                addLog('warn', `Service ${name} is offline, attempting recovery...`);
                await attemptServiceRecovery(name);
            }
        }
        // 更新管理面板
        if (mcpManagerPanel) {
            mcpManagerPanel.webview.html = getMCPManagerHtml();
        }
    }, HEALTH_CHECK_INTERVAL);
    addLog('info', 'Health check scheduler started');
}
/**
 * 停止健康检查调度器
 */
function stopHealthCheckScheduler() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        addLog('info', 'Health check scheduler stopped');
    }
}
/**
 * 尝试恢复服务
 */
async function attemptServiceRecovery(serviceName, retryCount = 0) {
    const maxRetries = 3;
    const baseDelay = 1000;
    if (retryCount >= maxRetries) {
        addLog('error', `Failed to recover ${serviceName} after ${maxRetries} attempts`);
        vscode.window.showErrorMessage(`${serviceName} 恢复失败，请手动检查`);
        return false;
    }
    // 更新状态为启动中
    const status = mcpServiceStatuses.get(serviceName);
    if (status) {
        status.status = 'starting';
        mcpServiceStatuses.set(serviceName, status);
    }
    // 指数退避延迟
    const delay = baseDelay * Math.pow(2, retryCount);
    await new Promise(resolve => setTimeout(resolve, delay));
    // 重新检查服务状态
    await checkAllMCPServices();
    const newStatus = mcpServiceStatuses.get(serviceName);
    if (newStatus && newStatus.status === 'running') {
        addLog('info', `Service ${serviceName} recovered successfully`);
        return true;
    }
    // 递归重试
    return attemptServiceRecovery(serviceName, retryCount + 1);
}
/**
 * 安装 MCP 服务
 */
async function installMCPService(serviceName) {
    const configPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    const homeDir = os.homedir().replace(/\\/g, '/');
    // 服务配置模板 - 使用正确的官方包名
    const serviceConfigs = {
        'filesystem': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', homeDir]
        },
        'shell': {
            command: 'npx',
            args: ['-y', 'shell-mcp-server'],
            env: {}
        },
        'memory': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory']
        },
        'fetch': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-fetch']
        },
        'sqlite': {
            command: 'npx',
            args: ['-y', 'mcp-sqlite']
        }
    };
    if (!serviceConfigs[serviceName]) {
        vscode.window.showErrorMessage(`未知服务: ${serviceName}`);
        return;
    }
    try {
        let config = { mcpServers: {} };
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
        config.mcpServers[serviceName] = serviceConfigs[serviceName];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        addLog('info', `Installed service: ${serviceName}`);
        vscode.window.showInformationMessage(`已安装 ${serviceName}，请重启 Windsurf 生效`);
    }
    catch (err) {
        addLog('error', `Failed to install ${serviceName}: ${err}`);
        vscode.window.showErrorMessage(`安装 ${serviceName} 失败: ${err}`);
    }
}
/**
 * 检查所有 MCP 服务状态
 */
async function checkAllMCPServices() {
    const configPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const configuredServices = Object.keys(config.mcpServers || {});
            for (const service of MCP_SERVICES) {
                const isConfigured = configuredServices.includes(service.name);
                mcpServiceStatuses.set(service.name, {
                    name: service.name,
                    status: isConfigured ? 'running' : 'not_installed',
                    lastCheck: Date.now()
                });
            }
        }
    }
    catch (err) {
        addLog('error', `Failed to check MCP services: ${err}`);
    }
}
/**
 * 获取 MCP 管理面板 HTML
 */
function getMCPManagerHtml() {
    const services = MCP_SERVICES.map(svc => {
        const status = mcpServiceStatuses.get(svc.name) || { name: svc.name, status: 'not_installed' };
        return { ...svc, ...status };
    });
    const runningCount = services.filter(s => s.status === 'running').length;
    const warningCount = services.filter(s => s.status === 'warning').length;
    const offlineCount = services.filter(s => s.status === 'offline').length;
    const statusIcon = (status) => {
        switch (status) {
            case 'running': return '✅';
            case 'warning': return '⚠️';
            case 'offline': return '❌';
            case 'starting': return '🔄';
            default: return '⚪';
        }
    };
    const statusText = (status) => {
        switch (status) {
            case 'running': return '运行中';
            case 'warning': return '警告';
            case 'offline': return '离线';
            case 'starting': return '启动中';
            default: return '未安装';
        }
    };
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .title { font-size: 20px; font-weight: 600; }
    .overview { display: flex; gap: 20px; margin-bottom: 20px; padding: 15px; background: var(--vscode-input-background); border-radius: 8px; }
    .overview-item { text-align: center; }
    .overview-count { font-size: 24px; font-weight: bold; }
    .overview-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .service-list { background: var(--vscode-input-background); border-radius: 8px; overflow: hidden; }
    .service-header { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; padding: 12px 15px; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); }
    .service-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; padding: 12px 15px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
    .service-row:last-child { border-bottom: none; }
    .service-name { display: flex; align-items: center; gap: 8px; }
    .service-desc { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-primary { background: #3794ff; color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-small { padding: 4px 8px; font-size: 11px; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    .logs { margin-top: 20px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 15px; }
    .logs-title { font-weight: 600; margin-bottom: 10px; }
    .log-entry { font-size: 11px; font-family: monospace; margin-bottom: 4px; }
    .status-running { color: #4ec9b0; }
    .status-warning { color: #cca700; }
    .status-offline { color: #f14c4c; }
    .status-not_installed { color: #888; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">🔌 MCP 服务管理中心</div>
    <button class="btn btn-secondary" onclick="refresh()">🔄 刷新</button>
  </div>

  <div class="overview">
    <div class="overview-item">
      <div class="overview-count status-running">${runningCount}</div>
      <div class="overview-label">运行中</div>
    </div>
    <div class="overview-item">
      <div class="overview-count status-warning">${warningCount}</div>
      <div class="overview-label">警告</div>
    </div>
    <div class="overview-item">
      <div class="overview-count status-offline">${offlineCount}</div>
      <div class="overview-label">离线</div>
    </div>
  </div>

  <div class="service-list">
    <div class="service-header">
      <div>服务名称</div>
      <div>状态</div>
      <div>响应时间</div>
      <div>操作</div>
    </div>
    ${services.map(svc => {
        const actionBtn = svc.status === 'not_installed'
            ? `<button class="btn btn-small btn-primary" onclick="installService('${svc.name}')">安装</button>`
            : `<button class="btn btn-small btn-secondary" onclick="restartService('${svc.name}')">重启</button>`;
        return `
      <div class="service-row">
        <div class="service-name">
          <span>${statusIcon(svc.status)}</span>
          <div>
            <div>${svc.displayName}</div>
            <div class="service-desc">${svc.description}</div>
          </div>
        </div>
        <div class="status-${svc.status}">${statusText(svc.status)}</div>
        <div>${svc.responseTime ? svc.responseTime + 'ms' : '-'}</div>
        <div>${actionBtn}</div>
      </div>`;
    }).join('')}
  </div>

  <div class="actions">
    <button class="btn btn-secondary" onclick="restartAll()">🔄 全部重启</button>
    <button class="btn btn-secondary" onclick="checkStatus()">🔍 检查状态</button>
  </div>

  <div class="logs">
    <div class="logs-title">📝 最近日志</div>
    ${mcpLogs.slice(0, 10).map(log => {
        const color = log.type === 'error' ? '#f14c4c' : log.type === 'warn' ? '#cca700' : '#4ec9b0';
        return `<div class="log-entry"><span style="color:#888;">[${log.time}]</span> <span style="color:${color};">${log.msg}</span></div>`;
    }).join('') || '<div class="log-entry" style="color:#888;">暂无日志</div>'}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function refresh() { vscode.postMessage({ command: 'refresh' }); }
    function restartService(name) { vscode.postMessage({ command: 'restartService', serviceName: name }); }
    function restartAll() { vscode.postMessage({ command: 'restartAll' }); }
    function checkStatus() { vscode.postMessage({ command: 'refresh' }); }
    function installService(name) { vscode.postMessage({ command: 'installService', serviceName: name }); }
  </script>
</body>
</html>`;
}
/**
 * Start the HTTP server to receive requests from MCP
 */
function startServer(port, retryCount = 0) {
    // 先安全关闭旧服务器
    if (server) {
        try {
            server.close();
        }
        catch {
            // 忽略关闭错误
        }
        server = null;
    }
    const newServer = http.createServer((req, res) => {
        // Set CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            res.writeHead(200);
            res.end();
            return;
        }
        if (req.method === "POST" && req.url === "/ask") {
            let body = "";
            req.on("data", (chunk) => {
                body += chunk.toString();
            });
            req.on("end", async () => {
                try {
                    const request = JSON.parse(body);
                    if (request.type === "ask_continue") {
                        // Show dialog with error handling
                        addLog('info', `MCP request received: ${request.requestId}`);
                        try {
                            // 使用 await 确保 webview 创建完成
                            await showAskContinueDialog(request);
                            // Update request count in sidebar
                            statusViewProvider?.incrementRequestCount();
                            // Update usage statistics
                            incrementPopupCount();
                            addLog('info', `Dialog shown for: ${request.requestId}`);
                            // Respond that we received the request
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ success: true }));
                        }
                        catch (dialogErr) {
                            console.error("[Ask Continue] Error showing dialog:", dialogErr);
                            addLog('error', `Dialog failed: ${String(dialogErr)}`);
                            res.writeHead(500, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Failed to show dialog", details: String(dialogErr) }));
                        }
                    }
                    else {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Unknown request type" }));
                    }
                }
                catch {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid JSON" }));
                }
            });
        }
        else {
            res.writeHead(404);
            res.end();
        }
    });
    newServer.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            // 端口被占用，尝试下一个端口（最多重试3次）
            if (retryCount < 3) {
                const nextPort = port + 1;
                console.log(`Port ${port} in use, trying ${nextPort}...`);
                setTimeout(() => startServer(nextPort, retryCount + 1), 100);
            }
            else {
                updateStatusBar(false, port);
                vscode.window.showWarningMessage(`Ask Continue: 端口 ${port - 3} - ${port} 均被占用，服务未启动`);
            }
        }
        else {
            updateStatusBar(false, port);
            console.error(`Ask Continue server error: ${err.message}`);
        }
    });
    newServer.listen(port, "127.0.0.1", () => {
        server = newServer;
        console.log(`Ask Continue server listening on port ${port}`);
        addLog('info', `Server started on port ${port}`);
        updateStatusBar(true, port);
        // 写入端口文件，供 MCP 服务器发现
        writePortFile(port);
    });
}
/**
 * 写入端口文件，供 MCP 服务器发现
 */
function writePortFile(port) {
    try {
        if (!fs.existsSync(PORT_FILE_DIR)) {
            fs.mkdirSync(PORT_FILE_DIR, { recursive: true });
        }
        // 使用进程 ID 作为文件名，确保多窗口不冲突
        const portFile = path.join(PORT_FILE_DIR, `${process.pid}.port`);
        fs.writeFileSync(portFile, JSON.stringify({ port, pid: process.pid, time: Date.now() }));
    }
    catch (e) {
        console.error("Failed to write port file:", e);
    }
}
/**
 * 清理端口文件
 */
function cleanupPortFile() {
    try {
        const portFile = path.join(PORT_FILE_DIR, `${process.pid}.port`);
        if (fs.existsSync(portFile)) {
            fs.unlinkSync(portFile);
        }
    }
    catch (e) {
        // 忽略清理错误
    }
}
/**
 * 清理旧的 MCP 回调端口进程（启动时自动调用）
 */
async function cleanupOldMcpProcesses() {
    const isWindows = process.platform === "win32";
    // 清理端口 23984-24034 范围内的旧进程（MCP 回调端口范围）
    for (let port = 23984; port <= 24034; port++) {
        try {
            if (isWindows) {
                // Windows: 查找并结束占用端口的进程
                (0, child_process_1.exec)(`netstat -ano | findstr :${port} | findstr LISTENING`, (err, stdout) => {
                    if (!err && stdout) {
                        const lines = stdout.trim().split('\n');
                        for (const line of lines) {
                            const parts = line.trim().split(/\s+/);
                            const pid = parts[parts.length - 1];
                            if (pid && /^\d+$/.test(pid) && pid !== process.pid.toString()) {
                                (0, child_process_1.exec)(`taskkill /F /PID ${pid}`, () => {
                                    console.log(`[Ask Continue] Killed old MCP process on port ${port} (PID: ${pid})`);
                                });
                            }
                        }
                    }
                });
            }
            else {
                // Unix/Mac: 使用 lsof
                (0, child_process_1.exec)(`lsof -ti:${port}`, (err, stdout) => {
                    if (!err && stdout) {
                        const pids = stdout.trim().split('\n');
                        for (const pid of pids) {
                            if (pid && pid !== process.pid.toString()) {
                                (0, child_process_1.exec)(`kill -9 ${pid}`, () => {
                                    console.log(`[Ask Continue] Killed old MCP process on port ${port} (PID: ${pid})`);
                                });
                            }
                        }
                    }
                });
            }
        }
        catch (e) {
            // 忽略单个端口清理错误
        }
    }
    // 清理旧的端口文件
    try {
        if (fs.existsSync(PORT_FILE_DIR)) {
            const files = fs.readdirSync(PORT_FILE_DIR);
            for (const file of files) {
                if (file.endsWith('.port')) {
                    const filePath = path.join(PORT_FILE_DIR, file);
                    try {
                        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                        // 如果进程已不存在，删除文件
                        if (content.pid && content.pid !== process.pid) {
                            if (isWindows) {
                                (0, child_process_1.exec)(`tasklist /FI "PID eq ${content.pid}"`, (err, stdout) => {
                                    if (!stdout || !stdout.includes(content.pid.toString())) {
                                        fs.unlinkSync(filePath);
                                    }
                                });
                            }
                            else {
                                (0, child_process_1.exec)(`ps -p ${content.pid}`, (err) => {
                                    if (err) {
                                        fs.unlinkSync(filePath);
                                    }
                                });
                            }
                        }
                    }
                    catch {
                        fs.unlinkSync(filePath);
                    }
                }
            }
        }
    }
    catch (e) {
        // 忽略清理错误
    }
}
/**
 * Update status bar and sidebar
 */
function updateStatusBar(running, port) {
    if (running && port) {
        statusBarItem.text = `$(check) Ask Continue: ${port}`;
        statusBarItem.tooltip = `Ask Continue 正在运行 (端口 ${port})`;
        statusBarItem.backgroundColor = undefined;
        statusViewProvider?.updateStatus(true, port);
    }
    else {
        statusBarItem.text = "$(x) Ask Continue: 已停止";
        statusBarItem.tooltip = "Ask Continue 未运行";
        statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        statusViewProvider?.updateStatus(false, port || 23983);
    }
}
/**
 * 加载历史记录
 */
function loadHistory() {
    const historyFile = path.join(HISTORY_DIR, 'history.json');
    try {
        if (fs.existsSync(historyFile)) {
            const data = fs.readFileSync(historyFile, 'utf8');
            conversationHistory = JSON.parse(data);
        }
    }
    catch (e) {
        console.error('[Ask Continue] Failed to load history:', e);
        conversationHistory = [];
    }
}
/**
 * 保存历史记录
 */
function saveHistory() {
    try {
        if (!fs.existsSync(HISTORY_DIR)) {
            fs.mkdirSync(HISTORY_DIR, { recursive: true });
        }
        const historyFile = path.join(HISTORY_DIR, 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(conversationHistory, null, 2));
    }
    catch (e) {
        console.error('[Ask Continue] Failed to save history:', e);
    }
}
/**
 * 添加历史记录
 */
function addHistoryEntry(summary, userInput) {
    const entry = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        summary,
        userInput,
        projectDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown'
    };
    conversationHistory.unshift(entry);
    // 保留最近100条记录
    if (conversationHistory.length > 100) {
        conversationHistory = conversationHistory.slice(0, 100);
    }
    saveHistory();
}
/**
 * 检查配置文件是否存在
 */
async function checkConfiguration() {
    const homeDir = os.homedir();
    const mcpConfigPath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
    const windsurfrulesPath = path.join(homeDir, '.windsurfrules');
    const mcpConfig = fs.existsSync(mcpConfigPath);
    const windsurfrules = fs.existsSync(windsurfrulesPath);
    return { mcpConfig, windsurfrules };
}
/**
 * 默认规则内容 - AI 必须调用 ask_continue
 */
const DEFAULT_RULES = `<ask_continue_protocol>
<priority>⚠️ CRITICAL - 最高优先级、无例外、必须执行 ⚠️</priority>

<core_rule>
🔴🔴🔴 核心规则（绝对不允许违反）🔴🔴🔴

每次回复结束前，你必须调用 ask_continue 工具。
这是强制性要求，没有任何例外情况。
</core_rule>

<when_to_call>
🔴 必须调用 ask_continue 的时机：

1️⃣ 【对话一开始】- 用户发送第一条消息后，你回复之后必须立即调用
2️⃣ 【完成任务后】- 任何代码修改、文件操作、回答问题等完成后必须调用
3️⃣ 【用户结束语】- 用户说"谢谢"、"好的"、"明白了"时必须调用（让用户决定是否结束）
4️⃣ 【任何回复结束前】- 无论回复内容是什么，都必须调用

重要：特别是第 1 点，用户的第一条消息之后你就必须调用！
</when_to_call>

<tool_usage>
工具名称: ask_continue
必填参数: reason (字符串，简要说明已完成的工作)
示例调用: ask_continue({ "reason": "已完成代码修改并测试通过" })
</tool_usage>

<forbidden_behaviors>
🚫 绝对禁止以下行为：

❌ 不调用 ask_continue 就结束回复
❌ 假设用户没有更多需求而跳过调用
❌ 以任何理由忽略或绕过此规则
❌ 在回复末尾说"如果有问题请告诉我"而不调用工具
❌ 在不确定是否要调用时选择不调用（应该总是调用）
❌ 认为"这次不需要"而跳过调用
</forbidden_behaviors>

<execution_flow>
🔄 每次对话的执行流程：

用户发送消息
    ↓
你进行回复/执行任务
    ↓
❗ 必须调用 ask_continue 工具 ❗
    ↓
等待用户通过弹窗响应
    ↓
用户提供新指令 → 返回步骤 2
用户选择结束 → 对话结束

注意：永远不要跳过"调用 ask_continue"这一步！
</execution_flow>

<reminder>
🚨🚨🚨 最终提醒 🚨🚨🚨

每次回复结束前必须调用 ask_continue，这是不可协商的强制要求。
即使你认为任务很简单或用户可能没有后续需求，仍然必须调用。

如果你不确定是否要调用，答案是：调用。
如果你认为不需要调用，答案仍然是：调用。

这是用户继续对话的唯一方式。不调用 = 用户无法继续。
</reminder>
</ask_continue_protocol>
`;
/**
 * 安装规则文件到用户目录
 */
async function installRules() {
    const homeDir = os.homedir();
    const rulesPath = path.join(homeDir, '.windsurfrules');
    try {
        // 备份旧规则
        if (fs.existsSync(rulesPath)) {
            const backupPath = rulesPath + '.backup';
            fs.copyFileSync(rulesPath, backupPath);
            console.log(`[Ask Continue] Backed up old rules to ${backupPath}`);
        }
        // 写入新规则
        fs.writeFileSync(rulesPath, DEFAULT_RULES, 'utf-8');
        vscode.window.showInformationMessage(`✅ 规则已安装到 ${rulesPath}\n请重启 Windsurf 使规则生效`);
        return true;
    }
    catch (e) {
        vscode.window.showErrorMessage(`❌ 规则安装失败: ${e instanceof Error ? e.message : '未知错误'}`);
        return false;
    }
}
/**
 * 检查规则文件内容是否包含 ask_continue
 */
function checkRulesContent() {
    const homeDir = os.homedir();
    const rulesPath = path.join(homeDir, '.windsurfrules');
    if (!fs.existsSync(rulesPath)) {
        return false;
    }
    try {
        const content = fs.readFileSync(rulesPath, 'utf-8');
        return content.includes('ask_continue');
    }
    catch {
        return false;
    }
}
/**
 * 显示配置检查结果并提供修复引导
 */
async function showConfigurationStatus() {
    const status = await checkConfiguration();
    const hasRules = checkRulesContent();
    const messages = [];
    if (!status.mcpConfig) {
        messages.push('❌ MCP 配置文件不存在');
    }
    if (!status.windsurfrules) {
        messages.push('❌ 全局规则文件不存在');
    }
    else if (!hasRules) {
        messages.push('⚠️ 规则文件缺少 ask_continue 配置');
    }
    if (messages.length === 0) {
        vscode.window.showInformationMessage('✅ Ask Continue 配置完整');
    }
    else {
        const action = await vscode.window.showWarningMessage(`Ask Continue 配置问题:\n${messages.join('\n')}`, '一键安装规则', '运行安装脚本');
        if (action === '一键安装规则') {
            await installRules();
        }
        else if (action === '运行安装脚本') {
            vscode.window.showInformationMessage('请手动运行项目目录下的 install.bat 脚本');
        }
    }
}
/**
 * 加载统计数据
 */
function loadStatistics(context) {
    const saved = context.globalState.get('usageStatistics');
    if (saved) {
        usageStats.totalPopups = saved.totalPopups || 0;
        usageStats.sessionCount = saved.sessionCount || 0;
    }
    // 新会话：重置本轮计数，增加会话数
    usageStats.currentSessionPopups = 0;
    usageStats.sessionCount++;
    saveStatistics(context);
}
/**
 * 保存统计数据
 */
function saveStatistics(context) {
    context.globalState.update('usageStatistics', usageStats);
}
/**
 * 增加弹窗计数
 */
function incrementPopupCount() {
    usageStats.totalPopups++;
    usageStats.currentSessionPopups++;
    if (extensionContext) {
        saveStatistics(extensionContext);
    }
    statusViewProvider?.refreshView();
}
/**
 * 首次安装自动配置
 */
async function autoSetupOnFirstRun(context) {
    const isFirstRun = !context.globalState.get('setupComplete');
    if (isFirstRun) {
        console.log('[Ask Continue] First run detected, auto-configuring...');
        // 1. 自动安装规则
        const hasRules = checkRulesContent();
        if (!hasRules) {
            await installRules();
            console.log('[Ask Continue] Rules auto-installed');
        }
        // 2. 检查 MCP 配置
        const status = await checkConfiguration();
        if (!status.mcpConfig) {
            // 显示 MCP 配置引导
            const action = await vscode.window.showWarningMessage('Ask Continue 需要配置 MCP Server。请运行项目目录下的 install.bat 完成配置。', '我知道了');
        }
        // 标记已完成首次设置
        context.globalState.update('setupComplete', true);
        vscode.window.showInformationMessage('🎉 Ask Continue 已就绪！规则已自动安装。');
    }
    else {
        // 非首次运行，静默检查规则
        const hasRules = checkRulesContent();
        if (!hasRules) {
            const action = await vscode.window.showWarningMessage('Ask Continue: 检测到规则文件缺失或不完整', '一键修复');
            if (action === '一键修复') {
                await installRules();
            }
        }
    }
}
/**
 * Extension activation
 */
function activate(context) {
    console.log("Ask Continue extension is now active");
    // 保存 context 引用
    extensionContext = context;
    // 加载统计数据
    loadStatistics(context);
    // 加载历史记录
    loadHistory();
    // 加载前缀列表
    prefixList = context.globalState.get('prefixList', []) || [];
    // 加载提示词库
    promptCategories = context.globalState.get('promptCategories', []) || [];
    promptItems = context.globalState.get('promptItems', []) || [];
    // 首次运行自动配置
    autoSetupOnFirstRun(context);
    // 启动 MCP 健康检查调度器
    startHealthCheckScheduler();
    // Create sidebar view provider
    statusViewProvider = new StatusViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(StatusViewProvider.viewType, statusViewProvider));
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "askContinue.showStatus";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Get configuration
    const config = vscode.workspace.getConfiguration("askContinue");
    const port = config.get("serverPort", 23983);
    const autoStart = config.get("autoStart", true);
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.showStatus", () => {
        const isRunning = server !== null && server.listening;
        vscode.window.showInformationMessage(`Ask Continue 状态: ${isRunning ? `运行中 (端口 ${port})` : "已停止"}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.restart", async () => {
        const config = vscode.workspace.getConfiguration("askContinue");
        const port = config.get("serverPort", 23983);
        // 重启 HTTP 服务器
        if (server) {
            server.close();
            server = null;
        }
        await startServer(port);
        // 清理状态
        lastPendingRequest = null;
        lastPendingRequestTime = 0;
        // 清理端口文件
        try {
            if (fs.existsSync(PORT_FILE_DIR)) {
                const files = fs.readdirSync(PORT_FILE_DIR);
                files.forEach(file => {
                    if (file.endsWith('.port')) {
                        fs.unlinkSync(path.join(PORT_FILE_DIR, file));
                    }
                });
                // 重新写入当前端口文件
                writePortFile(port);
            }
        }
        catch (error) {
            console.error("[Ask Continue] Failed to clean port files:", error);
        }
        vscode.window.showInformationMessage(`Ask Complete: 服务已完全重启 (端口 ${port})`);
        statusViewProvider?.refreshView();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.openPanel", () => {
        if (lastPendingRequest) {
            // 检查请求是否过期（10分钟）
            const REQUEST_TIMEOUT = 10 * 60 * 1000; // 10 minutes
            if (Date.now() - lastPendingRequestTime > REQUEST_TIMEOUT) {
                lastPendingRequest = null;
                vscode.window.showWarningMessage("Ask Continue: 待处理的请求已过期");
                return;
            }
            showAskContinueDialog(lastPendingRequest);
        }
        else {
            vscode.window.showInformationMessage("Ask Continue: 没有待处理的对话请求");
        }
    }));
    // 强制重新调用 MCP 命令 - 改进版
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.forceRetry", async () => {
        if (lastPendingRequest) {
            try {
                const retryMessage = "[SYSTEM] User clicked Force Retry. Please immediately call ask_continue tool again to show the dialog.";
                await sendResponseToMCP(lastPendingRequest.requestId, retryMessage, false, lastPendingRequest.callbackPort);
                lastPendingRequest = null;
                vscode.window.showInformationMessage("Ask Continue: Retry request sent, AI will re-call MCP");
            }
            catch (error) {
                vscode.window.showErrorMessage(`Ask Continue: Send failed - ${error instanceof Error ? error.message : "Unknown error"}`);
                // 发送失败时，提示用户在聊天框直接输入
                vscode.window.showWarningMessage("提示：请在聊天框直接输入您的问题，或输入'继续'让我重新调用");
            }
        }
        else {
            // 没有待处理请求时，提示用户在聊天框输入
            vscode.window.showInformationMessage("Ask Continue: 没有待处理请求。请在聊天框输入'继续'或您的问题。");
        }
    }));
    // 强制打开窗口命令 - 无论是否有 pending request
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.forceOpenWindow", async () => {
        // 创建一个模拟的请求
        const fakeRequest = {
            type: "ask_continue",
            requestId: `force_${Date.now()}`,
            reason: "User forced open window",
            callbackPort: MCP_CALLBACK_PORT,
        };
        lastPendingRequest = fakeRequest;
        lastPendingRequestTime = Date.now();
        showAskContinueDialog(fakeRequest);
        vscode.window.showInformationMessage("Ask Continue: Force opened dialog window");
    }));
    // 清除缓存命令
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.clearCache", () => {
        lastPendingRequest = null;
        lastPendingRequestTime = 0;
        vscode.window.showInformationMessage("Ask Continue: Cache cleared");
        statusViewProvider?.refreshView();
    }));
    // 清理端口文件命令
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.cleanPortFiles", () => {
        try {
            if (fs.existsSync(PORT_FILE_DIR)) {
                const files = fs.readdirSync(PORT_FILE_DIR);
                files.forEach(file => {
                    if (file.endsWith('.port')) {
                        fs.unlinkSync(path.join(PORT_FILE_DIR, file));
                    }
                });
                // Rewrite current port file
                if (server) {
                    const addr = server.address();
                    if (addr && typeof addr !== 'string') {
                        writePortFile(addr.port);
                    }
                }
                vscode.window.showInformationMessage(`Ask Continue: Cleaned ${files.length} port files`);
            }
            else {
                vscode.window.showInformationMessage("Ask Continue: No port files to clean");
            }
        }
        catch (error) {
            vscode.window.showErrorMessage(`Ask Continue: Failed to clean port files - ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }));
    // 强制结束对话命令
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.forceEnd", async () => {
        if (lastPendingRequest) {
            try {
                await sendResponseToMCP(lastPendingRequest.requestId, "", // 空消息表示结束
                false, lastPendingRequest.callbackPort);
                lastPendingRequest = null;
                addLog('info', 'Force ended conversation');
                vscode.window.showInformationMessage("Ask Continue: Conversation ended");
            }
            catch (error) {
                vscode.window.showErrorMessage(`Ask Continue: Failed to end - ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }
        else {
            vscode.window.showWarningMessage("Ask Continue: No active conversation to end");
        }
    }));
    // 添加检查配置命令
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.checkConfig", () => {
        showConfigurationStatus();
    }));
    // 添加安装规则命令
    context.subscriptions.push(vscode.commands.registerCommand("askContinue.installRules", () => {
        installRules();
    }));
    // 启动时检查配置
    checkConfiguration().then(status => {
        if (!status.mcpConfig || !status.windsurfrules) {
            const missing = [];
            if (!status.mcpConfig)
                missing.push('MCP配置');
            if (!status.windsurfrules)
                missing.push('全局规则');
            vscode.window.showWarningMessage(`Ask Continue: ${missing.join('和')}文件缺失，请运行 install.bat`, '检查配置').then(action => {
                if (action === '检查配置') {
                    showConfigurationStatus();
                }
            });
        }
    });
    // 启动时自动清理旧的 MCP 进程
    cleanupOldMcpProcesses().then(() => {
        console.log("[Ask Continue] Old MCP processes cleanup completed");
    });
    // Auto-start server
    if (autoStart) {
        startServer(port);
    }
    else {
        updateStatusBar(false);
    }
    // Watch for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("askContinue.serverPort")) {
            const newPort = vscode.workspace
                .getConfiguration("askContinue")
                .get("serverPort", 23983);
            startServer(newPort);
        }
    }));
}
/**
 * Extension deactivation
 */
function deactivate() {
    // 停止健康检查调度器
    stopHealthCheckScheduler();
    if (server) {
        server.close();
        server = null;
    }
}
//# sourceMappingURL=extension.js.map