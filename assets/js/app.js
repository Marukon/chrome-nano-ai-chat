import { createApp, ref, computed, watch, nextTick, onMounted } from '../vendor/vue.esm.js'
import { marked } from '../vendor/marked.esm.js'
import { ChromeAIService } from './chrome-ai.js'
import { ROLE_PRESETS } from './presets.js'
import {
  loadSessions,
  saveSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  loadSettings,
  saveSettings,
  exportSessionToMarkdown
} from './storage.js'

createApp({
  setup() {
    // 状态定义
    const currentMode = ref('chat') // 'chat' | 'summarizer' | 'rewriter' | 'writer'
    const settings = ref(loadSettings())
    const sessions = ref(loadSessions())
    const activeSessionId = ref(loadActiveSessionId())
    const sidebarOpen = ref(true)
    const settingsModalOpen = ref(false)
    const roleModalOpen = ref(false)

    // AI 就绪状态
    const aiStatus = ref({
      prompt: 'checking',
      summarizer: 'checking',
      rewriter: 'checking',
      writer: 'checking'
    })

    // 对话区状态
    const currentInput = ref('')
    const isGenerating = ref(false)
    const activeAiSession = ref(null)
    const abortController = ref(null)
    const chatContainerRef = ref(null)
    const currentTokensSoFar = ref(0)
    const maxTokensLimit = ref(4096)

    // Summarizer 模式状态
    const summarizeInput = ref('')
    const summarizeOutput = ref('')
    const summarizeType = ref('key-points')
    const summarizeLength = ref('medium')
    const summarizeFormat = ref('markdown')
    const isSummarizing = ref(false)

    // Rewriter 模式状态
    const rewriteInput = ref('')
    const rewriteOutput = ref('')
    const rewriteTone = ref('more-formal')
    const rewriteLength = ref('as-is')
    const isRewriting = ref(false)

    // Writer 模式状态
    const writePrompt = ref('')
    const writeContext = ref('')
    const writeOutput = ref('')
    const writeTone = ref('formal')
    const writeLength = ref('medium')
    const isWriting = ref(false)

    // 计算当前活跃会话
    const activeSession = computed(() => {
      return sessions.value.find(s => s.id === activeSessionId.value) || null
    })

    // 当前选中的预设角色
    const currentRole = computed(() => {
      const roleId = activeSession.value?.roleId || settings.value.defaultRole || 'general'
      return ROLE_PRESETS.find(r => r.id === roleId) || ROLE_PRESETS[0]
    })

    // Markdown 解析与 LaTeX 公式渲染器
    function renderMarkdown(content) {
      if (!content) return ''

      try {
        // 先保护并渲染 LaTeX 公式: $$...$$ 与 $...$
        let processed = content
        // 独立行公式
        processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_, equation) => {
          try {
            if (window.katex) {
              return `<div class="katex-display">${window.katex.renderToString(equation.trim(), { displayMode: true, throwOnError: false })}</div>`
            }
          } catch (e) {}
          return `$$${equation}$$`
        })

        // 行内公式
        processed = processed.replace(/\$([^\$\n]+?)\$/g, (_, equation) => {
          try {
            if (window.katex) {
              return window.katex.renderToString(equation.trim(), { displayMode: false, throwOnError: false })
            }
          } catch (e) {}
          return `$${equation}$`
        })

        // 配置代码高亮
        marked.setOptions({
          highlight: function (code, lang) {
            if (window.hljs) {
              const language = hljs.getLanguage(lang) ? lang : 'plaintext'
              return hljs.highlight(code, { language }).value
            }
            return code
          },
          breaks: true
        })

        return marked.parse(processed)
      } catch (e) {
        console.error('Markdown parse error:', e)
        return content
      }
    }

    // 初始化检查 AI 支持
    async function checkSystemAI() {
      const status = await ChromeAIService.checkStatus()
      aiStatus.value = status
    }

    // 切换模式
    function setMode(mode) {
      currentMode.value = mode
    }

    // 新建会话
    function createNewSession(roleId = settings.value.defaultRole) {
      const role = ROLE_PRESETS.find(r => r.id === roleId) || ROLE_PRESETS[0]
      const newSession = {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: '新对话',
        roleId: role.id,
        systemPrompt: role.systemPrompt,
        temperature: settings.value.temperature,
        topK: settings.value.topK,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      sessions.value.unshift(newSession)
      activeSessionId.value = newSession.id
      activeAiSession.value = null
      currentTokensSoFar.value = 0
      saveSessions(sessions.value)
      saveActiveSessionId(newSession.id)
      scrollToBottom()
    }

    // 选择会话
    function selectSession(id) {
      activeSessionId.value = id
      saveActiveSessionId(id)
      activeAiSession.value = null
      currentTokensSoFar.value = 0
      scrollToBottom()
    }

    // 删除会话
    function deleteSession(id) {
      sessions.value = sessions.value.filter(s => s.id !== id)
      saveSessions(sessions.value)
      if (activeSessionId.value === id) {
        if (sessions.value.length > 0) {
          selectSession(sessions.value[0].id)
        } else {
          createNewSession()
        }
      }
    }

    // 克隆会话分支 (Session Forking)
    function cloneSession(sourceSession) {
      if (!sourceSession) return
      const cloned = {
        ...JSON.parse(JSON.stringify(sourceSession)),
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: `${sourceSession.title} (分支)`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      sessions.value.unshift(cloned)
      selectSession(cloned.id)
    }

    // 滚动至最新消息
    function scrollToBottom() {
      nextTick(() => {
        if (chatContainerRef.value) {
          chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight
        }
      })
    }

    // 发送消息
    async function sendMessage() {
      const text = currentInput.value.trim()
      if (!text || isGenerating.value) return

      if (!activeSession.value) {
        createNewSession()
      }

      // 添加用户消息
      const userMsg = {
        id: `msg_${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now()
      }
      activeSession.value.messages.push(userMsg)
      currentInput.value = ''

      // 首条消息自动命名会话
      if (activeSession.value.messages.length === 1 || activeSession.value.title === '新对话') {
        activeSession.value.title = text.slice(0, 18) + (text.length > 18 ? '...' : '')
      }

      // 添加助手机位
      const aiMsg = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now()
      }
      activeSession.value.messages.push(aiMsg)

      isGenerating.value = true
      abortController.value = new AbortController()
      scrollToBottom()

      try {
        // 创建或复用 Chrome AI Session
        if (!activeAiSession.value) {
          activeAiSession.value = await ChromeAIService.createChatSession({
            systemPrompt: activeSession.value.systemPrompt,
            temperature: activeSession.value.temperature || settings.value.temperature,
            topK: activeSession.value.topK || settings.value.topK,
          })
        }

        // 跟踪 Token 用量
        if (activeAiSession.value.tokensSoFar) {
          currentTokensSoFar.value = activeAiSession.value.tokensSoFar
        }
        if (activeAiSession.value.maxTokens) {
          maxTokensLimit.value = activeAiSession.value.maxTokens
        }

        // 流式生成回答
        await ChromeAIService.streamPrompt(
          activeAiSession.value,
          text,
          ({ full }) => {
            aiMsg.content = full
            scrollToBottom()
          },
          abortController.value.signal
        )

        // 更新 Token
        if (activeAiSession.value.tokensSoFar) {
          currentTokensSoFar.value = activeAiSession.value.tokensSoFar
        }
      } catch (err) {
        if (!abortController.value?.signal.aborted) {
          aiMsg.content += `\n\n> ⚠️ **生成错误**：${err.message || '模型响应异常'}`
        }
      } finally {
        isGenerating.value = false
        activeSession.value.updatedAt = Date.now()
        saveSessions(sessions.value)
        scrollToBottom()
      }
    }

    // 停止生成
    function stopGenerating() {
      if (abortController.value) {
        abortController.value.abort()
        isGenerating.value = false
      }
    }

    // 切换主题
    function toggleTheme() {
      const next = settings.value.theme === 'dark' ? 'light' : 'dark'
      settings.value.theme = next
      document.documentElement.setAttribute('data-theme', next)
      saveSettings(settings.value)
    }

    // 一键复制
    async function copyToClipboard(text) {
      if (!text) return
      await navigator.clipboard.writeText(text)
    }

    // 快速填入示例问题
    function useQuickPrompt(promptText) {
      currentInput.value = promptText
      sendMessage()
    }

    // 运行 Summarizer 模式
    async function runSummarizer() {
      if (!summarizeInput.value.trim() || isSummarizing.value) return
      isSummarizing.value = true
      summarizeOutput.value = ''
      try {
        await ChromeAIService.summarize(
          summarizeInput.value,
          {
            type: summarizeType.value,
            length: summarizeLength.value,
            format: summarizeFormat.value,
          },
          (chunk) => {
            summarizeOutput.value = chunk
          }
        )
      } catch (e) {
        summarizeOutput.value = `> ⚠️ **摘要失败**：${e.message}`
      } finally {
        isSummarizing.value = false
      }
    }

    // 运行 Rewriter 模式
    async function runRewriter() {
      if (!rewriteInput.value.trim() || isRewriting.value) return
      isRewriting.value = true
      rewriteOutput.value = ''
      try {
        await ChromeAIService.rewrite(
          rewriteInput.value,
          {
            tone: rewriteTone.value,
            length: rewriteLength.value,
          },
          (chunk) => {
            rewriteOutput.value = chunk
          }
        )
      } catch (e) {
        rewriteOutput.value = `> ⚠️ **润色失败**：${e.message}`
      } finally {
        isRewriting.value = false
      }
    }

    // 运行 Writer 模式
    async function runWriter() {
      if (!writePrompt.value.trim() || isWriting.value) return
      isWriting.value = true
      writeOutput.value = ''
      try {
        await ChromeAIService.write(
          writePrompt.value,
          {
            tone: writeTone.value,
            length: writeLength.value,
            context: writeContext.value,
          },
          (chunk) => {
            writeOutput.value = chunk
          }
        )
      } catch (e) {
        writeOutput.value = `> ⚠️ **起草失败**：${e.message}`
      } finally {
        isWriting.value = false
      }
    }

    // 初始化
    onMounted(() => {
      // 设置主题
      const initialTheme = settings.value.theme === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : settings.value.theme
      document.documentElement.setAttribute('data-theme', initialTheme)

      checkSystemAI()

      // 如果没有会话，创建一个默认会话
      if (sessions.value.length === 0) {
        createNewSession()
      } else if (!activeSession.value) {
        selectSession(sessions.value[0].id)
      }
    })

    return {
      currentMode,
      setMode,
      settings,
      sessions,
      activeSession,
      activeSessionId,
      sidebarOpen,
      settingsModalOpen,
      roleModalOpen,
      ROLE_PRESETS,
      currentRole,
      aiStatus,
      currentInput,
      isGenerating,
      chatContainerRef,
      currentTokensSoFar,
      maxTokensLimit,
      renderMarkdown,
      createNewSession,
      selectSession,
      deleteSession,
      cloneSession,
      sendMessage,
      stopGenerating,
      toggleTheme,
      copyToClipboard,
      useQuickPrompt,
      exportSessionToMarkdown,
      // Summarizer
      summarizeInput,
      summarizeOutput,
      summarizeType,
      summarizeLength,
      isSummarizing,
      runSummarizer,
      // Rewriter
      rewriteInput,
      rewriteOutput,
      rewriteTone,
      rewriteLength,
      isRewriting,
      runRewriter,
      // Writer
      writePrompt,
      writeContext,
      writeOutput,
      writeTone,
      writeLength,
      isWriting,
      runWriter,
    }
  }
}).mount('#app')
