import { createApp, ref, computed, watch, nextTick, onMounted } from '../vendor/vue.esm.js'
import { marked } from '../vendor/marked.esm.js'
import { ChromeAIService } from './chrome-ai.js'
import { ROLE_PRESETS, ROLE_GROUPS, MODE_META, MODE_GROUPS } from './presets.js'

// 代码审查语言的显示名称
const CODE_LANG_LABEL = {
  python: 'Python',
  javascript: 'JavaScript / TypeScript',
  cpp: 'C / C++',
  csharp: 'C#',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
}
import {
  loadSessions,
  saveSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  loadSettings,
  saveSettings,
  exportSessionToMarkdown,
  exportScriptAsTxt
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
    const diagModalOpen = ref(false) // 端侧模型状态检测（与参数设置分离）
    const roleModalOpen = ref(false)
    const openMenu = ref('') // 顶栏二级菜单：当前展开的分组 id

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

    // 结构化萃取 (Extract) 模式状态 —— 面向常规文章
    const extractInput = ref('')
    const extractStyle = ref('table') // 'table' | 'bullets'
    const extractOutput = ref('')
    const isExtracting = ref(false)

    // 通用润色 (Polish)
    const polishInput = ref('')
    const polishStrength = ref('medium') // light | medium | strong
    const polishOutput = ref('')
    const isPolishing = ref(false)

    // 改写降重 (Rewrite，学术向)
    const rewriteSrcInput = ref('')
    const rewriteSrcStrength = ref('medium') // light | medium | strong
    const rewriteSrcOutput = ref('')
    const isRewriteSrcRunning = ref(false)

    // 洗稿 (Wash，自媒体文案向)
    const washInput = ref('')
    const washStyle = ref('wechat') // wechat | xiaohongshu | toutiao | zhihu
    const washOutput = ref('')
    const washHistory = ref([]) // 迭代洗稿版本
    const isWashing = ref(false)

    // 单词查询 (Dictionary)
    const dictWord = ref('')
    const dictOutput = ref('')
    const isDictRunning = ref(false)
    const dictHistory = ref([])

    // 代码块自动换行（脚本 / 代码审查共用）
    const wrapCode = ref(true)

    // 大纲生成 (Outline)
    const outlineTopic = ref('')
    const outlineType = ref('article') // article | report | speech | social
    const outlineDepth = ref('medium') // brief | medium | detailed
    const outlineOutput = ref('')
    const isOutlining = ref(false)

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
      isExtracting.value = false
      isOutlining.value = false
      isPolishing.value = false
      isRewriteSrcRunning.value = false
      isWashing.value = false
      isDictRunning.value = false
      isRewriting.value = false
      isWriting.value = false
      isRebutting.value = false
      isProofreading.value = false
      isTranslating.value = false
      isCodeReviewing.value = false
      isScripting.value = false
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

    // 初始化检查 AI 支持（单例：避免多处并发触发重复检测与状态抖动）
    let statusPromise = null
    function checkSystemAI() {
      if (statusPromise) return statusPromise
      statusPromise = ChromeAIService.checkStatus()
        .then(status => {
          aiStatus.value = status
          return status
        })
        .finally(() => {
          statusPromise = null
        })
      return statusPromise
    }

    // 切换模式
    function setMode(mode) {
      currentMode.value = mode
      openMenu.value = ''
    }

    // 展开/收起顶栏二级菜单
    function toggleMenu(groupId) {
      openMenu.value = openMenu.value === groupId ? '' : groupId
    }

    // 新建会话
    function createNewSession(roleId) {
      const targetRoleId = roleId || settings.value.defaultRole || 'general'
      const role = ROLE_PRESETS.find(r => r.id === targetRoleId) || ROLE_PRESETS[0]
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

    // 把生成的脚本导出为 .txt
    function exportScriptAsTxtFile() {
      if (!scriptOutput.value) return
      const extLabel = { bash: 'sh', bat: 'bat', powershell: 'ps1' }[scriptType.value] || 'txt'
      exportScriptAsTxt(scriptOutput.value, scriptType.value, `script_${scriptType.value}`)
      showToast(`✅ 已导出为 .${extLabel} 文本文件`)
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

    // 角色弹窗：按分组取角色
    function rolesInGroup(groupId) {
      return ROLE_PRESETS.filter(r => (r.group || 'general') === groupId)
    }

    // 起草场景一键套用（日常祝福、通知、社交文案为主）
    const WRITER_SCENES = [
      { label: '🎂 生日祝福', prompt: '写一段生日祝福', context: '送给：\n关系（同事/朋友/家人/领导/长辈）：\n对方特点或喜好：\n语气：\n字数要求：' },
      { label: '🎓 教师节祝福', prompt: '写一段教师节祝福', context: '送给：\n称呼：\n想感谢的具体事情：\n语气：\n字数要求：' },
      { label: '🎉 节日祝福', prompt: '写一段节日祝福', context: '节日名称：\n送给：\n发送渠道（微信群/私聊/朋友圈）：\n语气：' },
      { label: '📢 群通知', prompt: '写一则发在微信群的通知', context: '事由：\n时间：\n地点：\n需要大家做什么：\n是否要大家回复确认：' },
      { label: '💬 社交回复', prompt: '帮我回复一段话', context: '对方说了什么：\n我与对方的关系：\n我希望达成的效果（感谢/婉拒/道歉/邀约）：\n语气：' },
      { label: '🙏 感谢致意', prompt: '写一段感谢的话', context: '感谢对象：\n感谢原因：\n语气：\n字数要求：' },
      { label: '🌷 慰问关怀', prompt: '写一段慰问/关怀的话', context: '对象与情况：\n语气（温暖/克制）：\n字数要求：' },
      { label: '📨 请假/申请', prompt: '写一则请假申请', context: '请假事由：\n起止时间：\n工作交接安排：\n发送对象（直属领导/HR）：' },
    ]

    // 起草功能的系统提示词
    const WRITER_SYSTEM_PROMPT =
      '你是一位中文日常文案写作助手，擅长写生日祝福、节日祝福、教师节祝福、感谢致意、' +
      '慰问关怀、微信群通知、社交消息回复、请假申请等生活与职场场合的短文案。' +
      '要求：1. 直接输出可发送的成品，不要解释写作思路，不要加"以下是"之类的前后缀；' +
      '2. 语言自然真诚，贴合中文表达习惯，避免翻译腔和空洞排比；' +
      '3. 若用户给了称呼、关系、场合、字数，必须严格遵守；未给的细节不要臆造人名与事实；' +
      '4. 需要多个版本时，用"版本一 / 版本二"分行列出，每条独立可用；' +
      '5. 默认控制在 150 字以内，用户指定字数时以用户要求为准。'

    // 套用起草场景
    function applyWriterScene(scene) {
      writePrompt.value = scene.prompt
      writeContext.value = scene.context
      nextTick(() => {
        autoGrowInput()
        inputRef.value?.focus()
      })
      showToast(`已套用「${scene.label.replace(/^\S+\s/, '')}」模板，补充细节后开始起草`)
    }

    // 欢迎页「从角色开始」的精选角色（覆盖论文、语言、工程、学习等不同维度）
    const HERO_ROLE_IDS = [
      'sci-reviewer',      // 论文评审
      'rebuttal-expert',   // 审稿答辩
      'academic-editor',   // 学术英语
      'translator-pro',    // 学术翻译
      'code-architect',    // 代码架构
      'devops-script',     // 脚本自动化
      'feynman-tutor',     // 费曼讲解
      'math-derivation',   // 公式推导
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

    // 开始新的工具运行前，中断上一个仍在跑的生成，避免共用 studioAbort 时
    // 旧任务的 finally 把新任务的状态一并清掉（停止按钮"点了没反应"）
    function beginStudioRun() {
      if (studioAbort.value) {
        try { studioAbort.value.abort() } catch (e) {}
        isSummarizing.value = false
        isExtracting.value = false
        isOutlining.value = false
        isPolishing.value = false
        isRewriteSrcRunning.value = false
        isWashing.value = false
        isDictRunning.value = false
        isRewriting.value = false
        isWriting.value = false
        isRebutting.value = false
        isProofreading.value = false
        isTranslating.value = false
        isCodeReviewing.value = false
        isScripting.value = false
      }
      studioAbort.value = new AbortController()
      return studioAbort.value
    }

    // 运行 Summarizer 模式
    async function runSummarizer() {
      if (!summarizeInput.value.trim() || isSummarizing.value) return
      isSummarizing.value = true
      summarizeOutput.value = ''
      const record = ensureStudioSession('summarizer')
      const runCtrl = beginStudioRun()
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
          runCtrl.signal
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
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 Extract 结构化萃取（面向常规文章，不限学术）
    async function runExtract() {
      if (!extractInput.value.trim() || isExtracting.value) return
      isExtracting.value = true
      extractOutput.value = ''
      const record = ensureStudioSession('extract')
      const runCtrl = beginStudioRun()
      const styleText = extractStyle.value === 'table'
        ? '请以 Markdown 表格输出，表头自行根据内容确定'
        : '请以多级要点清单输出'
      const prompt = `请将以下文章整理为结构化信息。${styleText}。\n\n` +
        `需要覆盖这些维度（原文没有的写「未提及」，不要编造）：\n` +
        `- 主题与核心观点\n- 关键信息与要点\n- 涉及的人物/机构/时间/地点\n` +
        `- 给出的数据、结论或建议\n- 需要注意的事项\n\n` +
        `【待整理文章】：\n${extractInput.value}`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位高效的内容整理专家，把长文提炼成清晰的结构化信息，只输出整理结果，不复述原文，不编造原文没有的内容。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            extractOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        extractOutput.value = `> ⚠️ **整理失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: extractInput.value,
          options: { style: extractStyle.value },
          output: extractOutput.value,
        })
        isExtracting.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 通用润色 (Polish)
    async function runPolish() {
      if (!polishInput.value.trim() || isPolishing.value) return
      isPolishing.value = true
      polishOutput.value = ''
      const record = ensureStudioSession('polish')
      const runCtrl = beginStudioRun()
      const strengthText = {
        light: '轻度润色：仅修正错别字、标点和明显不通顺的地方，尽量保留原文用词',
        medium: '中度润色：优化语句通顺度与用词，调整啰嗦表达，保留原意与个人语气',
        strong: '深度润色：可较大幅度重组句式，使表达更有条理和感染力，但不得改变事实与观点',
      }[polishStrength.value]
      const prompt = `请对以下文字进行润色（${strengthText}）。\n\n` +
        `要求：只输出润色后的正文，不要解释修改过程；保持原意与事实不变；不要添加原文没有的信息。\n\n` +
        `【原文】：\n${polishInput.value}`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位中文文字编辑，擅长在保留作者原意与语气的前提下让文字更通顺、准确、得体。只输出润色后的成品。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            polishOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        polishOutput.value = `> ⚠️ **润色失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: polishInput.value,
          options: { strength: polishStrength.value },
          output: polishOutput.value,
        })
        isPolishing.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 大纲生成 (Outline)
    async function runOutline() {
      if (!outlineTopic.value.trim() || isOutlining.value) return
      isOutlining.value = true
      outlineOutput.value = ''
      const record = ensureStudioSession('outline')
      const runCtrl = beginStudioRun()
      const typeText = {
        article: '一篇通俗文章',
        report: '一份工作汇报',
        speech: '一篇演讲稿',
        social: '一条社交媒体长文',
      }[outlineType.value]
      const depthText = {
        brief: '只给一级标题，精炼到 5-6 条',
        medium: '给到二级标题，每条附一句话说明',
        detailed: '给到三级标题，并标注每节要讲的重点与需要的素材',
      }[outlineDepth.value]
      const prompt = `请围绕下面的主题，拟一份${typeText}的写作大纲：\n\n${outlineTopic.value}\n\n` +
        `要求：${depthText}；标题要具体、有信息量，不要「引言 / 正文 / 结语」这类空泛标题；` +
        `开头先用一句话说清这篇内容的核心立场或结论。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位资深内容策划与编辑，擅长为各类选题搭建清晰、有信息量的写作大纲。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            outlineOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        outlineOutput.value = `> ⚠️ **大纲生成失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: outlineTopic.value,
          options: { type: outlineType.value, depth: outlineDepth.value },
          output: outlineOutput.value,
        })
        isOutlining.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 改写降重 (Rewrite)：学术论文向，改写表达、降低查重文字重合度
    async function runRewrite() {
      if (!rewriteSrcInput.value.trim() || isRewriteSrcRunning.value) return
      isRewriteSrcRunning.value = true
      rewriteSrcOutput.value = ''
      const record = ensureStudioSession('rewrite')
      const runCtrl = beginStudioRun()
      const strengthText = {
        light: '轻度改写：替换同义词、调整语序，重合度降低幅度有限',
        medium: '中度改写：重构句式与段落组织，明显降低文字重合度',
        strong: '深度改写：重新组织论述结构与表达方式，最大幅度降低重合度',
      }[rewriteSrcStrength.value]
      const prompt = `请对以下学术文字进行改写降重（${strengthText}）。\n\n` +
        `硬性要求：\n` +
        `1. 严格保留原文的事实、数据、观点与结论，不得增删或歪曲；\n` +
        `2. 专有名词、术语、公式、引用标注（如 [1]、参考文献编号）保持原样；\n` +
        `3. 变换句式结构（主动/被动互换、长短句重组）、替换同义学术表达、调整逻辑连接词；\n` +
        `4. 段落数量与先后顺序尽量与原文对应，便于逐段替换；\n` +
        `5. 保持学术语体的严谨客观，不要口语化、不要添加原文没有的论断；\n` +
        `6. 只输出改写后的正文，不要解释改写手法。\n\n` +
        `【原文】：\n${rewriteSrcInput.value}`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位专业的学术文字改写专家，擅长在完全保留原意、数据与引用标注的前提下重构表达方式、降低查重文字重合度。只输出改写后的成品。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            rewriteSrcOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        rewriteSrcOutput.value = `> ⚠️ **改写降重失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: rewriteSrcInput.value,
          options: { strength: rewriteSrcStrength.value },
          output: rewriteSrcOutput.value,
        })
        isRewriteSrcRunning.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 洗稿 (Wash)：自媒体文案向，保留信息点重写表达
    async function runWash() {
      if (!washInput.value.trim() || isWashing.value) return
      isWashing.value = true
      washOutput.value = ''
      const record = ensureStudioSession('wash')
      const runCtrl = beginStudioRun()
      const styleText = {
        wechat: '微信公众号长文：有小标题、段落短、节奏舒服，开头三行内抓住读者',
        xiaohongshu: '小红书笔记：口语化、有 emoji 分点、像分享经验，结尾自然引导互动',
        toutiao: '资讯平台文章：客观叙述、信息密度高、结论前置',
        zhihu: '知乎回答：先给结论，再分点论证，理性克制，可举例说明',
      }[washStyle.value]
      const prompt = `请对以下内容进行洗稿改写，目标风格：${styleText}。\n\n` +
        `要求：\n` +
        `1. 保留原文的全部信息点与核心观点，不新增未经证实的说法，不扭曲原意；\n` +
        `2. 重新组织语言与段落结构，换掉原文的句式与措辞，不要逐句替换的同义词式改写；\n` +
        `3. 调整叙述角度与顺序，使文章读起来是重新写的，而不是原文的复制；\n` +
        `4. 涉及的具体数据、人名、机构名、时间必须与原文一致，不得改动；\n` +
        `5. 直接输出成品，不要解释改写思路，不要加"以下是"之类的前后缀。\n\n` +
        `【原文】：\n${washInput.value}`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位资深内容编辑，擅长把一篇文章按目标平台的调性重新组织语言与结构，同时完整保留原文的信息与事实。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            washOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        washOutput.value = `> ⚠️ **洗稿失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: washInput.value,
          options: { style: washStyle.value },
          output: washOutput.value,
        })
        // 记录本次版本，便于对比与迭代
        if (washOutput.value && !washOutput.value.startsWith('> ⚠️')) {
          washHistory.value = [
            { style: washStyle.value, text: washOutput.value, at: Date.now() },
            ...washHistory.value,
          ].slice(0, 6)
        }
        isWashing.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 洗稿平台风格的中文名（模板里用它，避免在模板内直接写对象字面量）
    function styleLabel(style) {
      return { wechat: '公众号', xiaohongshu: '小红书', toutiao: '资讯', zhihu: '知乎' }[style] || style
    }

    // 换一个平台风格，用上一版结果继续洗
    function washAgainWithStyle(style) {
      washStyle.value = style
      if (washOutput.value && !washOutput.value.startsWith('> ⚠️')) {
        washInput.value = washOutput.value
      }
      showToast('已切换风格并用上一版结果继续洗稿')
    }

    // 运行 单词查询 (Dictionary)：英汉双向词典式释义
    async function runDictionary() {
      const word = dictWord.value.trim()
      if (!word || isDictRunning.value) return
      isDictRunning.value = true
      dictOutput.value = ''
      const record = ensureStudioSession('dict')
      const runCtrl = beginStudioRun()
      const prompt = `请查询并解释：${word}\n\n` +
        `请按以下格式输出（中文解释，原文没有的信息不要编造，不确定时明确说明）：\n` +
        `## 释义\n` +
        `- 词性 + 中文释义（多个义项分行列出，常用的排前面）\n\n` +
        `## 发音\n` +
        `- 英式 / 美式 音标（若为英文单词）\n\n` +
        `## 例句\n` +
        `- 2-3 个例句，每句给出原文 + 中文翻译，体现不同用法\n\n` +
        `## 搭配与辨析\n` +
        `- 常见固定搭配、近义词辨析、易错用法\n\n` +
        `## 记忆提示\n` +
        `- 词根词缀或联想记忆（可选）\n\n` +
        `如果是中文词，请给出对应的英文表达与用法说明；如果是术语或缩写，请给出全称与领域背景。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位严谨的词典编纂者，熟悉英汉双解词典与语言学知识。释义要准确、克制，不确定的信息必须说明不确定，不得编造音标与用法。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            dictOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        dictOutput.value = `> ⚠️ **查询失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: word,
          output: dictOutput.value,
        })
        if (!dictHistory.value.includes(word)) {
          dictHistory.value = [word, ...dictHistory.value].slice(0, 12)
        }
        isDictRunning.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 点击历史词条直接再查一次
    function lookupWord(word) {
      dictWord.value = word
      runDictionary()
    }

    // 交换翻译的源语言与目标语言
    function swapTranslateLang() {
      const from = translateSource.value
      translateSource.value = translateTarget.value
      translateTarget.value = from
    }

    // 运行 Rewriter 模式
    async function runRewriter() {
      if (!rewriteInput.value.trim() || isRewriting.value) return
      isRewriting.value = true
      rewriteOutput.value = ''
      const record = ensureStudioSession('rewriter')
      const runCtrl = beginStudioRun()
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
          runCtrl.signal
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
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 Writer 模式（日常文案：祝福 / 通知 / 社交回复）
    async function runWriter() {
      if (!writePrompt.value.trim() || isWriting.value) return
      isWriting.value = true
      writeOutput.value = ''
      const record = ensureStudioSession('writer')
      const runCtrl = beginStudioRun()
      try {
        await ChromeAIService.write(
          writePrompt.value,
          {
            tone: writeTone.value === 'formal' ? 'formal' : 'casual',
            length: writeLength.value,
            context: writeContext.value,
            // 场景化系统提示词：覆盖祝福、通知、日常社交文案
            scene: WRITER_SYSTEM_PROMPT,
          },
          (chunk) => {
            writeOutput.value = chunk
          },
          runCtrl.signal
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
        if (studioAbort.value === runCtrl) studioAbort.value = null
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
      const runCtrl = beginStudioRun()
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
          runCtrl.signal
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
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 模式 6：Proofread 文字纠错状态（中英文通用，无需选择标准）
    const proofreadInput = ref('')
    const proofreadOutput = ref('')
    const isProofreading = ref(false)

    async function runProofread() {
      if (!proofreadInput.value.trim() || isProofreading.value) return
      isProofreading.value = true
      proofreadOutput.value = ''
      const record = ensureStudioSession('proofread')
      const runCtrl = beginStudioRun()
      const prompt = `请检查并修改以下文字中的错误：\n\n` +
        `【原文】：\n${proofreadInput.value}\n\n` +
        `需要修正：错别字、语法错误、标点误用、搭配不当、语句不通顺、重复啰嗦。\n` +
        `请按以下格式输出：\n` +
        `1. ✅【修正后的全文】（可直接使用，保持原文语言与风格，不改动原意）；\n` +
        `2. 🔍【修改清单】（表格列出：原文片段 → 修改后 → 原因）。\n` +
        `若原文没有错误，请直接说明「未发现明显错误」，不要强行修改。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位严谨的文字校对员，精通中文与英文的语法、标点与用词规范。只修正错误，不改变作者原意与写作风格。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            proofreadOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        proofreadOutput.value = `> ⚠️ **纠错失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: proofreadInput.value,
          output: proofreadOutput.value,
        })
        isProofreading.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 模式 8：翻译 (Translate)
    const translateInput = ref('')
    const translateSource = ref('en')
    const translateTarget = ref('zh')
    const translateOutput = ref('')
    const isTranslating = ref(false)

    // 模式 9：脚本编写 (Script Writer)
    const scriptRequirement = ref('')
    const scriptType = ref('bash') // 'bash' | 'bat' | 'powershell'
    const scriptNoComment = ref(false) // 不要注释
    const scriptOutput = ref('')
    const isScripting = ref(false)

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
      const runCtrl = beginStudioRun()
      const langLabel = CODE_LANG_LABEL[codeLang.value] || codeLang.value
      const prompt = `请对以下 ${langLabel} 代码进行全方位的架构与安全审查（Code Review）：\n\n` +
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
          runCtrl.signal
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
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 Translate 学术翻译（优先端侧 Translator API，失败回退 Prompt API）
    async function runTranslate() {
      if (!translateInput.value.trim() || isTranslating.value) return
      isTranslating.value = true
      translateOutput.value = ''
      const record = ensureStudioSession('translate')
      const runCtrl = beginStudioRun()
      try {
        await ChromeAIService.translate(
          translateInput.value,
          {
            sourceLanguage: translateSource.value,
            targetLanguage: translateTarget.value,
          },
          (chunk) => {
            translateOutput.value = chunk
          },
          runCtrl.signal
        )
      } catch (e) {
        translateOutput.value = `> ⚠️ **翻译失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: translateInput.value,
          options: { from: translateSource.value, to: translateTarget.value },
          output: translateOutput.value,
        })
        isTranslating.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
      }
    }

    // 运行 Script Writer 脚本编写（Bash / BAT / PowerShell）
    async function runScript() {
      if (!scriptRequirement.value.trim() || isScripting.value) return
      isScripting.value = true
      scriptOutput.value = ''
      const record = ensureStudioSession('script')
      const runCtrl = beginStudioRun()

      const platformText = { bash: 'Linux / macOS 的 Bash', bat: 'Windows 批处理 BAT', powershell: 'Windows PowerShell' }[scriptType.value]
      const commentRule = scriptNoComment.value
        ? '4. 【重要】不要在脚本中写任何注释，包括行首 # / REM / :: 以及行尾注释；仅脚本代码块外的说明文字可以解释；'
        : '4. 关键步骤加中文注释；'
      const prompt = `请编写一段${platformText}脚本，满足以下需求：\n\n${scriptRequirement.value}\n\n` +
        `要求：\n` +
        `1. 直接给出完整可运行的脚本代码块（语言标记用 ${scriptType.value}）；\n` +
        `2. 开启严格模式（Bash 用 set -euo pipefail；PowerShell 用 $ErrorActionPreference = "Stop"；BAT 用 @echo off 并显式判错）；\n` +
        `3. 变量加引号、校验入参、处理路径含空格的情况；\n` +
        commentRule + `\n` +
        `5. 脚本后另起一节附「用法示例」与「前置依赖与注意事项」（这一节不属于脚本，不受上一条约束）。`

      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一位资深 DevOps 与自动化运维工程师，精通 Bash、Windows 批处理与 PowerShell，编写的脚本必须安全、健壮、可直接运行。'
        })
        await ChromeAIService.streamPrompt(
          session,
          prompt,
          ({ full }) => {
            scriptOutput.value = full
          },
          runCtrl.signal
        )
      } catch (e) {
        scriptOutput.value = `> ⚠️ **脚本生成失败**：${e.message}`
      } finally {
        persistStudioSession(record, {
          input: scriptRequirement.value,
          options: { type: scriptType.value },
          output: scriptOutput.value,
        })
        isScripting.value = false
        if (studioAbort.value === runCtrl) studioAbort.value = null
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
        case 'extract':
          extractInput.value = s.input || ''
          if (opt.style) extractStyle.value = opt.style
          extractOutput.value = s.output || ''
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
          proofreadOutput.value = s.output || ''
          break
        case 'polish':
          polishInput.value = s.input || ''
          if (opt.strength) polishStrength.value = opt.strength
          polishOutput.value = s.output || ''
          break
        case 'rewrite':
          rewriteSrcInput.value = s.input || ''
          if (opt.strength) rewriteSrcStrength.value = opt.strength
          rewriteSrcOutput.value = s.output || ''
          break
        case 'dict':
          dictWord.value = s.input || ''
          dictOutput.value = s.output || ''
          break
        case 'wash':
          washInput.value = s.input || ''
          if (opt.style) washStyle.value = opt.style
          washOutput.value = s.output || ''
          break
        case 'outline':
          outlineTopic.value = s.input || ''
          if (opt.type) outlineType.value = opt.type
          if (opt.depth) outlineDepth.value = opt.depth
          outlineOutput.value = s.output || ''
          break
        case 'codereview':
          codeInput.value = s.input || ''
          if (opt.lang) codeLang.value = opt.lang
          codeOutput.value = s.output || ''
          break
        case 'translate':
          translateInput.value = s.input || ''
          if (opt.from) translateSource.value = opt.from
          if (opt.to) translateTarget.value = opt.to
          translateOutput.value = s.output || ''
          break
        case 'script':
          scriptRequirement.value = s.input || ''
          if (opt.type) scriptType.value = opt.type
          scriptOutput.value = s.output || ''
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

      // 点击顶栏菜单外部时收起二级菜单
      document.addEventListener('click', (e) => {
        if (typeof e.target?.closest === 'function' && e.target.closest('.nav-group')) return
        openMenu.value = ''
      })

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
      diagModalOpen,
      roleModalOpen,
      ROLE_PRESETS,
      rolesInGroup,
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
      MODE_GROUPS,
      ROLE_GROUPS,
      openMenu,
      toggleMenu,
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
      exportScriptAsTxt: exportScriptAsTxtFile,
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
      // Extract
      extractInput,
      extractStyle,
      extractOutput,
      isExtracting,
      runExtract,
      // Polish
      polishInput,
      polishStrength,
      polishOutput,
      isPolishing,
      runPolish,
      // Rewrite（改写降重，学术向）
      rewriteSrcInput,
      rewriteSrcStrength,
      rewriteSrcOutput,
      isRewriteSrcRunning,
      runRewrite,
      // Wash（洗稿，自媒体向）
      washInput,
      washStyle,
      washOutput,
      washHistory,
      isWashing,
      runWash,
      washAgainWithStyle,
      styleLabel,
      // Dictionary（单词查询）
      dictWord,
      dictOutput,
      isDictRunning,
      dictHistory,
      runDictionary,
      lookupWord,
      // 代码换行
      wrapCode,
      // Outline
      outlineTopic,
      outlineType,
      outlineDepth,
      outlineOutput,
      isOutlining,
      runOutline,
      // Rewriter
      rewriteInput,
      rewriteOutput,
      rewriteTone,
      rewriteLength,
      isRewriting,
      runRewriter,
      // Writer
      WRITER_SCENES,
      applyWriterScene,
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
      // Translate
      translateInput,
      translateSource,
      translateTarget,
      translateOutput,
      isTranslating,
      runTranslate,
      swapTranslateLang,
      // Script
      scriptRequirement,
      scriptType,
      scriptNoComment,
      scriptOutput,
      isScripting,
      runScript,
    }
  }
}).mount('#app')
