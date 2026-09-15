import { createApp, ref, computed, watch, nextTick, onMounted } from '../vendor/vue.esm.js'
import { marked } from '../vendor/marked.esm.js'
import { ChromeAIService } from './chrome-ai.5cf003a9.js'
import { ROLE_PRESETS } from './presets.5cf003a9.js'
import {
  loadSessions,
  saveSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  loadSettings,
  saveSettings,
  exportSessionToMarkdown
} from './storage.5cf003a9.js'

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

    // 模式 5：Rebuttal 审稿答辩状态
    const rebuttalComment = ref('')
    const rebuttalResponse = ref('')
    const rebuttalTone = ref('polite-firm')
    const rebuttalOutput = ref('')
    const isRebutting = ref(false)

    async function runRebuttal() {
      if (!rebuttalComment.value.trim() || isRebutting.value) return
      isRebutting.value = true
      rebuttalOutput.value = ''
      const prompt = `请作为国际顶级学术期刊与会议评审专家，为以下审稿人意见（Reviewer Comment）起草一份专业且具有说服力的 Point-by-Point 答辩信草稿：\n\n` +
        `【审稿人质疑/评审意见】：\n${rebuttalComment.value}\n\n` +
        (rebuttalResponse.value.trim() ? `【作者答辩要点与补充证据】：\n${rebuttalResponse.value}\n\n` : '') +
        `【答辩语气】：${rebuttalTone.value === 'polite-firm' ? '既礼貌感激，又用事实与逻辑坚定澄清误解' : (rebuttalTone.value === 'appreciative-expand' ? '充分肯定审稿人洞察，详细展开补充实验' : '谦逊诚恳，说明已在正文做出修改')}\n\n` +
        `请使用标准学术英文撰写，包含：1. 礼貌致谢；2. 针对性解释；3. 正文具体修改标注（Action in Revised Manuscript）。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: 'You are an expert academic author skilled in peer-review rebuttal for top-tier venues like IEEE, ACM, Nature, and NeurIPS.'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            rebuttalOutput.value = full
          }
        )
      } catch (e) {
        rebuttalOutput.value = `> ⚠️ **生成答辩失败**：${e.message}`
      } finally {
        isRebutting.value = false
      }
    }

    // 模式 6：Proofread 语法深度纠错状态
    const proofreadInput = ref('')
    const proofreadStandard = ref('strict')
    const proofreadOutput = ref('')
    const isProofreading = ref(false)

    async function runProofread() {
      if (!proofreadInput.value.trim() || isProofreading.value) return
      isProofreading.value = true
      proofreadOutput.value = ''
      const prompt = `请对以下英文学术段落进行严苛的语法检查与审校（标准：${proofreadStandard.value === 'strict' ? '顶级期刊出版级严谨标准' : '简洁清晰自然表达'}）：\n\n` +
        `【待检查段落】：\n${proofreadInput.value}\n\n` +
        `请输出：\n` +
        `1. 🎯【精校全文】（符合顶级国际期刊的高质量版本）；\n` +
        `2. 🔍【修改对照与原因分析】（逐条列出原句、修改建议及语法/搭配规则）。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: 'You are a professional academic copyeditor and grammarian for Nature and IEEE publications.'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            proofreadOutput.value = full
          }
        )
      } catch (e) {
        proofreadOutput.value = `> ⚠️ **语法查错失败**：${e.message}`
      } finally {
        isProofreading.value = false
      }
    }

    // 模式 7：CodeReview 代码审查与重构状态
    const codeInput = ref('')
    const codeLang = ref('python')
    const codeOutput = ref('')
    const isCodeReviewing = ref(false)

    async function runCodeReview() {
      if (!codeInput.value.trim() || isCodeReviewing.value) return
      isCodeReviewing.value = true
      codeOutput.value = ''
      const prompt = `请对以下 ${codeLang.value} 代码进行全方位的架构与安全审查（Code Review）：\n\n` +
        `\`\`\`${codeLang.value}\n${codeInput.value}\n\`\`\`\n\n` +
        `请分析：\n` +
        `1. ⚠️【潜在 Bug 与边界安全漏洞】；\n` +
        `2. ⏱️【复杂度分析】（时间与空间复杂度）；\n` +
        `3. 💡【重构与优化建议】；\n` +
        `4. 🚀【高质量重构后代码】。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: 'You are a principal software engineer and security auditor.'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            codeOutput.value = full
          }
        )
      } catch (e) {
        codeOutput.value = `> ⚠️ **代码审查失败**：${e.message}`
      } finally {
        isCodeReviewing.value = false
      }
    }

    // 端侧翻译实测状态
    const translateTestState = ref({
      running: false,
      result: '',
      duration: 0,
      error: ''
    })

    async function runTranslateTest() {
      translateTestState.value.running = true
      translateTestState.value.error = ''
      translateTestState.value.result = ''
      try {
        const res = await ChromeAIService.testTranslate()
        translateTestState.value.result = res.result
        translateTestState.value.duration = res.duration
      } catch (err) {
        translateTestState.value.error = err.message || '测试失败'
      } finally {
        translateTestState.value.running = false
      }
    }

    // 复制控制台检测脚本
    const copiedScript = ref(false)
    async function copyConsoleScript() {
      const script = "console.log({ LanguageModel: typeof window.LanguageModel, ai: typeof window.ai, Translator: typeof window.Translator });"
      await navigator.clipboard.writeText(script)
      copiedScript.value = true
      setTimeout(() => {
        copiedScript.value = false
      }, 2500)
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
      checkSystemAI,
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
      // Diagnostics
      translateTestState,
      runTranslateTest,
      copiedScript,
      copyConsoleScript,
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
      // Rebuttal
      rebuttalComment,
      rebuttalResponse,
      rebuttalTone,
      rebuttalOutput,
      isRebutting,
      runRebuttal,
      // Proofread
      proofreadInput,
      proofreadStandard,
      proofreadOutput,
      isProofreading,
      runProofread,
      // CodeReview
      codeInput,
      codeLang,
      codeOutput,
      isCodeReviewing,
      runCodeReview,
    }
  }
}).mount('#app')
