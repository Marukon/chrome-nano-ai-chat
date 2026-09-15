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
  autoScroll: true,
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
        messages: Array.isArray(s.messages) ? s.messages : [],
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
    md += `## 🎛️ 参数设置\n\n${Object.entries(s.options).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\n`
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
