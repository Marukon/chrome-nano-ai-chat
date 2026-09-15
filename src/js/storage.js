/**
 * 本地持久化与数据导出模块 (100% 纯本地运行)
 */
import { MODE_META } from './presets.js'

const STORAGE_KEYS = {
  SESSIONS: 'nano_ai_sessions_v1',
  ACTIVE_ID: 'nano_ai_active_id_v1',
  SETTINGS: 'nano_ai_settings_v1',
}

const DEFAULT_SETTINGS = {
  theme: 'auto', // 'auto' | 'light' | 'dark'
  temperature: 0.7,
  topK: 3,
  defaultRole: 'general',
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }
  } catch (e) {
    console.error('Failed to load settings:', e)
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings))
  } catch (e) {
    console.error('Failed to save settings:', e)
  }
}

export function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSIONS)
    if (!raw) return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    // 兼容历史/损坏数据：过滤非法项并补全必需字段，避免渲染时崩溃
    return list
      .filter(s => s && typeof s === 'object' && s.id)
      .map(s => ({
        ...s,
        mode: s.mode || 'chat',
        messages: Array.isArray(s.messages) ? s.messages : [],
        studio: s.studio && typeof s.studio === 'object' ? s.studio : undefined,
        title: s.title || '未命名对话',
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || s.createdAt || Date.now(),
      }))
  } catch (e) {
    console.error('Failed to load sessions:', e)
    return []
  }
}

export function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sessions))
  } catch (e) {
    console.error('Failed to save sessions:', e)
  }
}

export function loadActiveSessionId() {
  return localStorage.getItem(STORAGE_KEYS.ACTIVE_ID) || ''
}

export function saveActiveSessionId(id) {
  localStorage.setItem(STORAGE_KEYS.ACTIVE_ID, id)
}

/** 触发浏览器下载 */
function downloadMarkdown(md, title) {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(title || 'chat').replace(/[/\\?%*:|"<>]/g, '_')}_${Date.now()}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 把生成的脚本导出为 .txt 文件
 * 自动剥掉 Markdown 代码围栏与行号，得到可直接运行的纯脚本
 */
export function exportScriptAsTxt(content, language = 'bash', title = 'script') {
  if (!content) return

  const ext = { bat: 'bat', powershell: 'ps1', bash: 'sh' }[language] || 'txt'
  const isWindows = language === 'bat' || language === 'powershell'

  let body = String(content)

  // 若包含代码围栏，优先抽取围栏内的脚本本体（取第一个代码块）
  const fenceRe = /```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/
  const matched = body.match(fenceRe)
  if (matched) body = matched[1]

  // 统一换行后按目标平台输出：Windows 用 CRLF，Linux/macOS 用 LF
  body = body.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd()
  const eol = isWindows ? '\r\n' : '\n'
  body = body.split('\n').join(eol)

  // Windows 必须带 UTF-8 BOM，否则 cmd / Windows PowerShell 5.1 会按 ANSI 解析导致中文注释乱码；
  // Linux/macOS 绝不能加 BOM，否则 shebang 失效报 bad interpreter
  const text = (isWindows ? '\ufeff' : '') + body + eol
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${String(title).replace(/[/\\?%*:|"<>]/g, '_')}_${Date.now()}.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出工具（Studio）记录为 Markdown */
function exportStudioToMarkdown(session) {
  const meta = MODE_META[session.mode] || { label: session.mode, icon: '📄' }
  const s = session.studio || {}
  let md = `# ${meta.icon} ${session.title || meta.label}\n\n`
  md += `> 功能：${meta.label}\n`
  md += `> 创建时间：${new Date(session.createdAt || Date.now()).toLocaleString()}\n\n---\n\n`

  if (s.prompt) md += `## 🎯 主题\n\n${s.prompt}\n\n`
  if (s.comment) md += `## 🗣️ 审稿人意见\n\n${s.comment}\n\n`
  if (s.response) md += `## ✍️ 作者答辩要点\n\n${s.response}\n\n`
  if (s.context) md += `## 📎 补充上下文\n\n${s.context}\n\n`
  if (s.input) md += `## 📥 输入内容\n\n${s.input}\n\n`
  if (s.options && Object.keys(s.options).length) {
    // 参数 key 是英文，导出时补一层中文说明，便于阅读
    const OPTION_LABELS = {
      type: '类型', length: '长度', style: '输出形式', tone: '语气',
      standard: '审校标准', lang: '代码语言', type_: '脚本类型',
      from: '源语言', to: '目标语言',
    }
    const lines = Object.entries(s.options)
      .map(([k, v]) => `- ${OPTION_LABELS[k] || k}: ${v}`)
      .join('\n')
    md += `## 🎛️ 参数设置\n\n${lines}\n\n`
  }
  md += `## 📤 输出结果\n\n${s.output || '（无输出）'}\n`

  downloadMarkdown(md, session.title || meta.label)
}

/**
 * 将当前会话导出为干净规整的 Markdown 文件
 * 同时支持「自由对话」与「工具记录」
 */
export function exportSessionToMarkdown(session) {
  if (!session) return

  // 工具记录（论文摘要 / 润色 / 起草 / 答辩 / 纠错 / 代码审查）
  if (session.mode && session.mode !== 'chat') {
    exportStudioToMarkdown(session)
    return
  }

  if (!session.messages || session.messages.length === 0) return

  let md = `# ${session.title || 'Chrome Nano AI 对话记录'}\n\n`
  md += `> 创建时间：${new Date(session.createdAt || Date.now()).toLocaleString()}\n`
  if (session.systemPrompt) {
    md += `> 系统角色设定：${session.systemPrompt}\n`
  }
  md += `\n---\n\n`

  for (const msg of session.messages) {
    const roleName = msg.role === 'user' ? '👤 **用户 (User)**' : '🤖 **Gemini Nano (Assistant)**'
    const time = msg.timestamp ? ` *(${new Date(msg.timestamp).toLocaleTimeString()})*` : ''
    md += `### ${roleName}${time}\n\n`
    md += `${msg.content}\n\n`
    md += `---\n\n`
  }

  downloadMarkdown(md, session.title || 'Chrome Nano AI 对话记录')
}
