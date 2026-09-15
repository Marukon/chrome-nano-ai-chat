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

> ⚠️ **必须先编译再部署**：仓库中**不再包含**根目录 `index.html` 与 `assets/css`、`assets/js` 下的业务产物（已在 `.gitignore` 中忽略）。
> 任何环境（本地预览 / Nginx / EdgeOne / Cloudflare Pages 等）都必须先执行构建命令生成入口文件后才能访问。

### 第 0 步：编译生成入口文件（必做）

```bash
# npm（唯一推荐，零第三方依赖）
npm run build

# 等价直接调用
node scripts/build.js

# 仅清理产物，不构建
npm run clean
```

构建完成后会自动生成根目录 `index.html` 与带版本号的资源文件。

| 产物 | 示例文件名 |
| --- | --- |
| 样式表 | `assets/css/style.v1.1.0.3f9a2c1b.css` |
| 主程序 | `assets/js/app.v1.1.0.3f9a2c1b.js` |
| 模块 | `assets/js/chrome-ai.v1.1.0.3f9a2c1b.js` 等 |

命名规则为 `<name>.v<package.json 版本>.<8 位随机哈希>.<ext>`：版本号便于线上定位与回滚，随机哈希保证每次构建都是全新 URL、CDN 必然回源。版本清单写在 `assets/manifest.json`。

> ⚠️ 构建仅支持 Node.js（`npm run build`）。项目已移除 Python 构建脚本——部分构建平台的 `python` 仍是 Python 2，无法运行。

### 方式一：使用任意静态服务器托管（推荐）

构建完成后，将整个文件夹放到 Nginx、Caddy、Apache、EdgeOne、Cloudflare Pages 或宝塔面板上：

```nginx
# Nginx 示例配置
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/chrome-nano-ai-chat;
    index index.html;
}
```

> EdgeOne 等平台的构建命令请填写 `npm run build`，输出目录填仓库根目录。

### 方式二：本地快速预览

```bash
# 一步完成：构建并启动本地服务
npm run dev

# 或先构建，再单独启动
npm run build
npx serve .
```

然后在 Chrome 浏览器中访问 `http://localhost:8080` 即可。

---

## 🔨 源码开发与版本化构建

EdgeOne 等现代 CDN 通常对静态资源（`.js` / `.css`）配置了较长缓存周期（例如 30 天 `max-age=2592000`）。为了确保每次发布更新后 CDN 边缘节点能够**立即分发最新代码**且不受旧缓存影响，本项目提供全自动版本化构建：

- **基准源码**：存放于 `src/` 目录中（`src/index.html`、`src/css/style.css`、`src/js/*.js`）；
- **执行构建**：
  ```bash
  npm run build        # 等价于 node scripts/build.js
  npm run clean        # 仅清理产物
  ```
- **自动处理**：
  1. 清空上一次构建遗留的旧版本文件（避免历史哈希文件永久堆积）；
  2. 读取 `package.json` 的版本号，并生成 8 位随机哈希，组合成版本标识（如 `v1.1.0.3f9a2c1b`）；
  3. 将业务 CSS/JS 输出为带版本号的文件名（如 `style.v1.1.0.3f9a2c1b.css`、`app.v1.1.0.3f9a2c1b.js`）；
  4. 自动解析并重写 `app.v1.1.0.3f9a2c1b.js` 内部的 ES 模块依赖导入路径；
  5. 自动同步更新根目录 `index.html` 外部引用路径与 `assets/manifest.json` 版本清单。

> 仓库中不包含任何静态产物，根目录 `index.html`、`assets/css/`、`assets/js/`、`assets/manifest.json` 均在 `.gitignore` 中，必须构建后才会出现。

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
