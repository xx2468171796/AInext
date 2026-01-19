#!/usr/bin/env node
/**
 * 牛马模式 - 弹窗触发脚本
 * 跨平台：Windows/Mac/Linux
 * 
 * 用法：node dialog-trigger.js "AI想要结束的原因" [工作区路径]
 * 
 * 多窗口支持：
 * - 如果提供工作区路径，会使用工作区特定的请求/响应文件
 * - 如果不提供，使用全局文件（兼容旧版本）
 * 
 * 流程：
 * 1. 写入请求文件，触发扩展弹窗
 * 2. 等待用户响应
 * 3. 读取响应并输出
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const niumaDir = path.join(os.homedir(), '.alone-mcp');

// 获取 AI 摘要和工作区路径
const summary = process.argv[2] || 'AI has completed the task.';
const workspacePath = process.argv[3] || null;

// 计算工作区ID（与扩展使用相同的哈希算法）
function getWorkspaceId(wsPath) {
  if (!wsPath) return null;
  let hash = 0;
  for (let i = 0; i < wsPath.length; i++) {
    hash = ((hash << 5) - hash) + wsPath.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

const workspaceId = getWorkspaceId(workspacePath);

// 根据工作区ID确定请求/响应文件路径
const requestFile = workspaceId 
  ? path.join(niumaDir, `dialog_request_${workspaceId}.json`)
  : path.join(niumaDir, 'dialog_request.json');
const responseFile = workspaceId 
  ? path.join(niumaDir, `dialog_response_${workspaceId}.json`)
  : path.join(niumaDir, 'dialog_response.json');

// 确保目录存在
if (!fs.existsSync(niumaDir)) {
  fs.mkdirSync(niumaDir, { recursive: true });
}

// 生成请求 ID
const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 删除旧的响应文件
try {
  if (fs.existsSync(responseFile)) {
    fs.unlinkSync(responseFile);
  }
} catch (e) {}

// 写入请求文件
const request = {
  timestamp: Date.now(),
  summary: summary,
  requestId: requestId,
  workspaceId: workspaceId  // 包含工作区ID用于验证
};

fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), 'utf8');

// 轮询等待响应
const maxWait = 600000; // 10分钟超时
const pollInterval = 300; // 300ms 轮询
let waited = 0;

const checkResponse = () => {
  waited += pollInterval;
  
  try {
    if (fs.existsSync(responseFile)) {
      const content = fs.readFileSync(responseFile, 'utf8');
      const response = JSON.parse(content);
      
      // 验证是否是当前请求的响应
      if (response.requestId === requestId || !response.requestId) {
        // 输出响应
        console.log('ACTION:', response.action || 'continue');
        console.log('FEEDBACK:', response.feedback || '');
        if (response.images && response.images.length > 0) {
          console.log('IMAGES:', response.images.join(','));
        }
        
        // 清理文件
        try {
          fs.unlinkSync(responseFile);
          fs.unlinkSync(requestFile);
        } catch (e) {}
        
        process.exit(0);
      }
    }
  } catch (e) {
    // 文件可能还在写入中，继续等待
  }
  
  if (waited >= maxWait) {
    console.log('ACTION: timeout');
    console.log('FEEDBACK: No response received within 10 minutes');
    process.exit(1);
  }
  
  setTimeout(checkResponse, pollInterval);
};

// 开始轮询
setTimeout(checkResponse, pollInterval);
