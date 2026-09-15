# Chrome Nano AI Chat ⚡

> 基于 Google Chrome 内置端侧大模型（Gemini Nano）打造的高颜值、全功能、100% 纯本地运行的 AI 工作台。

## 🌟 特性亮点

- 🛡️ **100% 纯本地离线运行**：数据不离机，零 API Key，不产生任何流量费与 Token 消费，完全免费；
- 📦 **零公共 CDN 依赖（全本地承载）**：Vue 3、Marked、KaTeX、Highlight.js 与字体资源全部保存在本地 `assets/vendor/` 目录下，部署到自己的内网或公网服务器完全自承载；
- 💬 **全功能自由对话 (Prompt API)**：支持字字流式输出（`promptStreaming`）、多轮记忆上下文、分支克隆（Session Forking）、Markdown 渲染；
- 📐 **学术 LaTeX 数学公式实时排版**：内置 KaTeX 引擎，支持行内公式 `$E=mc^2$` 与独立行公式 `$$\int_a^b f(x)dx$$`；
- 📝 **SCI 文献一键摘要 (Summarizer API)**：支持 `Key-points`（创新要点提取）、`TL;DR`（极速结论速读）、`Headline` 等多种模式；
- ✨ **学术英语高级润色 (Rewriter API)**：支持一键将中式英语改写为符合 Nature / IEEE 顶级期刊标准的学术严谨风；
- ✍️ **学术写作起草 (Writer API)**：辅助起草审稿人答辩回复（Rebuttal）、学术邀请函、论文 Abstract 框架；
- 🎭 **专业角色库**：内置 SCI 苛刻审稿人（Reviewer #2）、资深博导导师、学术母语编辑、全栈架构师、费曼学习导师；
- 📊 **Token 占用监控表盘**：实时跟踪会话上下文长度与剩余空间，防止超出上下文限制；
- 🌓 **现代深浅双色玻璃拟态 UI**：支持跟随系统明暗自适应与一键手动切换。

---

## 🚀 运行与部署指南

由于本项目所有前端静态资源（JS/CSS/Fonts）均已全部本地化打包，**无需经过复杂的构建编译即可直接运行**：

### 方式一：直接使用任意静态服务器托管（推荐）

你可以直接将整个文件夹扔到自己的 Nginx、Caddy、Apache、EdgeOne、Cloudflare Pages 或宝塔面板上：

```nginx
# Nginx 示例配置
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/chrome-nano-ai-chat;
    index index.html;
}
```

### 方式二：本地快速预览（Node / Python / Live Server）

在当前目录下执行任意命令即可启动本地服务：

```bash
# Python
python -m http.server 8080

# 或 Node / npx
npx serve .
```

然后在 Chrome 浏览器中访问 `http://localhost:8080` 即可。

---

## 🛠️ Chrome 浏览器前置开启说明

本项目运行依赖 Google Chrome 内置的端侧模型：

1. 请确保使用 **Google Chrome 138+** 或 Chrome Canary / Dev 版本；
2. 在 Chrome 地址栏输入并打开：
   - `chrome://flags/#optimization-guide-on-device-model` $\to$ 设为 **Enabled BypassPerfRequirement**
   - `chrome://flags/#prompt-api-for-gemini-nano` $\to$ 设为 **Enabled**
   - （如需摘要与润色）`chrome://flags/#summarization-api-for-gemini-nano` $\to$ 设为 **Enabled**
   - （如需摘要与润色）`chrome://flags/#rewriter-api-for-gemini-nano` $\to$ 设为 **Enabled**
3. 重启 Chrome 浏览器；
4. 访问 `chrome://components`，找到 **Optimization Guide On Device Model**，点击“检查更新”确保模型下载完毕。

---

## 📄 开源协议

MIT License
