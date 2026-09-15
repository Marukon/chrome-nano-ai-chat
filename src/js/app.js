import { createApp, ref, computed, watch, nextTick, onMounted } from '../vendor/vue.esm.js'
import { marked } from '../vendor/marked.esm.js'
import { ChromeAIService } from './chrome-ai.js'
import { ROLE_PRESETS, MODE_META } from './presets.js'
import {
  loadSessions,
  saveSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  loadSettings,
  saveSettings,
  exportSessionToMarkdown
} from './storage.js'

// marked 全局配置（只需设置一次，避免每次渲染重复执行）
marked.setOptions({
  highlight: function (code, lang) {
    if (window.hljs) {
      const language = window.hljs.getLanguage(lang) ? lang : 'plaintext'
      return window.hljs.highlight(code, { language }).value
    }
    return code
  },
  breaks: true
})

createApp({
  setup() {
    // 状态定义
    const currentMode = ref('chat') // 'chat' | 'summarizer' | 'rewriter' | 'writer'
    const settings = ref(loadSettings())
    const sessions = ref(loadSessions())
    const activeSessionId = ref(loadActiveSessionId())
    // 窄屏（≤1024px）侧边栏为抽屉模式，默认收起；宽屏默认展开
    const sidebarOpen = ref(window.innerWidth > 1024)
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
    const inputRef = ref(null)
    const toast = ref('')
    let toastTimer = null
    const currentTokensSoFar = ref(0)
    const maxTokensLimit = ref(4096)
    // 滚动锁：只有用户停留在底部附近时才自动跟随最新内容
    const isNearBottom = ref(true)

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

    // 工具面板（Studio）共用的中断控制器
    const studioAbort = ref(null)

    // 停止当前工具面板的生成（保留已输出的部分内容）
    function stopStudio() {
      if (studioAbort.value) {
        studioAbort.value.abort()
        studioAbort.value = null
      }
      isSummarizing.value = false
      isRewriting.value = false
      isWriting.value = false
      isRebutting.value = false
      isProofreading.value = false
      isCodeReviewing.value = false
    }

    // Markdown 解析与 LaTeX 公式渲染器
    // 渲染结果缓存：流式输出时每帧都会重算整条消息，
    // 没有缓存会导致长对话里每条消息都重复跑 marked + KaTeX，明显掉帧。
    const markdownCache = new Map()
    const MARKDOWN_CACHE_LIMIT = 300

    function renderMarkdown(content) {
      if (!content) return ''
      if (markdownCache.has(content)) return markdownCache.get(content)

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

        // 配置代码高亮（已在模块初始化时统一设置）
        const html = marked.parse(processed)
        if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.clear()
        markdownCache.set(content, html)
        return html
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
        mode: 'chat',
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
      if (window.innerWidth <= 1024) sidebarOpen.value = false
      scrollToBottom(true)
    }

    // 选择会话（窄屏下自动收起抽屉）
    function selectSession(id) {
      activeSessionId.value = id
      saveActiveSessionId(id)
      if (window.innerWidth <= 1024) sidebarOpen.value = false
      activeAiSession.value = null
      currentTokensSoFar.value = 0

      // 工具记录：自动切回对应模式并回填输入/输出
      const target = sessions.value.find(s => s.id === id)
      if (target) {
        const mode = target.mode || 'chat'
        setMode(mode)
        if (mode !== 'chat') restoreStudioFields(target)
      }
      scrollToBottom(true)
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

    // 判断滚动位置是否贴近底部（阈值 80px）
    function onChatScroll() {
      const el = chatContainerRef.value
      if (!el) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      isNearBottom.value = distance <= 80
    }

    // 滚动至最新消息：force=true 时无视滚动锁强制置底
    function scrollToBottom(force = false) {
      nextTick(() => {
        const el = chatContainerRef.value
        if (!el) return
        if (force || isNearBottom.value) {
          el.scrollTop = el.scrollHeight
          isNearBottom.value = true
        }
      })
    }

    // 一键回到最新并重新开启自动跟随
    function forceScrollToBottom() {
      isNearBottom.value = true
      scrollToBottom(true)
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
      nextTick(autoGrowInput)

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
      isNearBottom.value = true
      scrollToBottom(true)

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
            // 实时刷新上下文占用表盘
            if (activeAiSession.value?.tokensSoFar) {
              currentTokensSoFar.value = activeAiSession.value.tokensSoFar
            }
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
        // 生成过程中会话可能已被删除，需判空
        if (activeSession.value) {
          activeSession.value.updatedAt = Date.now()
        }
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

    // 轻量提示条
    function showToast(message) {
      toast.value = message
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toast.value = ''
      }, 1800)
    }

    // 一键复制（兼容 http 非安全上下文：navigator.clipboard 不可用）
    async function copyToClipboard(text) {
      if (!text) return
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          showToast('✅ 已复制到剪贴板')
          return
        }
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        showToast(ok ? '✅ 已复制到剪贴板' : '⚠️ 复制失败，请手动选中复制')
      } catch (e) {
        console.warn('复制失败:', e)
        showToast('⚠️ 复制失败，请手动选中复制')
      }
    }

    // 输入框随内容自动增高（上限 180px，超出内部滚动）
    function autoGrowInput() {
      const el = inputRef.value
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 180) + 'px'
    }

    // 回车发送：中文/日文输入法组词过程中的回车不能误触发发送
    function handleEnterKey(event) {
      if (event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      sendMessage()
    }

    // 切换角色：当前会话为空则直接改角色，否则新建会话，避免堆积空会话
    function applyRole(roleId) {
      roleModalOpen.value = false
      const role = ROLE_PRESETS.find(r => r.id === roleId) || ROLE_PRESETS[0]
      const current = activeSession.value
      if (current && (!current.messages || current.messages.length === 0)) {
        current.roleId = role.id
        current.systemPrompt = role.systemPrompt
        current.updatedAt = Date.now()
        activeAiSession.value = null
        saveSessions(sessions.value)
        return
      }
      createNewSession(role.id)
    }

    // 欢迎页「从角色开始」的精选角色
    const HERO_ROLE_IDS = [
      'sci-reviewer',
      'academic-editor',
      'feynman-tutor',
      'math-derivation',
      'code-architect',
      'academic-mentor',
    ]
    const quickRoles = computed(() =>
      HERO_ROLE_IDS
        .map(id => ROLE_PRESETS.find(r => r.id === id))
        .filter(Boolean)
    )

    // 选中角色并聚焦输入框（不自动发送消息，避免浪费一次端侧推理）
    function startWithRole(roleId) {
      const role = ROLE_PRESETS.find(r => r.id === roleId) || ROLE_PRESETS[0]
      applyRole(roleId)
      nextTick(() => {
        autoGrowInput()
        inputRef.value?.focus()
        scrollToBottom(true)
      })
      showToast(`已切换为「${role.name}」，直接输入问题即可`)
    }

    // 运行 Summarizer 模式
    async function runSummarizer() {
      if (!summarizeInput.value.trim() || isSummarizing.value) return
      isSummarizing.value = true
      summarizeOutput.value = ''
      const record = ensureStudioSession('summarizer')
      studioAbort.value = new AbortController()
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
          },
          studioAbort.value.signal
        )
      } catch (e) {
        summarizeOutput.value = `> ⚠️ **摘要失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: summarizeInput.value,
          options: { type: summarizeType.value, length: summarizeLength.value },
          output: summarizeOutput.value,
        })
        isSummarizing.value = false
        studioAbort.value = null
      }
    }

    // 运行 Rewriter 模式
    async function runRewriter() {
      if (!rewriteInput.value.trim() || isRewriting.value) return
      isRewriting.value = true
      rewriteOutput.value = ''
      const record = ensureStudioSession('rewriter')
      studioAbort.value = new AbortController()
      try {
        await ChromeAIService.rewrite(
          rewriteInput.value,
          {
            tone: rewriteTone.value,
            length: rewriteLength.value,
          },
          (chunk) => {
            rewriteOutput.value = chunk
          },
          studioAbort.value.signal
        )
      } catch (e) {
        rewriteOutput.value = `> ⚠️ **润色失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: rewriteInput.value,
          options: { tone: rewriteTone.value, length: rewriteLength.value },
          output: rewriteOutput.value,
        })
        isRewriting.value = false
        studioAbort.value = null
      }
    }

    // 运行 Writer 模式
    async function runWriter() {
      if (!writePrompt.value.trim() || isWriting.value) return
      isWriting.value = true
      writeOutput.value = ''
      const record = ensureStudioSession('writer')
      studioAbort.value = new AbortController()
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
          },
          studioAbort.value.signal
        )
      } catch (e) {
        writeOutput.value = `> ⚠️ **起草失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          prompt: writePrompt.value,
          context: writeContext.value,
          options: { tone: writeTone.value },
          output: writeOutput.value,
        })
        isWriting.value = false
        studioAbort.value = null
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
      const record = ensureStudioSession('rebuttal')
      studioAbort.value = new AbortController()
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
          },
          studioAbort.value.signal
        )
      } catch (e) {
        rebuttalOutput.value = `> ⚠️ **生成答辩失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          comment: rebuttalComment.value,
          response: rebuttalResponse.value,
          options: { tone: rebuttalTone.value },
          output: rebuttalOutput.value,
        })
        isRebutting.value = false
        studioAbort.value = null
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
      const record = ensureStudioSession('proofread')
      studioAbort.value = new AbortController()
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
          },
          studioAbort.value.signal
        )
      } catch (e) {
        proofreadOutput.value = `> ⚠️ **语法查错失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: proofreadInput.value,
          options: { standard: proofreadStandard.value },
          output: proofreadOutput.value,
        })
        isProofreading.value = false
        studioAbort.value = null
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
      const record = ensureStudioSession('codereview')
      studioAbort.value = new AbortController()
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
          },
          studioAbort.value.signal
        )
      } catch (e) {
        codeOutput.value = `> ⚠️ **代码审查失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: codeInput.value,
          options: { lang: codeLang.value },
          output: codeOutput.value,
        })
        isCodeReviewing.value = false
        studioAbort.value = null
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

    /* ============================================================
       工具（Studio）记录接入会话管理
       ============================================================ */

    // 会话列表图标：按模式取 emoji
    function sessionIcon(session) {
      return (MODE_META[session?.mode] || MODE_META.chat).icon
    }

    // 运行工具前准备记录：当前会话就是同模式的工具记录则复用，否则新建
    function ensureStudioSession(mode) {
      const meta = MODE_META[mode] || MODE_META.chat
      let session = activeSession.value
      if (!session || session.mode !== mode) {
        session = {
          id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: `${meta.icon} ${meta.label}`,
          mode,
          studio: {},
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        sessions.value.unshift(session)
        activeSessionId.value = session.id
        saveActiveSessionId(session.id)
        if (window.innerWidth <= 1024) sidebarOpen.value = false
      }
      return session
    }

    // 运行结束后把输入/参数/输出写回会话并落盘
    function persistStudioSession(session, data) {
      if (!session) return
      session.studio = data
      session.updatedAt = Date.now()
      const meta = MODE_META[session.mode] || MODE_META.chat
      const raw = (data.input || data.prompt || data.comment || '').replace(/\s+/g, ' ').trim()
      session.title = raw ? `${meta.icon} ${meta.label} · ${raw.slice(0, 16)}` : `${meta.icon} ${meta.label}`
      saveSessions(sessions.value)
    }

    // 点击会话时把工具记录回填到对应面板
    function restoreStudioFields(session) {
      const s = session.studio || {}
      const opt = s.options || {}
      switch (session.mode) {
        case 'summarizer':
          summarizeInput.value = s.input || ''
          if (opt.type) summarizeType.value = opt.type
          if (opt.length) summarizeLength.value = opt.length
          summarizeOutput.value = s.output || ''
          break
        case 'rewriter':
          rewriteInput.value = s.input || ''
          if (opt.tone) rewriteTone.value = opt.tone
          if (opt.length) rewriteLength.value = opt.length
          rewriteOutput.value = s.output || ''
          break
        case 'writer':
          writePrompt.value = s.prompt || ''
          writeContext.value = s.context || ''
          if (opt.tone) writeTone.value = opt.tone
          writeOutput.value = s.output || ''
          break
        case 'rebuttal':
          rebuttalComment.value = s.comment || ''
          rebuttalResponse.value = s.response || ''
          if (opt.tone) rebuttalTone.value = opt.tone
          rebuttalOutput.value = s.output || ''
          break
        case 'proofread':
          proofreadInput.value = s.input || ''
          if (opt.standard) proofreadStandard.value = opt.standard
          proofreadOutput.value = s.output || ''
          break
        case 'codereview':
          codeInput.value = s.input || ''
          if (opt.lang) codeLang.value = opt.lang
          codeOutput.value = s.output || ''
          break
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

    // 设置项持久化：否则调完采样参数刷新页面就丢了
    watch(settings, (val) => {
      saveSettings(val)
    }, { deep: true })

    // 初始化
    onMounted(() => {
      // 设置主题
      const initialTheme = settings.value.theme === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : settings.value.theme
      document.documentElement.setAttribute('data-theme', initialTheme)

      checkSystemAI()

      // 视口跨越 1024px 断点时，自动切换侧边栏形态（展开 / 收起抽屉）
      let lastIsWide = window.innerWidth > 1024
      window.addEventListener('resize', () => {
        const isWide = window.innerWidth > 1024
        if (isWide !== lastIsWide) {
          lastIsWide = isWide
          sidebarOpen.value = isWide
        }
      })

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
      inputRef,
      autoGrowInput,
      handleEnterKey,
      applyRole,
      toast,
      isNearBottom,
      onChatScroll,
      forceScrollToBottom,
      currentTokensSoFar,
      maxTokensLimit,
      renderMarkdown,
      MODE_META,
      sessionIcon,
      createNewSession,
      selectSession,
      deleteSession,
      cloneSession,
      sendMessage,
      stopGenerating,
      toggleTheme,
      copyToClipboard,
      quickRoles,
      startWithRole,
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
      stopStudio,
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
