/**
 * 本地持久化与数据导出模块 (100% 纯本地运行)
 */
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
    return JSON.parse(raw)
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

/**
 * 将当前会话导出为干净规整的 Markdown 文件
 */
export function exportSessionToMarkdown(session) {
  if (!session || !session.messages || session.messages.length === 0) return

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

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(session.title || 'chat').replace(/[/\\?%*:|"<>]/g, '_')}_${Date.now()}.md`
  a.click()
  URL.revokeObjectURL(url)
}
