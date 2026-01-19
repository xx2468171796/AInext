# Alone模式 - AI持久输出助手

> 让 AI 不再偷懒，持续工作直到你满意

## 📖 简介

**Alone模式** 是一个 VSCode/Windsurf 扩展，通过在 AI 想要结束对话时弹出确认窗口，让用户决定是否继续或结束。这样可以让 AI 持续工作，避免 AI "偷懒"提前结束任务。

## ✨ 核心功能

### 1. 🔔 弹窗确认机制
- AI 想结束时自动弹出确认窗口
- 用户可以选择「继续」或「结束」
- 支持输入反馈指令让 AI 继续工作
- 支持图片上传（Ctrl+V 粘贴 / Ctrl+U 上传）

### 2. ✨ AI 提示词优化
基于智谱 AI 编程套餐，优化你的输入提示词：

| 功能 | 说明 |
|------|------|
| **模型选择** | 支持 GLM-4.7/4.6/4.5 系列，可自定义输入 |
| **思考模式** | 开启/关闭深度思考 |
| **Max Tokens** | 自定义 100-8000 |
| **预设提示词** | 自定义预设 + 用户内容组合 |

### 3. 📊 统计功能
- 累计弹窗次数
- 会话数统计
- 本轮交互次数
- 可单独重置

### 4. 🎵 自定义提示音
- 支持自定义 WAV 提示音
- 内置默认提示音
- 可测试播放

### 5. 📚 历史记录
- 自动保存对话历史
- 可加载历史上下文
- 支持清空历史

## 🚀 安装方法

1. 下载最新版本 `.vsix` 文件
2. 在 VSCode/Windsurf 中：
   - 按 `Ctrl+Shift+P`
   - 输入 `Extensions: Install from VSIX...`
   - 选择下载的 `.vsix` 文件
3. 重启编辑器

## ⚙️ 配置说明

### AI 优化提示词配置

在侧边栏「Alone模式」面板中配置：

1. **启用 AI 优化** - 开关
2. **平台选择** - 智谱 Zhipu
3. **API Key** - 从 [智谱开放平台](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) 获取
4. **API URL** - `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`
5. **模型** - 默认 GLM-4.7
6. **思考模式** - 默认关闭（加速）
7. **预设提示词** - 可选

### 弹窗触发脚本

扩展会自动在工作区创建 `.windsurfrules` 文件，配置 AI 结束时的弹窗触发命令。

## 📁 项目结构

```
lixiangniuma/
├── niuma-vsix-unpacked/
│   └── extension/
│       ├── extension.js      # 扩展主逻辑
│       ├── webview.html      # 侧边栏 UI
│       ├── dialog.html       # 弹窗 UI（备用）
│       ├── alonemoshi.js     # 弹窗触发脚本
│       ├── package.json      # 扩展配置
│       ├── default_sound.wav # 默认提示音
│       └── icon.ico          # 扩展图标
├── .windsurfrules            # Windsurf AI 规则
└── README.md                 # 本文档
```

## 🔧 技术栈

- **VSCode Extension API** - 扩展开发框架
- **Webview** - 侧边栏和弹窗 UI
- **Node.js** - 弹窗触发脚本
- **智谱 AI API** - 提示词优化

## 📝 更新日志

### v4.1.1 (2026-01-19)
- 移除 QQ 群信息

### v4.1.0
- 弹窗支持自定义模型输入
- 弹窗支持自定义 maxTokens (100-8000)
- 默认模型改为 GLM-4.7（付费模型）

### v4.0.x
- 品牌重命名 niuma → alone
- 集成智谱编程套餐 API
- 添加多模型选择
- 添加思考模式开关
- 添加自定义预设提示词
- 优化响应速度

## 📄 License

MIT License

---

**Alone模式** - 让 AI 持续工作，直到你满意 🚀
