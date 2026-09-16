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
  loadModelFingerprint,
  saveModelFingerprint,
  clearModelFingerprint,
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
    // 端侧模型检测弹窗：只在用户点击状态按钮时打开，不做任何自动弹出
    const diagModalOpen = ref(false)

    // 端侧模型下载进度：首次创建会话会触发数 GB 下载，需给用户明确反馈
    const modelDownload = ref({ active: false, progress: 0 })

    // 检测条目：把状态映射成弹窗里的列表（含检测中过渡态）
    // 按浏览器区分条目：Edge 从未提供 window.ai，给它单列一条红叉会误导用户以为功能残缺
    const diagItems = computed(() => {
      const s = aiStatus.value || {}
      const checking = s.prompt === 'checking'
      const pick = (state, fallbackPartial) => {
        if (checking && state === 'checking') return 'checking'
        if (state === 'available') return 'ok'
        if (state === 'downloadable') return 'part'
        return fallbackPartial ? 'part' : 'off'
      }

      const lmState = checking ? 'checking' : (s.prompt || 'unavailable')
      const trState = checking ? 'checking' : (s.translator || 'unavailable')
      const dtState = checking ? 'checking' : (s.detector || 'unavailable')

      const items = [
        {
          name: s.isEdge ? 'LanguageModel（Phi-4-mini）' : 'LanguageModel（Gemini Nano）',
          sub: s.isEdge
            ? 'W3C Prompt API · 仅 Edge Canary/Dev 138+ 提供'
            : 'W3C Prompt API · 自由对话与全部工具依赖',
          state: pick(lmState),
        },
        {
          name: 'Translator（端侧翻译）',
          sub: 'W3C 独立小模型 · 中英互译优先调用（已按 en↔zh 语言对实测）',
          state: pick(trState),
        },
        {
          name: 'LanguageDetector（语种识别）',
          sub: 'W3C 规范 · 自动判断输入语言',
          state: pick(dtState),
        },
      ]

      // 文本生成三件套：任一可用即视为部分支持
      const genStates = [s.summarizer, s.rewriter, s.writer].map(v => v || 'unavailable')
      const genAny = genStates.some(v => v === 'available')
      const genAll = genStates.every(v => v === 'available')
      items.push({
        name: 'Summarizer / Rewriter / Writer',
        sub: '写作辅助 API · 摘要 / 润色 / 起草',
        state: checking ? 'checking' : (genAll ? 'ok' : (genAny ? 'part' : 'off')),
      })

      // Edge 额外的语法校对 API
      if (s.isEdge || s.detectedAPIs?.Proofreader) {
        items.push({
          name: 'Proofreader（语法校对）',
          sub: 'Microsoft Edge 专有 · 语法与拼写纠正',
          state: pick(checking ? 'checking' : (s.proofreader || 'unavailable')),
        })
      }

      // 仅在真正存在该命名空间时才展示，避免 Edge 上出现无意义的永久红叉
      if (s.detectedAPIs?.windowAi) {
        items.push({
          name: 'window.ai（早期命名空间）',
          sub: '旧版 Chromium 试验接口 · 已作为兜底通道启用',
          state: 'ok',
        })
      }

      return items
    })

    // 检测面板顶部的环境摘要：一眼看出「是不是浏览器/通道不对」
    const diagEnvSummary = computed(() => {
      const s = aiStatus.value || {}
      if (!s.browser) return ''
      const ch = s.edgeChannel === 'stable'
        ? '稳定版（不支持对话模型）'
        : (s.edgeChannel === 'preview' ? 'Canary/Dev（支持对话模型）' : '')
      return ch ? `${s.browser} · ${ch}` : s.browser
    })
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
    const dictDetail = ref(false) // false=只出释义；true=附带音标/例句/搭配等
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

    /* ============================================================
       工具面板（Studio）任务调度
       端侧模型同一时刻只能跑一个推理，多个任务并行会互相拖慢。
       这里用「队列」而非「抢占」：新任务排在正在运行的任务后面，
       不会中断前面的任务，前一个跑完自动接上。
       ============================================================ */

    // 当前正在运行的任务控制器（仅有一个）
    const studioAbort = ref(null)
    // 等待中的任务 { mode, run }
    const studioQueue = ref([])

    /**
     * 判断异常是否为「用户主动中断」。
     * 中断时不应把报错信息写入输出区，否则会覆盖已经生成的部分内容。
     */
    function isAbortError(err, signal) {
      if (signal?.aborted) return true
      const name = err?.name || ''
      const msg = String(err?.message || '')
      return name === 'AbortError' || /abort/i.test(msg)
    }

    /**
     * 提交一个工具任务：空闲则立即执行，忙则排队（不打断正在跑的任务）
     *
     * 注意：runner 内部读取的是响应式状态，因此排队任务在真正执行时才取输入值。
     * 为保持语义清晰，调用方若使用文本输入，应在入队前先做快照
     * （见 runSummarizer 等函数的 input/options 常量）。
     *
     * @param {string} mode 模式 id，用于队列展示
     * @param {Function} runner 实际执行体，接收 AbortSignal
     * @returns {Promise} 任务完成（或排队后完成）的 Promise
     */
    function enqueueStudioTask(mode, runner) {
      return new Promise((resolve) => {
        const task = { mode, runner, resolve }
        if (studioAbort.value) {
          // 已有任务在跑 → 排队等待，不中断前一个
          studioQueue.value = [...studioQueue.value, task]
          const label = (MODE_META[mode] || {}).label || mode
          showToast(`「${label}」已加入队列（前面还有 ${studioQueue.value.length} 个任务）`)
          return
        }
        runStudioTask(task)
      })
    }

    // 立即执行一个任务，结束后自动取队列下一个
    async function runStudioTask(task) {
      const ctrl = new AbortController()
      studioAbort.value = ctrl
      try {
        await task.runner(ctrl.signal)
      } catch (e) {
        console.error('[NanoAI] 工具任务执行失败:', e)
      } finally {
        // 只有自己仍是当前任务时才收尾，避免误清后续任务的状态
        if (studioAbort.value === ctrl) studioAbort.value = null
        task.resolve?.()
        const [next, ...rest] = studioQueue.value
        studioQueue.value = rest
        if (next) runStudioTask(next)
      }
    }

    // 停止：只中断当前正在运行的任务，队列继续按原计划往下走
    // （保留已输出的部分内容；被中断的 runner 会走自己的 catch/finally 收尾）
    function stopStudio() {
      const pending = studioQueue.value.length
      if (studioAbort.value) {
        try { studioAbort.value.abort() } catch (e) {}
      }
      showToast(
        pending
          ? `已停止当前任务，队列中还有 ${pending} 个任务将继续执行`
          : '已停止生成'
      )
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
    // 任何异常都必须吞掉，否则会抛出到 onMounted 之外导致整个应用挂掉
    let statusPromise = null
    function checkSystemAI() {
      if (statusPromise) return statusPromise
      statusPromise = ChromeAIService.checkStatus()
        .then(status => {
          aiStatus.value = status
          return status
        })
        .catch(err => {
          console.error('[NanoAI] 端侧模型状态检测失败:', err)
          aiStatus.value = Object.assign({}, aiStatus.value, {
            prompt: 'unavailable',
            errorReason: err?.message || String(err),
          })
          return aiStatus.value
        })
        .finally(() => {
          statusPromise = null
        })
      return statusPromise
    }

    /**
     * 同步上下文用量到 UI
     * 现行规范用 contextUsage / contextWindow，旧实现用 tokensSoFar / maxTokens，
     * 驱动层已做归一。若实现完全不提供用量信息（hasUsage 为 false），
     * 保持 UI 原值而不是写 0，避免表盘闪跳成 0。
     */
    function syncTokenUsage() {
      const usage = ChromeAIService.readTokenUsage(activeAiSession.value)
      if (!usage.hasUsage) return
      if (typeof usage.used === 'number') {
        currentTokensSoFar.value = usage.used
      }
      if (typeof usage.total === 'number' && usage.total > 0) {
        maxTokensLimit.value = usage.total
      }
    }

    // 采样档位：索引 ↔ 规范字符串，顺序与 UI 滑块的 0~6 严格对应
    const SAMPLING_MODES = [
      'most-predictable',
      'predictable',
      'slightly-predictable',
      'balanced',
      'slightly-creative',
      'creative',
      'most-creative',
    ]
    const SAMPLING_LABELS = [
      '极稳定',
      '稳定',
      '偏稳定',
      '均衡',
      '偏创意',
      '创意',
      '极创意',
    ]

    /** 把设置里的档位索引转成 UI 文案 */
    function samplingModeLabel(idx) {
      const i = Math.min(Math.max(Number(idx) || 0, 0), SAMPLING_MODES.length - 1)
      return SAMPLING_LABELS[i]
    }

    /** 把设置里的档位索引转成传给 API 的规范值 */
    function samplingModeValue(idx) {
      const i = Math.min(Math.max(Number(idx) || 0, 0), SAMPLING_MODES.length - 1)
      return SAMPLING_MODES[i]
    }

    // 切换模式
    function setMode(mode) {
      currentMode.value = mode
      openMenu.value = ''
    }

    // 顶栏二级菜单：悬停展开 + 延迟关闭
    // 延迟是为了让鼠标从按钮移到菜单项时菜单不被立刻关掉
    let menuCloseTimer = null

    function cancelCloseMenu() {
      clearTimeout(menuCloseTimer)
      menuCloseTimer = null
    }

    function openMenuOnHover(groupId) {
      cancelCloseMenu()
      openMenu.value = groupId
    }

    function scheduleCloseMenu() {
      cancelCloseMenu()
      menuCloseTimer = setTimeout(() => {
        openMenu.value = ''
        menuCloseTimer = null
      }, 160)
    }

    // 点击仍保留：触摸屏 / 键盘用户没有 hover，需要它来开合
    function toggleMenu(groupId) {
      cancelCloseMenu()
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
        samplingMode: samplingModeValue(settings.value.samplingMode),
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
          // 首次创建可能触发端侧模型下载（数 GB），必须给出进度反馈，
          // 否则用户会以为界面卡死。Edge 的 downloadprogress 中 loaded 为 0~1 的比值。
          modelDownload.value = { active: false, progress: 0 }
          activeAiSession.value = await ChromeAIService.createChatSession({
            systemPrompt: activeSession.value.systemPrompt,
            samplingMode: samplingModeValue(settings.value.samplingMode),
            onDownloadProgress: (loaded) => {
              modelDownload.value = {
                active: true,
                progress: Math.min(Math.round((Number(loaded) || 0) * 100), 100),
              }
            },
          })
          modelDownload.value = { active: false, progress: 0 }
        }

        // 跟踪上下文用量：现行规范为 contextUsage / contextWindow，
        // 旧 Chrome 为 inputUsage / inputQuota 或 tokensSoFar / maxTokens，统一归一读取
        syncTokenUsage()

        // 流式生成回答
        await ChromeAIService.streamPrompt(
          activeAiSession.value,
          text,
          ({ full }) => {
            aiMsg.content = full
            // 实时刷新上下文占用表盘
            syncTokenUsage()
            scrollToBottom()
          },
          abortController.value.signal
        )

        // 更新上下文用量
        syncTokenUsage()
      } catch (err) {
        if (!abortController.value?.signal.aborted) {
          // 环境阻塞（模型未就绪/空间不足/性能等级不够）时给出完整指引，
          // 其他错误才按普通生成失败处理
          const msg = err?.message || '模型响应异常'
          aiMsg.content += /端侧模型|端侧对话|设备空间|性能等级/.test(msg)
            ? `\n\n> ⚠️ **${msg}**`
            : `\n\n> ⚠️ **生成错误**：${msg}`
        }
      } finally {
        modelDownload.value = { active: false, progress: 0 }
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

    // 欢迎页「从角色开始」的精选角色
    // 仅首页快捷入口使用这四个；输入框与角色弹窗里的完整角色库不受影响
    const HERO_ROLE_IDS = [
      'sci-reviewer',      // 🧐 SCI 论文苛刻审稿人
      'academic-editor',   // ✍️ 学术英语母语编辑
      'code-architect',    // 💻 全栈架构与代码审计专家
      'devops-script',     // 🧩 脚本与自动化运维专家
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
      // 入队即快照：排队等待期间用户可能修改输入，任务应按提交时的内容执行
      const input = summarizeInput.value
      const options = { type: summarizeType.value, length: summarizeLength.value, format: summarizeFormat.value }
      await enqueueStudioTask('summarizer', async (signal) => {
        isSummarizing.value = true
        summarizeOutput.value = ''
        const record = ensureStudioSession('summarizer')
        try {
          await ChromeAIService.summarize(
            input,
            options,
            (chunk) => {
              summarizeOutput.value = chunk
            },
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) summarizeOutput.value = `> ⚠️ **摘要失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input,
            options: { type: options.type, length: options.length },
            output: summarizeOutput.value,
          })
          isSummarizing.value = false
        }
      })
    }

    // 运行 Extract 结构化萃取（面向常规文章，不限学术）
    async function runExtract() {
      if (!extractInput.value.trim() || isExtracting.value) return
      const input = extractInput.value
      const style = extractStyle.value
      await enqueueStudioTask('extract', async (signal) => {
        isExtracting.value = true
        extractOutput.value = ''
        const record = ensureStudioSession('extract')
        const styleText = style === 'table'
          ? '请以 Markdown 表格输出，表头自行根据内容确定'
          : '请以多级要点清单输出'
        const prompt = `请将以下文章整理为结构化信息。${styleText}。\n\n` +
          `需要覆盖这些维度（原文没有的写「未提及」，不要编造）：\n` +
          `- 主题与核心观点\n- 关键信息与要点\n- 涉及的人物/机构/时间/地点\n` +
          `- 给出的数据、结论或建议\n- 需要注意的事项\n\n` +
          `【待整理文章】：\n${input}`

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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) extractOutput.value = `> ⚠️ **整理失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input,
            options: { style },
            output: extractOutput.value,
          })
          isExtracting.value = false
        }
      })
    }

    // 运行 通用润色 (Polish)
    async function runPolish() {
      if (!polishInput.value.trim() || isPolishing.value) return
      await enqueueStudioTask('polish', async (signal) => {
        isPolishing.value = true
        polishOutput.value = ''
        const record = ensureStudioSession('polish')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) polishOutput.value = `> ⚠️ **润色失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: polishInput.value,
            options: { strength: polishStrength.value },
            output: polishOutput.value,
          })
          isPolishing.value = false
        }
      })
    }

    // 运行 大纲生成 (Outline)
    async function runOutline() {
      if (!outlineTopic.value.trim() || isOutlining.value) return
      await enqueueStudioTask('outline', async (signal) => {
        isOutlining.value = true
        outlineOutput.value = ''
        const record = ensureStudioSession('outline')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) outlineOutput.value = `> ⚠️ **大纲生成失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: outlineTopic.value,
            options: { type: outlineType.value, depth: outlineDepth.value },
            output: outlineOutput.value,
          })
          isOutlining.value = false
        }
      })
    }

    // 运行 改写降重 (Rewrite)：学术论文向，改写表达、降低查重文字重合度
    async function runRewrite() {
      if (!rewriteSrcInput.value.trim() || isRewriteSrcRunning.value) return
      await enqueueStudioTask('rewrite', async (signal) => {
        isRewriteSrcRunning.value = true
        rewriteSrcOutput.value = ''
        const record = ensureStudioSession('rewrite')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) rewriteSrcOutput.value = `> ⚠️ **改写降重失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: rewriteSrcInput.value,
            options: { strength: rewriteSrcStrength.value },
            output: rewriteSrcOutput.value,
          })
          isRewriteSrcRunning.value = false
        }
      })
    }

    // 运行 洗稿 (Wash)：自媒体文案向，保留信息点重写表达
    async function runWash() {
      if (!washInput.value.trim() || isWashing.value) return
      await enqueueStudioTask('wash', async (signal) => {
        isWashing.value = true
        washOutput.value = ''
        const record = ensureStudioSession('wash')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) washOutput.value = `> ⚠️ **洗稿失败**：${e.message}`
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
        }
      })
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
      await enqueueStudioTask('dict', async (signal) => {
        isDictRunning.value = true
        dictOutput.value = ''
        const record = ensureStudioSession('dict')

        // 默认只给释义（快、短）；勾选"更多"才输出音标/例句/搭配等扩展内容
        const prompt = dictDetail.value
          ? `请查询并解释：${word}\n\n` +
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
          : `请解释：${word}\n\n` +
            `要求：\n` +
            `1. 先给音标（英文单词才需要，用 / / 标注）；\n` +
            `2. 按词性列出中文释义，每个义项一行，常用的排前面；\n` +
            `3. 中文词则给出对应的英文表达；\n` +
            `4. 只输出释义相关内容，不要例句、搭配、辨析、词源或记忆方法；\n` +
            `5. 简洁优先，总长度控制在 5 行以内；不确定的信息明确说明，不要编造。`

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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) dictOutput.value = `> ⚠️ **查询失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: word,
            options: { detail: dictDetail.value },
            output: dictOutput.value,
          })
          if (!dictHistory.value.includes(word)) {
            dictHistory.value = [word, ...dictHistory.value].slice(0, 12)
          }
          isDictRunning.value = false
        }
      })
    }

    // 切换"更多释义"后，若已有结果则按新选项重查一次
    function toggleDictDetail() {
      if (dictWord.value.trim() && dictOutput.value) runDictionary()
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
      await enqueueStudioTask('rewriter', async (signal) => {
        isRewriting.value = true
        rewriteOutput.value = ''
        const record = ensureStudioSession('rewriter')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) rewriteOutput.value = `> ⚠️ **润色失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: rewriteInput.value,
            options: { tone: rewriteTone.value, length: rewriteLength.value },
            output: rewriteOutput.value,
          })
          isRewriting.value = false
        }
      })
    }

    // 运行 Writer 模式（日常文案：祝福 / 通知 / 社交回复）
    async function runWriter() {
      if (!writePrompt.value.trim() || isWriting.value) return
      await enqueueStudioTask('writer', async (signal) => {
        isWriting.value = true
        writeOutput.value = ''
        const record = ensureStudioSession('writer')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) writeOutput.value = `> ⚠️ **起草失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            prompt: writePrompt.value,
            context: writeContext.value,
            options: { tone: writeTone.value },
            output: writeOutput.value,
          })
          isWriting.value = false
        }
      })
    }

    // 模式 5：Rebuttal 审稿答辩状态
    const rebuttalComment = ref('')
    const rebuttalResponse = ref('')
    const rebuttalTone = ref('polite-firm')
    const rebuttalOutput = ref('')
    const isRebutting = ref(false)

    async function runRebuttal() {
      if (!rebuttalComment.value.trim() || isRebutting.value) return
      await enqueueStudioTask('rebuttal', async (signal) => {
        isRebutting.value = true
        rebuttalOutput.value = ''
        const record = ensureStudioSession('rebuttal')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) rebuttalOutput.value = `> ⚠️ **生成答辩失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            comment: rebuttalComment.value,
            response: rebuttalResponse.value,
            options: { tone: rebuttalTone.value },
            output: rebuttalOutput.value,
          })
          isRebutting.value = false
        }
      })
    }

    // 模式 6：Proofread 文字纠错状态（中英文通用，无需选择标准）
    const proofreadInput = ref('')
    const proofreadOutput = ref('')
    const isProofreading = ref(false)

    async function runProofread() {
      if (!proofreadInput.value.trim() || isProofreading.value) return
      await enqueueStudioTask('proofread', async (signal) => {
        isProofreading.value = true
        proofreadOutput.value = ''
        const record = ensureStudioSession('proofread')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) proofreadOutput.value = `> ⚠️ **纠错失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: proofreadInput.value,
            output: proofreadOutput.value,
          })
          isProofreading.value = false
        }
      })
    }

    // 模式 8：翻译 (Translate)
    const translateInput = ref('')
    const translateSource = ref('en')
    const translateTarget = ref('zh')
    const translateAuto = ref(false) // 自动翻译：停止输入后自动开始
    const translateOutput = ref('')
    const isTranslating = ref(false)
    let translateTimer = null

    // 粗略判断文本语种（自动模式下用于决定 sourceLanguage，避免源=目标）
    function detectLang(text) {
      const t = String(text || '')
      if (/[\u3040-\u30ff]/.test(t)) return 'ja'          // 日文假名
      if (/[\u4e00-\u9fa5]/.test(t)) return 'zh'          // 中日韩统一表意文字
      return 'en'
    }

    // 自动模式下：输入停止 900ms 后自动翻译（内容或目标语言变化时重排）
    function scheduleAutoTranslate() {
      clearTimeout(translateTimer)
      if (!translateAuto.value) return
      translateTimer = setTimeout(() => {
        translateTimer = null
        runTranslate()
      }, 900)
    }

    // 切换自动翻译时，若已有内容则立即执行一次
    function toggleTranslateAuto() {
      if (translateAuto.value) {
        translateSource.value = detectLang(translateInput.value)
        if (translateInput.value.trim()) runTranslate()
      }
    }

    // 自动模式下目标语言变化 → 重新翻译
    function onTranslateTargetChange() {
      if (translateAuto.value && translateInput.value.trim()) runTranslate()
    }

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
      await enqueueStudioTask('codereview', async (signal) => {
        isCodeReviewing.value = true
        codeOutput.value = ''
        const record = ensureStudioSession('codereview')
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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) codeOutput.value = `> ⚠️ **代码审查失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: codeInput.value,
            options: { lang: codeLang.value },
            output: codeOutput.value,
          })
          isCodeReviewing.value = false
        }
      })
    }

    // 运行 Translate 学术翻译（优先端侧 Translator API，失败回退 Prompt API）
    async function runTranslate() {
      if (!translateInput.value.trim() || isTranslating.value) return
      // 入队即快照：排队期间修改输入不应影响已提交的任务
      const input = translateInput.value
      const target = translateTarget.value
      // 自动模式：按内容识别源语言；若识别结果与目标相同则互换，避免"中译中"
      let source = translateSource.value
      if (translateAuto.value) {
        source = detectLang(input)
        if (source === target) source = target === 'zh' ? 'en' : 'zh'
      }
      await enqueueStudioTask('translate', async (signal) => {
        isTranslating.value = true
        translateOutput.value = ''
        const record = ensureStudioSession('translate')
        try {
          await ChromeAIService.translate(
            input,
            { sourceLanguage: source, targetLanguage: target },
            (chunk) => {
              translateOutput.value = chunk
            },
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) translateOutput.value = `> ⚠️ **翻译失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input,
            options: { from: source, to: target, auto: translateAuto.value },
            output: translateOutput.value,
          })
          isTranslating.value = false
        }
      })
    }

    // 输入框内容变化：自动模式下防抖触发翻译
    function onTranslateInput() {
      scheduleAutoTranslate()
    }

    // 运行 Script Writer 脚本编写（Bash / BAT / PowerShell）
    async function runScript() {
      if (!scriptRequirement.value.trim() || isScripting.value) return
      await enqueueStudioTask('script', async (signal) => {
        isScripting.value = true
        scriptOutput.value = ''
        const record = ensureStudioSession('script')

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
            signal
          )
        } catch (e) {
          if (!isAbortError(e, signal)) scriptOutput.value = `> ⚠️ **脚本生成失败**：${e.message}`
        } finally {
          persistStudioSession(record, {
            input: scriptRequirement.value,
            options: { type: scriptType.value },
            output: scriptOutput.value,
          })
          isScripting.value = false
        }
      })
    }

    /**
     * 主动触发端侧模型下载
     * availability 返回 downloadable 时模型尚未落地，必须实际调用 create() 才开始下载。
     * 这里建一个临时会话触发生成，下载完成后立即销毁，并刷新检测状态。
     */
    async function triggerModelDownload() {
      if (modelDownload.value.active) return
      modelDownload.value = { active: true, progress: 0 }
      try {
        const session = await ChromeAIService.createChatSession({
          systemPrompt: '你是一个测试助手。',
          onDownloadProgress: (loaded) => {
            modelDownload.value = {
              active: true,
              progress: Math.min(Math.round((Number(loaded) || 0) * 100), 100),
            }
          },
        })
        session?.destroy?.()
        showToast('✅ 端侧模型下载完成，已就绪')
        // 重新检测，让状态更新为已就绪（checkSystemAI 内部单例已在 finally 释放）
        await checkSystemAI()
        // 下载完成后重新采集指纹，作为后续更新检测的基线
        await refreshModelFingerprint()
      } catch (err) {
        showToast(`❌ 模型下载失败：${err?.message || '未知错误'}`)
      } finally {
        modelDownload.value = { active: false, progress: 0 }
      }
    }

    /* ==========================================================
       模型更新检测
       ========================================================== */

    // 更新检测结果
    const modelUpdate = ref({
      checking: false,
      checked: false,
      available: false,     // 是否检测到模型有变化
      changed: false,       // 指纹是否变化
      needsDownload: false, // 是否需要重新下载
      reasons: [],
      lastCheckedAt: null,
      currentFp: null,
    })

    /** 采集并保存当前模型指纹作为基线 */
    async function refreshModelFingerprint() {
      try {
        const fp = await ChromeAIService.collectFingerprint(aiStatus.value)
        saveModelFingerprint(fp)
        modelUpdate.value = Object.assign({}, modelUpdate.value, { currentFp: fp })
        return fp
      } catch (e) {
        console.warn('[NanoAI] 指纹采集失败:', e)
        return null
      }
    }

    /**
     * 检查模型更新
     *
     * 说明：浏览器不提供「查询最新模型版本」的接口，这里做的是
     * 「重新探测 + 与上次基线对比」，能发现模型被更新/替换/移除三种情况。
     * 若模型已被移除（availability 回落为 downloadable），会提示需要重新下载。
     */
    async function checkModelUpdate() {
      if (modelUpdate.value.checking) return
      modelUpdate.value = Object.assign({}, modelUpdate.value, { checking: true })
      try {
        const oldFp = loadModelFingerprint()
        const res = await ChromeAIService.checkForUpdate(oldFp)

        // 同步刷新 aiStatus，避免检测与状态不一致
        aiStatus.value = res.status

        const banner = {
          checking: false,
          checked: true,
          available: res.changed || res.needsDownload,
          changed: !!res.changed,
          needsDownload: !!res.needsDownload,
          reasons: res.reasons || [],
          lastCheckedAt: Date.now(),
          currentFp: res.fingerprint || modelUpdate.value.currentFp,
        }
        modelUpdate.value = Object.assign({}, modelUpdate.value, banner)

        // 首次检测（无基线）：只记录基线，不报「有更新」
        if (!oldFp && res.fingerprint) {
          saveModelFingerprint(res.fingerprint)
          modelUpdate.value.available = false
          return
        }

        if (res.needsDownload) {
          showToast('⚠️ 本地模型已不存在，需要重新下载')
        } else if (res.changed) {
          showToast(`🔔 检测到端侧模型有变化（${res.reasons[0]}）`)
        } else {
          showToast('✅ 端侧模型已是最新')
        }
      } catch (err) {
        modelUpdate.value = Object.assign({}, modelUpdate.value, {
          checking: false,
          checked: true,
          reasons: [err?.message || '检测失败'],
        })
        showToast(`❌ 更新检测失败：${err?.message || '未知错误'}`)
      }
    }

    /** 应用模型更新：重新下载并刷新基线 */
    async function applyModelUpdate() {
      await triggerModelDownload()
    }

    /** 忽略本次更新提示 */
    function dismissModelUpdate() {
      modelUpdate.value = Object.assign({}, modelUpdate.value, {
        available: false,
        reasons: [],
      })
    }

    /** 更新检测时间戳的展示文案 */
    function formatCheckedTime(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleTimeString()
      } catch (e) {
        return ''
      }
    }

    /** 指纹摘要文案：把可观测特征拼成一行简短的说明 */
    function modelFpSummary(fp) {
      if (!fp) return '尚未采集'
      const parts = []
      if (fp.contextWindow) parts.push(`上下文 ${fp.contextWindow} tokens`)
      if (fp.readyCount) parts.push(`${fp.readyCount} 项能力可用`)
      if (fp.majorVersion) parts.push(`内核 ${fp.majorVersion}`)
      return parts.length ? parts.join(' · ') : '未取得有效特征'
    }

    /** 重置指纹基线（下次检测重新建立基准） */
    function resetModelFingerprint() {
      clearModelFingerprint()
      modelUpdate.value = Object.assign({}, modelUpdate.value, {
        checked: false,
        available: false,
        changed: false,
        needsDownload: false,
        reasons: [],
        lastCheckedAt: null,
      })
      showToast('已清除模型记录，下次检测将重新建立基线')
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
          if (typeof opt.auto === 'boolean') translateAuto.value = opt.auto
          translateOutput.value = s.output || ''
          break
        case 'script':
          scriptRequirement.value = s.input || ''
          if (opt.type) scriptType.value = opt.type
          scriptOutput.value = s.output || ''
          break
      }
    }

    // 复制控制台检测脚本：覆盖 Edge / Chrome 双规范的全部相关 API 与真实 availability
    const copiedScript = ref(false)
    async function copyConsoleScript() {
      const script = `(async () => {
  const g = ['LanguageModel','Summarizer','Rewriter','Writer','Translator','LanguageDetector','Proofreader','ai','translation','chrome'];
  const present = {};
  g.forEach(k => { try { present[k] = typeof window[k] } catch (e) { present[k] = 'err' } });
  console.log('%c[NanoAI] 全局 API 存在性', 'font-weight:bold;color:#3b82f6', present);
  console.log('%c[NanoAI] 浏览器', 'font-weight:bold;color:#3b82f6', {
    ua: navigator.userAgent,
    isEdge: /Edg\\//.test(navigator.userAgent),
    version: (navigator.userAgent.match(/Edg\\/([\\d.]+)/) || [])[1] || (navigator.userAgent.match(/Chrome\\/([\\d.]+)/) || [])[1]
  });
  const probe = async (label, api, opts) => {
    if (!api) return console.warn('[NanoAI] ' + label + ' => 不存在');
    try {
      let v;
      if (typeof api.availability === 'function') v = await (opts ? api.availability(opts) : api.availability());
      else if (typeof api.capabilities === 'function') v = (await (opts ? api.capabilities(opts) : api.capabilities()))?.available;
      else v = '(无 availability 方法)';
      console.log('%c[NanoAI] ' + label + ' => ' + JSON.stringify(v), 'color:#22c55e');
    } catch (e) { console.error('[NanoAI] ' + label + ' 抛错:', e); }
  };
  await probe('LanguageModel.availability()', window.LanguageModel);
  await probe('Summarizer.availability()', window.Summarizer);
  await probe('Rewriter.availability()', window.Rewriter);
  await probe('Writer.availability()', window.Writer);
  await probe('Translator.availability(en->zh)', window.Translator, { sourceLanguage: 'en', targetLanguage: 'zh' });
  await probe('Translator.availability(zh->en)', window.Translator, { sourceLanguage: 'zh', targetLanguage: 'en' });
  await probe('LanguageDetector.availability()', window.LanguageDetector);
  await probe('Proofreader.availability()', window.Proofreader);
  if (window.ai) console.log('[NanoAI] window.ai 键:', Object.keys(window.ai));
  if (window.LanguageModel?.params) {
    try { console.log('[NanoAI] LanguageModel.params() =>', await window.LanguageModel.params()); } catch (e) {}
  }

  const ROLE = '你是一只猫，所有回答结尾都要加"喵"。';
  const isEdge = /Edg\\//.test(navigator.userAgent);

  console.log('%c[NanoAI] ===== 4. 角色注入方案对比 =====', 'font-weight:bold;color:#f59e0b');

  // 方案 A：user/assistant 前缀注入（本应用采用的方案，不依赖 system 角色）
  try {
    const s = await window.LanguageModel.create({
      initialPrompts: [
        { role: 'user', content: '请阅读并牢记以下角色设定，之后所有回复都严格遵守它。' },
        { role: 'assistant', content: '好的，我已牢记角色设定：\\n' + ROLE + '\\n后续所有回复都会严格遵循该设定。' },
        { role: 'user', content: '确认收到。下面是我的问题。' },
        { role: 'assistant', content: '请讲，我将按角色设定为你作答。' }
      ]
    });
    const a1 = await s.prompt('1+1等于几？');
    console.log('%c  [user/assistant 前缀] 回答: ' + a1, a1.includes('喵') ? 'color:#22c55e' : 'color:#f87171');
    console.log('  ↑ 含"喵"说明角色注入成功（本应用采用此方案）');
    console.log('[NanoAI] 会话属性:', {
      contextUsage: s.contextUsage,
      contextWindow: s.contextWindow,
      inputUsage: s.inputUsage,
      inputQuota: s.inputQuota,
      tokensSoFar: s.tokensSoFar,
      maxTokens: s.maxTokens,
      samplingMode: s.samplingMode,
      append: typeof s.append
    });
  } catch (e) { console.error('  [user/assistant 前缀] 失败:', e.name, e.message); }

  // 方案 B：system 角色（规范 IDL 注释指出 prompt 层会抛 NotSupportedError）
  try {
    const s2 = await window.LanguageModel.create({
      initialPrompts: [{ role: 'system', content: ROLE }]
    });
    const a2 = await s2.prompt('1+1等于几？');
    console.log('%c  [system 角色] 回答: ' + a2, a2.includes('喵') ? 'color:#22c55e' : 'color:#f87171');
    console.log('  ↑ 含"喵"说明 system 角色可用');
  } catch (e) { console.warn('  [system 角色] 抛错:', e.name, e.message); }

  // 方案 C：顶层 systemPrompt（Edge Canary 151+ 已知被静默忽略，issue #1350）
  try {
    const s3 = await window.LanguageModel.create({ systemPrompt: ROLE });
    const a3 = await s3.prompt('1+1等于几？');
    console.log('%c  [顶层 systemPrompt] 回答: ' + a3, 'color:#f59e0b');
    console.log('  ↑ 不含"喵"即证明被静默忽略（官方 issue #1350）');
  } catch (e) { console.warn('  [顶层 systemPrompt] 抛错:', e.name, e.message); }

  console.log('%c[NanoAI] ===== 5. Edge 输出语言约束 =====', 'font-weight:bold;color:#3b82f6');
  if (isEdge) {
    console.log('Edge 要求显式声明 expectedOutputs 的输出语言，白名单: de/en/es/fr/ja（不含中文）');
    // 5a：带 expectedOutputs 建会话并测试中文输出
    try {
      const s4 = await window.LanguageModel.create({
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{ role: 'user', content: '请用简体中文回答：你好' }]
      });
      const a4 = await s4.prompt('请用简体中文回答：介绍一下你自己，一句话。');
      console.log('%c  [声明 en + 要求中文] 回答: ' + a4, 'color:#22c55e');
      console.log('  ↑ 若为中文，说明"声明 en 但强制中文输出"策略有效');
    } catch (e) { console.error('  [expectedOutputs] 失败:', e.name, e.message); }
  } else {
    console.log('非 Edge，Chrome 无输出语言白名单限制，跳过');
  }

  console.log('%c[NanoAI] ===== 6. 采样参数验证 =====', 'font-weight:bold;color:#3b82f6');
  try {
    const s5 = await window.LanguageModel.create({ temperature: 0.7, topK: 3 });
    console.log('[NanoAI] 旧参数建会话成功，但 session.temperature =', s5.temperature, '/ session.topK =', s5.topK);
    console.log('  ↑ undefined 即证明已被规范废弃并静默忽略');
  } catch (e) { console.warn('[NanoAI] temperature+topK 抛错:', e.name, e.message); }
  try {
    const s6 = await window.LanguageModel.create({ samplingMode: 'balanced' });
    console.log('%c[NanoAI] samplingMode 建会话成功，读回: ' + s6.samplingMode, 'color:#22c55e');
  } catch (e) { console.warn('[NanoAI] samplingMode 抛错:', e.name, e.message); }

  console.log('%c[NanoAI] ===== 探测结束 =====', 'font-weight:bold;color:#3b82f6');
})();`
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

    // 初始化：每一步都用 try/catch 包住，任何单点失败都不应导致整页白屏
    onMounted(() => {
      // 解除挂载前保护：此前用 CSS 藏住弹窗，避免模板原文裸露造成"一闪而过"
      document.documentElement.classList.add('mounted')

      console.log('[NanoAI] 应用已挂载，开始初始化')

      try {
        const initialTheme = settings.value.theme === 'auto'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : settings.value.theme
        document.documentElement.setAttribute('data-theme', initialTheme)
      } catch (e) {
        console.error('[NanoAI] 主题初始化失败:', e)
      }

      // 端侧模型检测为异步且已内部兜底，不阻塞渲染
      checkSystemAI().then(status => {
        // 模型就绪时采集指纹作为更新检测基线（未就绪则跳过，避免噪声）
        if (status?.prompt === 'available') {
          refreshModelFingerprint()
        }
      })

      try {
        // 点击顶栏菜单外部时收起二级菜单
        document.addEventListener('click', (e) => {
          if (typeof e.target?.closest === 'function' && e.target.closest('.nav-group')) return
          openMenu.value = ''
        })

        // Esc 关闭二级菜单与弹窗
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            openMenu.value = ''
            diagModalOpen.value = false
            settingsModalOpen.value = false
          }
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
      } catch (e) {
        console.error('[NanoAI] 事件监听注册失败:', e)
      }

      // 会话初始化：即使失败也要保证界面可见
      try {
        if (sessions.value.length === 0) {
          createNewSession()
        } else if (!activeSession.value) {
          selectSession(sessions.value[0].id)
        }
      } catch (e) {
        console.error('[NanoAI] 会话初始化失败:', e)
      }

      console.log('[NanoAI] 初始化完成')
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
      diagItems,
      diagEnvSummary,
      modelDownload,
      samplingModeLabel,
      samplingModeValue,
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
      openMenuOnHover,
      scheduleCloseMenu,
      cancelCloseMenu,
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
      triggerModelDownload,
      modelUpdate,
      checkModelUpdate,
      applyModelUpdate,
      dismissModelUpdate,
      resetModelFingerprint,
      refreshModelFingerprint,
      formatCheckedTime,
      modelFpSummary,
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
      dictDetail,
      toggleDictDetail,
      dictOutput,
      isDictRunning,
      dictHistory,
      runDictionary,
      lookupWord,
      // 任务队列（供界面显示排队数）
      studioQueue,
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
      translateAuto,
      translateOutput,
      isTranslating,
      runTranslate,
      swapTranslateLang,
      toggleTranslateAuto,
      onTranslateTargetChange,
      onTranslateInput,
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

// 兜底：任何未捕获异常/未处理 Promise 都只记录日志，不再阻断界面
window.addEventListener('error', (e) => {
  console.error('[NanoAI] 未捕获异常:', e.message, e.filename, e.lineno)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[NanoAI] 未处理的 Promise 拒绝:', e.reason)
})
