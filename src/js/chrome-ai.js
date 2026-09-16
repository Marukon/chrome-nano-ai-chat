/**
 * 端侧 AI API 统一驱动层（Gemini Nano / Phi-4-mini）
 *
 * 全量对齐两套规范：
 *  1. Chrome 实现：window.LanguageModel / Summarizer / Rewriter / Writer / Translator / LanguageDetector
 *     availability() 返回 'readily' | 'after-download' | 'no'（旧值）或 'available' | 'downloadable' | 'unavailable'（新值）
 *  2. Edge 实现（Phi-4-mini，Canary/Dev 138.0.3309.2+）：window.LanguageModel
 *     availability() 返回 'available' | 'downloadable' | 'downloading' | 'unavailable'（4 态）
 *     create() 使用 initialPrompts [{role, content}]，支持 responseConstraint / monitor
 *  3. 早期命名空间 window.ai.* 作为兜底
 */

const SESSION_IDLE_MS = 5 * 60 * 1000

export class ChromeAIService {
  /* ==========================================================
     浏览器环境识别
     ========================================================== */

  /** 是否为 Microsoft Edge（Edge 的 UA 里同时含 Chrome 与 Edg） */
  static isEdge() {
    return /Edg[A-Z]?\//.test(navigator.userAgent) || /Edg\//.test(navigator.userAgent)
  }

  /** 是否为 Google Chrome */
  static isChrome() {
    return !!window.chrome && !this.isEdge() && /Chrome\//.test(navigator.userAgent)
  }

  /** 浏览器展示名，用于诊断面板文案 */
  static browserName() {
    if (this.isEdge()) return 'Microsoft Edge'
    if (this.isChrome()) return 'Google Chrome'
    return '当前浏览器'
  }

  /** Edge 通道判断：only Stable 不支持 Prompt API，必须 Canary / Dev */
  static edgeChannel() {
    if (!this.isEdge()) return ''
    const m = navigator.userAgent.match(/Edg\/(\d+)\.\d+\.\d+\.(\d+)/)
    if (!m) return 'unknown'
    const build = Number(m[2])
    // Canary / Dev 的构建号通常 >= 3000，Stable 一般 < 3000
    return build >= 3000 ? 'preview' : 'stable'
  }

  /* ==========================================================
     API 获取（新命名空间优先，旧命名空间兜底）
     ========================================================== */

  /**
   * 获取 Prompt API
   * 标准：window.LanguageModel  旧版：window.ai.languageModel
   */
  static getLanguageModelAPI() {
    if (typeof window.LanguageModel !== 'undefined') {
      return window.LanguageModel
    }
    if (typeof window.ai !== 'undefined' && window.ai?.languageModel) {
      return window.ai.languageModel
    }
    if (typeof window.ai !== 'undefined' && typeof window.ai.createTextSession === 'function') {
      // 极早期版本：只有 createTextSession 的裸对象
      return {
        create: (opts) => window.ai.createTextSession(opts),
        capabilities: window.ai.canCreateTextSession
          ? async () => {
              const r = await window.ai.canCreateTextSession()
              return { available: r === 'readily' ? 'readily' : r }
            }
          : undefined,
      }
    }
    return null
  }

  static getSummarizerAPI() {
    if (typeof window.Summarizer !== 'undefined') {
      return window.Summarizer
    }
    if (typeof window.ai !== 'undefined' && window.ai?.summarizer) {
      return window.ai.summarizer
    }
    return null
  }

  static getRewriterAPI() {
    if (typeof window.Rewriter !== 'undefined') {
      return window.Rewriter
    }
    if (typeof window.ai !== 'undefined' && window.ai?.rewriter) {
      return window.ai.rewriter
    }
    return null
  }

  static getWriterAPI() {
    if (typeof window.Writer !== 'undefined') {
      return window.Writer
    }
    if (typeof window.ai !== 'undefined' && window.ai?.writer) {
      return window.ai.writer
    }
    return null
  }

  /** 获取 Translator API（Chrome 与 Edge 均已默认开放） */
  static getTranslatorAPI() {
    if (typeof window.Translator !== 'undefined') {
      return window.Translator
    }
    if (typeof window.translation?.createTranslator === 'function') {
      return window.translation
    }
    if (typeof window.ai !== 'undefined' && window.ai?.translator) {
      return window.ai.translator
    }
    return null
  }

  /** 获取 LanguageDetector API */
  static getDetectorAPI() {
    if (typeof window.LanguageDetector !== 'undefined') {
      return window.LanguageDetector
    }
    if (typeof window.translation?.createDetector === 'function') {
      return window.translation
    }
    if (typeof window.ai !== 'undefined' && window.ai?.languageDetector) {
      return window.ai.languageDetector
    }
    return null
  }

  /**
   * 获取 Proofreader API（Edge 额外提供，Chrome 暂无）
   */
  static getProofreaderAPI() {
    if (typeof window.Proofreader !== 'undefined') {
      return window.Proofreader
    }
    if (typeof window.ai !== 'undefined' && window.ai?.proofreader) {
      return window.ai.proofreader
    }
    return null
  }

  /* ==========================================================
     状态归一化
     ========================================================== */

  /**
   * 把各浏览器五花八门的 availability 返回值归一化
   * @returns {'available'|'downloadable'|'unavailable'}
   */
  static normalizeAvailability(avail) {
    const v = String(avail ?? '').toLowerCase()
    if (v === 'readily' || v === 'available') return 'available'
    if (v === 'after-download' || v === 'downloadable' || v === 'downloading') return 'downloadable'
    if (v === 'no' || v === 'unavailable' || v === '') return 'unavailable'
    // 未知新状态：按「需下载」处理，让用户去自检，而不是谎报可用
    return 'downloadable'
  }

  /**
   * 通用 availability 探测，自动兼容 availability() / capabilities()
   * @param {object} API  带 availability 或 capabilities 的构造器
   * @param {object} [opts] 传给 availability 的参数（Edge/Chrome 的 Translator 需要语言对）
   */
  static async probeAvailability(API, opts) {
    if (!API) return 'unavailable'
    try {
      if (typeof API.availability === 'function') {
        return this.normalizeAvailability(opts ? await API.availability(opts) : await API.availability())
      }
      if (typeof API.capabilities === 'function') {
        const caps = opts ? await API.capabilities(opts) : await API.capabilities()
        return this.normalizeAvailability(caps?.available)
      }
      // 既没有 availability 也没有 capabilities：只能认为存在即可用
      return 'available'
    } catch (e) {
      console.warn('[NanoAI] availability 探测失败:', e)
      return 'unavailable'
    }
  }

  /* ==========================================================
     全局状态检测
     ========================================================== */

  /**
   * 检查所有可用端侧 AI API 的就绪状态
   */
  static async checkStatus() {
    const browser = this.browserName()

    const status = {
      browser,
      isEdge: this.isEdge(),
      edgeChannel: this.edgeChannel(),
      // checking = 尚未得出结果，UI 据此显示「检测中」而不是先亮一下「待配置」
      prompt: 'checking',
      summarizer: 'unavailable',
      rewriter: 'unavailable',
      writer: 'unavailable',
      translator: 'unavailable',
      detector: 'unavailable',
      proofreader: 'unavailable',
      // 模型是否需要下载（Edge 会在首次调用时拉取 Phi-4-mini）
      downloading: false,
      detectedAPIs: {
        LanguageModel: false,
        windowAi: false,
        Translator: false,
        LanguageDetector: false,
        Summarizer: false,
        Rewriter: false,
        Writer: false,
        Proofreader: false,
      }
    }

    // 记录原始 API 存在性
    status.detectedAPIs.LanguageModel = typeof window.LanguageModel !== 'undefined'
    status.detectedAPIs.windowAi = typeof window.ai !== 'undefined'
    status.detectedAPIs.Translator = typeof window.Translator !== 'undefined'
    status.detectedAPIs.LanguageDetector = typeof window.LanguageDetector !== 'undefined'
    status.detectedAPIs.Summarizer = typeof window.Summarizer !== 'undefined'
    status.detectedAPIs.Rewriter = typeof window.Rewriter !== 'undefined'
    status.detectedAPIs.Writer = typeof window.Writer !== 'undefined'
    status.detectedAPIs.Proofreader = typeof window.Proofreader !== 'undefined'

    // 1. Prompt API / LanguageModel（对话模型，全部工具的基础）
    // Edge 需要带 expectedOutputs 探测，否则会因未声明输出语言而告警
    const lmAPI = this.getLanguageModelAPI()
    const lmProbeOpts = this.buildExpectedOutputs()
      ? { expectedOutputs: this.buildExpectedOutputs() }
      : undefined
    status.prompt = await this.probeAvailability(lmAPI, lmProbeOpts)

    // 记录 Edge 特有约束，供 UI 精确提示
    if (this.isEdge()) {
      status.edgeOutputLangs = this.EDGE_OUTPUT_LANGS
      status.edgeChineseSupported = this.EDGE_OUTPUT_LANGS.includes('zh')
    }

    // 1b. 上下文窗口：模型就绪时顺带建一次会话读出真实窗口大小，
    //     这样默认检测就能把真实值（如 9216）交给 UI，无需用户手动触发指纹检测。
    //     窗口是模型级属性，读完后立即销毁会话，不留副作用。
    if (status.prompt === 'available') {
      try {
        const probeSession = await this.createChatSession({})
        const usage = this.readTokenUsage(probeSession)
        status.contextWindow = usage.total || null
        status.samplingMode = this.readSamplingMode(probeSession)
        probeSession?.destroy?.()
      } catch (e) {
        // 读窗口失败不影响整体状态判定，UI 会保留默认值
        console.warn('[NanoAI] 上下文窗口探测失败:', e?.message || e)
      }
    }

    // 2. 文本生成类 API
    // Edge 的写作辅助 API 同样要求声明输出语言，不传会误判为「未开启」
    const genProbeOpts = status.edgeOutputLangs
      ? { outputLanguage: 'en' }
      : undefined
    const [summarizer, rewriter, writer] = await Promise.all([
      this.probeAvailability(this.getSummarizerAPI(), genProbeOpts),
      this.probeAvailability(this.getRewriterAPI(), genProbeOpts),
      this.probeAvailability(this.getWriterAPI(), genProbeOpts),
    ])
    status.summarizer = summarizer
    status.rewriter = rewriter
    status.writer = writer

    // 3. Translator：必须做真实语言对探测，否则会出现「显示可用但翻译报错」
    const translatorAPI = this.getTranslatorAPI()
    if (translatorAPI) {
      const zhEn = await this.probeAvailability(translatorAPI, { sourceLanguage: 'en', targetLanguage: 'zh' })
      status.translator = zhEn
      // Chrome 的 en->zh 若不可用，退一步试 zh->en，任一可用即认为翻译能力存在
      if (zhEn === 'unavailable') {
        const enZh = await this.probeAvailability(translatorAPI, { sourceLanguage: 'zh', targetLanguage: 'en' })
        status.translator = enZh
      }
      // 记录具体语言对能力，供 UI 精确提示
      status.translatorPairs = {
        'en->zh': zhEn,
        'zh->en': zhEn === 'unavailable' ? 'unavailable' : zhEn,
      }
    }

    // 4. LanguageDetector
    status.detector = await this.probeAvailability(this.getDetectorAPI())

    // 5. Proofreader（Edge 专有）
    status.proofreader = await this.probeAvailability(this.getProofreaderAPI())

    return status
  }

  /**
   * 汇总「任意一个文本生成 API 是否可用」，供诊断面板判定
   */
  static anyTextApiReady(status) {
    if (!status) return false
    return status.summarizer === 'available'
      || status.rewriter === 'available'
      || status.writer === 'available'
  }

  /* ==========================================================
     模型更新检测
     ========================================================== */

  /**
   * 采集当前推理环境指纹
   *
   * Prompt API 未提供模型版本查询接口，因此用「可观测特征」拼出签名：
   *  - 浏览器与内核版本：内核升级常伴随模型换代
   *  - contextWindow：模型换代最可靠的信号之一（不同模型窗口大小不同）
   *  - 模型可用数量：Edge 侧模型增减可反映下发变化
   *  - systemPrompt 归属：由 LLM 能力探测得到的行为特征
   *
   * 该指纹变化即提示「模型可能已更新」。
   */
  static async collectFingerprint(status, reuseSession) {
    const ua = navigator.userAgent
    const chromeVer = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || ''
    const edgeVer = (ua.match(/Edg\/([\d.]+)/) || [])[1] || ''

    // contextWindow 来源按可靠性排序，避免重复建会话：
    //   1. 调用方传入的活跃会话
    //   2. checkStatus 已探测到的窗口（默认检测阶段就拿到了）
    //   3. 兜底：临时建一次会话读取
    let contextWindow = status?.contextWindow || null
    let samplingMode = status?.samplingMode || null
    let session = reuseSession || null
    let createdTemp = false

    if (!session && !contextWindow) {
      try {
        session = await this.createChatSession({})
        createdTemp = true
      } catch (e) {
        // 模型未就绪时读不到窗口大小，指纹里保持 null，不阻断检测
        console.warn('[NanoAI] 指纹采集：无法读取 contextWindow')
      }
    }

    if (session) {
      try {
        const usage = this.readTokenUsage(session)
        if (usage.total) contextWindow = usage.total
        samplingMode = this.readSamplingMode(session)
      } catch (e) {
        console.warn('[NanoAI] 指纹采集：会话读取失败')
      } finally {
        // 只销毁我们自己创建的临时会话，绝不动调用方传进来的活跃会话
        if (createdTemp) session.destroy?.()
      }
    }

    const readyCount = status
      ? ['prompt', 'summarizer', 'rewriter', 'writer', 'translator', 'detector']
          .filter(k => status[k] === 'available').length
      : 0

    return {
      browser: this.isEdge() ? 'edge' : (this.isChrome() ? 'chrome' : 'other'),
      chromeVersion: chromeVer,
      edgeVersion: edgeVer,
      // 只取主版本号，避免补丁版本频繁变化造成误报
      majorVersion: (edgeVer || chromeVer).split('.')[0] || '',
      contextWindow,
      samplingMode,
      readyCount,
      collectedAt: Date.now(),
    }
  }

  /**
   * 对比指纹，判断模型是否有更新
   * @returns {{changed: boolean, reasons: string[], removed: boolean}}
   */
  static compareFingerprint(oldFp, newFp) {
    if (!oldFp || !newFp) {
      return { changed: false, reasons: [], removed: false }
    }

    const reasons = []

    // 内核主版本升级：最常见的模型换代契机
    if (oldFp.majorVersion && newFp.majorVersion && oldFp.majorVersion !== newFp.majorVersion) {
      reasons.push(`浏览器内核版本从 ${oldFp.majorVersion} 升级到 ${newFp.majorVersion}`)
    }

    // 上下文窗口变化：模型换代最可靠的信号
    if (oldFp.contextWindow && newFp.contextWindow && oldFp.contextWindow !== newFp.contextWindow) {
      reasons.push(`模型上下文窗口从 ${oldFp.contextWindow} 变为 ${newFp.contextWindow}`)
    }

    // 可用能力数量下降：可能是模型被移除或回滚
    const removed = typeof oldFp.readyCount === 'number'
      && typeof newFp.readyCount === 'number'
      && newFp.readyCount < oldFp.readyCount

    if (removed) {
      reasons.push(`可用端侧能力从 ${oldFp.readyCount} 项减少到 ${newFp.readyCount} 项`)
    }

    return { changed: reasons.length > 0, reasons, removed }
  }

  /**
   * 主动检查模型更新
   *
   * 说明：浏览器不提供「查询最新模型版本」的接口，因此本方法做的是
   * 「重新探测 + 与上次记录对比」，能发现：模型被更新、被替换、被移除。
   * 若 availability 回落为 downloadable，说明本地模型已不在，需重新下载。
   */
  static async checkForUpdate(oldFp, reuseSession) {
    const status = await this.checkStatus()

    // 模型缺失：需要重新下载
    if (status.prompt === 'downloadable' || status.prompt === 'downloading') {
      return {
        status,
        needsDownload: true,
        changed: false,
        reasons: ['本地端侧模型已不存在，需要重新下载'],
      }
    }

    if (status.prompt !== 'available') {
      return {
        status,
        needsDownload: false,
        changed: false,
        reasons: [],
      }
    }

    const newFp = await this.collectFingerprint(status, reuseSession)
    const diff = this.compareFingerprint(oldFp, newFp)

    return {
      status,
      fingerprint: newFp,
      needsDownload: false,
      changed: diff.changed,
      reasons: diff.reasons,
      removed: diff.removed,
    }
  }

  /* ==========================================================
     会话创建
     ========================================================== */

  /**
   * 采样参数映射：把应用层的 temperature/topK 转成现行规范的 samplingMode
   *
   * 背景（重要）：
   *  - temperature / topK 在现行 W3C 规范中已废弃，仅在 Web Extension 上下文生效；
   *    普通网页上下文下浏览器会静默忽略，session 上对应属性为 undefined。
   *  - Edge Canary 151 起严格执行规范，若继续传已废弃选项，行为不可预期。
   *  - 现行替代方案是高层预设 samplingMode（7 档），因此这里做等价映射。
   */
  static toSamplingMode(temperature, topK) {
    const t = typeof temperature === 'number' ? temperature : 0.7
    // 结合 topK 做微调：topK 越小越保守
    const k = typeof topK === 'number' ? topK : 3
    let score = t
    if (k <= 1) score -= 0.15
    else if (k <= 3) score -= 0.05
    else if (k >= 40) score += 0.08

    if (score < 0.15) return 'most-predictable'
    if (score < 0.32) return 'predictable'
    if (score < 0.46) return 'slightly-predictable'
    if (score < 0.62) return 'balanced'
    if (score < 0.76) return 'slightly-creative'
    if (score < 0.9) return 'creative'
    return 'most-creative'
  }

  /**
   * Edge 明确支持的输出语言白名单
   * Edge 153 实测：不声明输出语言会告警「No output language was specified」，
   * 且其支持的输出语言代码仅 [de, en, es, fr, ja] —— 不包含中文。
   */
  static EDGE_OUTPUT_LANGS = ['de', 'en', 'es', 'fr', 'ja']

  /**
   * 根据浏览器构造 expectedOutputs
   *
   * Edge 要求显式声明输出语言，否则会告警且可能影响输出质量与安全审核。
   * 由于中文不在 Edge 白名单内，这里声明 'en' 绕过白名单校验，
   * 再靠提示词强制模型用中文回答（实测可行，属于质量声明而非硬性限制）。
   */
  static buildExpectedOutputs() {
    if (!this.isEdge()) return undefined
    return [{ type: 'text', languages: ['en'] }]
  }

  /**
   * 把角色设定转成 initialPrompts
   *
   * 依据 W3C Prompt API 规范 IDL 注释：role = "system" 在 prompt()/promptStreaming()
   * 层面会抛 NotSupportedError。为避免踩坑，这里改用 user/assistant 问答对来
   * 「示范」角色定位，再补一条 user 消息宣告后续输入均属于该角色语境。
   * 这种写法不依赖 system 角色，Chrome 与 Edge 均稳定支持。
   */
  static buildRolePrompts(rolePrompt) {
    if (!rolePrompt) return undefined
    return [
      { role: 'user', content: '请阅读并牢记以下角色设定，之后所有回复都严格遵守它。' },
      { role: 'assistant', content: `好的，我已牢记角色设定：\n${rolePrompt}\n后续所有回复都会严格遵循该设定。` },
      { role: 'user', content: '确认收到。下面是我的问题。' },
      { role: 'assistant', content: '请讲，我将按角色设定为你作答。' },
    ]
  }

  /**
   * 创建多轮对话会话 (Prompt API)
   *
   * 关键兼容点（依据 W3C Prompt API 草案 + Edge 153 实测 + 微软 issue #1350）：
   *  - role='system' 在方法层会抛 NotSupportedError，故角色改用 user/assistant 前缀注入。
   *  - 顶层 systemPrompt 选项在 Edge Canary 151+ 被**静默忽略**，仅作最后兜底。
   *  - temperature / topK 已废弃，改用 samplingMode。
   *  - Edge 需显式声明 expectedOutputs 的输出语言，否则告警且质量无保障。
   */
  static async createChatSession(options = {}) {
    const ModelAPI = this.getLanguageModelAPI()
    if (!ModelAPI) {
      throw new Error(this.buildNoModelMessage())
    }

    const {
      systemPrompt,
      temperature = 0.7,
      topK = 3,
      samplingMode,
      onDownloadProgress,
    } = options

    const monitor = onDownloadProgress
      ? (m) => {
          m.addEventListener('downloadprogress', (e) => {
            // 规范中 loaded 为 0~1 的进度比，total 恒为 1
            onDownloadProgress(e.loaded ?? 0, e.total ?? 1)
          })
        }
      : undefined

    const rolePrompts = this.buildRolePrompts(systemPrompt)
    const expectedOutputs = this.buildExpectedOutputs()
    const mode = samplingMode || this.toSamplingMode(temperature, topK)

    /* 回退梯度：规范优先 → 旧行为兜底，保证任何一家实现都能建出会话 */
    const attempts = [
      // 1) 最完整形态：user/assistant 角色对 + samplingMode + expectedOutputs
      () => {
        const o = { samplingMode: mode }
        if (rolePrompts) o.initialPrompts = rolePrompts
        if (expectedOutputs) o.expectedOutputs = expectedOutputs
        if (monitor) o.monitor = monitor
        return ModelAPI.create(o)
      },
      // 2) 去掉 samplingMode（部分实现不认会抛 TypeError）
      () => {
        const o = {}
        if (rolePrompts) o.initialPrompts = rolePrompts
        if (expectedOutputs) o.expectedOutputs = expectedOutputs
        if (monitor) o.monitor = monitor
        return ModelAPI.create(o)
      },
      // 3) 再去掉 expectedOutputs
      () => {
        const o = {}
        if (rolePrompts) o.initialPrompts = rolePrompts
        if (monitor) o.monitor = monitor
        return ModelAPI.create(o)
      },
      // 4) system 角色形态（Chrome 旧实现更认这个）
      () => {
        const o = {}
        if (systemPrompt) o.initialPrompts = [{ role: 'system', content: systemPrompt }]
        if (monitor) o.monitor = monitor
        return ModelAPI.create(o)
      },
      // 5) 旧 Chrome 形态：systemPrompt + temperature/topK
      () => {
        const o = { temperature, topK }
        if (systemPrompt) o.systemPrompt = systemPrompt
        if (monitor) o.monitor = monitor
        return ModelAPI.create(o)
      },
      // 6) 完全裸建，之后由 wrapSession 在首轮把角色拼进 prompt
      () => ModelAPI.create(),
    ]

    let lastErr = null
    for (let i = 0; i < attempts.length; i++) {
      try {
        const session = await attempts[i]()
        if (session) {
          // 走到第 6 级说明角色未被任何参数承载，需在首轮拼接
          if (systemPrompt && i === 5) {
            session.__nanoPendingSystemPrompt = systemPrompt
          }
          // 记录角色是否已注入，供调用方判断
          session.__nanoRoleInjected = i <= 3
          session.__nanoSamplingMode = mode
          return this.wrapSession(session)
        }
      } catch (e) {
        lastErr = e
        // 空间/性能类错误属于环境硬阻塞，继续回退没有意义，直接抛出精准提示
        if (this.isEnvironmentBlockError(e)) {
          throw new Error(this.buildBlockedMessage(e))
        }
        console.warn('[NanoAI] LanguageModel.create 回退尝试失败:', e?.name, e?.message || e)
      }
    }

    throw new Error(
      `端侧对话会话创建失败：${lastErr?.message || '未知错误'}\n\n` +
      this.buildNoModelMessage()
    )
  }

  /**
   * 判断是否为环境硬阻塞错误（磁盘空间 / 性能等级 / 模型不可用）
   * 这类错误重试任何参数组合都不会成功，应立即向用户反馈
   */
  static isEnvironmentBlockError(err) {
    const msg = String(err?.message || '')
    return /enough space|NotSupportedError|performance class|not capable/i.test(`${err?.name || ''} ${msg}`)
  }

  /** 环境阻塞时的精准提示：区分空间不足与性能等级不足两种主因 */
  static buildBlockedMessage(err) {
    const msg = String(err?.message || '')
    const isSpace = /enough space/i.test(msg)

    if (isSpace) {
      return (
        '端侧模型无法下载：Edge 报告设备空间不足。\n\n' +
        '📌 说明：Edge 端侧模型要求浏览器配置卷可用空间 ≥ 20 GB，低于 10 GB 时已下载的模型会被自动删除。\n' +
        '⚠️ 注意：该错误文案字面只说「空间不足」，但实际也可能是设备性能等级不达标或模型未对该配置下发。\n\n' +
        '✅ 排查步骤：\n' +
        '1. 访问 edge://on-device-internals，查看「模型状态」与「设备性能类」；\n' +
        '2. 性能类需为 High 或更高才会加载 Phi-4-mini；\n' +
        '3. 确认 C 盘（Edge 配置卷）可用空间 ≥ 20 GB；\n' +
        '4. 确认当前为「非计量网络」（开热点或流量卡不会触发下载）；\n' +
        '5. 若性能类不足，可在 edge://flags 启用「启用设备预发行版语言模型」改用 Aion-1.0-Instruct 小模型。'
      )
    }

    return (
      `端侧模型不可用：${msg}\n\n` +
      '📌 请访问 edge://on-device-internals 查看「设备性能类」与「模型状态」，\n' +
      '性能类需达 High 或更高，且模型状态应为「已就绪」。'
    )
  }

  /**
   * 构造中文输出指令
   * Edge 输出语言白名单不含中文，因此需要靠提示词显式要求中文回答
   */
  static buildChineseDirective() {
    if (!this.isEdge()) return ''
    return '\n\n【重要】无论输入与输出语言声明如何，请始终使用简体中文作答。'
  }

  /** 给原生 session 挂上统一的兼容方法（首轮角色注入 / 上下文用量归一） */
  static wrapSession(session) {
    if (!session || session.__nanoWrapped) return session
    session.__nanoWrapped = true

    const directive = this.buildChineseDirective()

    const wrap = (fn) => async function (text, opts) {
      // 仅当完全裸建（所有参数形态均被拒）时，首轮把角色拼进 prompt
      let finalText = text
      if (session.__nanoPendingSystemPrompt) {
        finalText = `${session.__nanoPendingSystemPrompt}\n\n---\n\n${text}`
        session.__nanoPendingSystemPrompt = null
      }
      if (directive) {
        finalText += directive
      }
      return fn.call(session, finalText, opts)
    }

    if (typeof session.prompt === 'function') {
      session.prompt = wrap(session.prompt)
    }
    if (typeof session.promptStreaming === 'function') {
      session.promptStreaming = wrap(session.promptStreaming)
    }
    return session
  }

  /** 未就绪时的统一引导文案（按浏览器区分） */
  static buildNoModelMessage() {
    if (this.isEdge()) {
      return (
        '当前 Edge 未启用端侧对话大模型（Phi-4-mini）。\n\n' +
        '✅ 排查与开启步骤：\n' +
        '1. 打开 edge://on-device-internals，查看「模型状态」与「设备性能类」;\n' +
        '2. 性能等级需为 High 或更高才会加载 Phi-4-mini；等级不足时可在 edge://flags 启用\n' +
        '   「启用设备预发行版语言模型」改用更轻量的 Aion-1.0-Instruct；\n' +
        '3. 确认已启用 edge://flags 中的「设备语言模型的提示 API」；\n' +
        '4. 硬件要求：显存 ≥ 5.5 GB、Edge 配置卷可用空间 ≥ 20 GB、非计量网络；\n' +
        '5. 版本要求：Edge Canary / Dev 138.0.3309.2 或更高。\n\n' +
        '⚠️ 若报「设备空间不足」但磁盘充足，通常是性能等级不达标或模型未对该配置下发，\n' +
        '   该错误文案字面只说空间，实际由多项条件组合判定。\n\n' +
        '⚠️ Edge 输出语言白名单为 de/en/es/fr/ja（不含中文），本应用已声明 en 并\n' +
        '   通过提示词强制中文作答；若中文质量不稳定，建议改用 Chrome 获得最佳体验。\n\n' +
        '💡 翻译、语种识别这类轻量 API 在 Edge 可直接使用，不受上述限制。'
      )
    }
    return (
      '当前浏览器尚未启用端侧 Prompt API 大模型。\n\n' +
      '📌 兼容性说明：\n' +
      '1. 本应用基于 W3C 标准 Prompt API 规范构建，原生支持 Google Chrome (Gemini Nano) 与 Microsoft Edge (Phi-4-mini)；\n' +
      '2. 翻译功能使用轻量专用小模型，主流浏览器已默认开放；通用对话大模型需在 Chrome 稳定版开启 Flags，或使用 Edge Canary/Dev；\n' +
      '3. 请访问 chrome://flags/#prompt-api-for-gemini-nano 设为 Enabled 后重启，或点击右上角「⚙️ 状态与诊断」查看详细指引。'
    )
  }

  /* ==========================================================
     流式生成
     ========================================================== */

  /**
   * 流式生成对话回答
   * 兼容同步流、Promise<ReadableStream>、AsyncIterable、getReader，以及 prompt() 降级
   */
  static async streamPrompt(session, promptText, onChunk, signal) {
    if (!session) throw new Error('会话未初始化')

    let stream
    try {
      if (typeof session.promptStreaming === 'function') {
        const res = session.promptStreaming(promptText, { signal })
        stream = (res && typeof res.then === 'function') ? await res : res
      }
    } catch (e) {
      console.warn('[NanoAI] promptStreaming 调用失败，回退 prompt():', e)
    }

    let fullResponse = ''

    // 模式 A：AsyncIterable (for await)
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream) {
        if (signal?.aborted) break
        fullResponse = this.mergeStreamChunk(fullResponse, chunk)
        onChunk?.({ chunk, full: fullResponse })
      }
      return fullResponse
    }

    // 模式 B：标准 Web ReadableStream (getReader)
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          if (signal?.aborted) break
          const { done, value } = await reader.read()
          if (done) break
          const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true })
          fullResponse = this.mergeStreamChunk(fullResponse, chunk)
          onChunk?.({ chunk, full: fullResponse })
        }
      } finally {
        reader.releaseLock()
      }
      return fullResponse
    }

    // 模式 C：降级回退 session.prompt()，彻底杜绝发消息卡死
    if (typeof session.prompt === 'function') {
      const res = await session.prompt(promptText, { signal })
      fullResponse = typeof res === 'string' ? res : JSON.stringify(res)
      onChunk?.({ chunk: fullResponse, full: fullResponse })
      return fullResponse
    }

    throw new Error('当前端侧会话无可用生成方法')
  }

  /**
   * 归一化流式分片：
   * 不同实现差异较大，有的每一片是「增量片段」，有的是「从头累积的全文」。
   * 这里统一合并为「从头累积的全文」，避免 UI 上出现「蹦一个字、消失一个字」的覆盖问题。
   */
  static mergeStreamChunk(previous, chunk) {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    if (!text) return previous
    if (!previous) return text
    if (text.startsWith(previous)) return text
    return previous + text
  }

  /**
   * 带降级的实例创建：部分实现不支持 sharedContext / monitor 等扩展参数
   */
  static async createInstance(API, options) {
    const attempts = [
      options,
      Object.fromEntries(Object.entries(options).filter(([k]) => k !== 'sharedContext' && k !== 'monitor')),
      {},
    ]
    let lastErr = null
    for (const opts of attempts) {
      try {
        return await API.create(opts)
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('实例创建失败')
  }

  /** 流式消费 AsyncIterable，统一合并分片 */
  static async consumeStream(stream, onChunk, signal) {
    let full = ''
    for await (const chunk of stream) {
      if (signal?.aborted) break
      full = this.mergeStreamChunk(full, chunk)
      onChunk?.(full)
    }
    return full
  }

  /* ==========================================================
     文本能力：摘要 / 改写 / 起草 / 校对
     ========================================================== */

  /** 执行文本摘要 (Summarizer API) */
  static async summarize(text, options = {}, onChunk, signal) {
    const SummarizerAPI = this.getSummarizerAPI()
    if (!SummarizerAPI) {
      throw new Error('当前浏览器未检测到 Summarizer API（Edge 请确认已在 edge://flags 开启写作辅助 API）。')
    }

    const { type = 'key-points', format = 'markdown', length = 'medium', sharedContext = '' } = options
    const summarizer = await this.createInstance(SummarizerAPI, { type, format, length, sharedContext })

    try {
      if (typeof summarizer.summarizeStreaming === 'function') {
        return await this.consumeStream(summarizer.summarizeStreaming(text, { signal }), onChunk, signal)
      }
      const result = await summarizer.summarize(text, { signal })
      onChunk?.(result)
      return result
    } finally {
      summarizer.destroy?.()
    }
  }

  /** 执行文本润色改写 (Rewriter API) */
  static async rewrite(text, options = {}, onChunk, signal) {
    const RewriterAPI = this.getRewriterAPI()
    if (!RewriterAPI) {
      throw new Error('当前浏览器未检测到 Rewriter API（Edge 请确认已在 edge://flags 开启写作辅助 API）。')
    }

    const { tone = 'more-formal', format = 'markdown', length = 'as-is', sharedContext = '' } = options
    const rewriter = await this.createInstance(RewriterAPI, { tone, format, length, sharedContext })

    try {
      if (typeof rewriter.rewriteStreaming === 'function') {
        return await this.consumeStream(rewriter.rewriteStreaming(text, { signal }), onChunk, signal)
      }
      const result = await rewriter.rewrite(text, { signal })
      onChunk?.(result)
      return result
    } finally {
      rewriter.destroy?.()
    }
  }

  /** 执行定向辅助写作 (Writer API) */
  static async write(prompt, options = {}, onChunk, signal) {
    const WriterAPI = this.getWriterAPI()
    if (!WriterAPI) {
      throw new Error('当前浏览器未检测到 Writer API（Edge 请确认已在 edge://flags 开启写作辅助 API）。')
    }

    const { tone = 'formal', format = 'markdown', length = 'medium', context = '', scene = '' } = options
    const sharedContext = [scene, context].filter(Boolean).join('\n\n')
    const writer = await this.createInstance(WriterAPI, { tone, format, length, sharedContext })

    try {
      if (typeof writer.writeStreaming === 'function') {
        return await this.consumeStream(writer.writeStreaming(prompt, { signal }), onChunk, signal)
      }
      const result = await writer.write(prompt, { signal })
      onChunk?.(result)
      return result
    } finally {
      writer.destroy?.()
    }
  }

  /**
   * 语法校对：优先使用 Proofreader API（Edge 提供），
   * 不可用时由调用方回退到 Prompt API
   */
  static async proofread(text, options = {}) {
    const ProofreaderAPI = this.getProofreaderAPI()
    if (!ProofreaderAPI) return null

    const { language = 'en' } = options
    const proofreader = await this.createInstance(ProofreaderAPI, { language })
    try {
      const corrections = await proofreader.proofread(text)
      return corrections
    } finally {
      proofreader.destroy?.()
    }
  }

  /* ==========================================================
     翻译与语种识别
     ========================================================== */

  /** 创建 Translator 实例，兼容新旧两种创建入口 */
  static async createTranslatorInstance(sourceLanguage, targetLanguage) {
    const TranslatorAPI = this.getTranslatorAPI()
    if (!TranslatorAPI) return null
    const opts = { sourceLanguage, targetLanguage }
    if (typeof TranslatorAPI.create === 'function') {
      return await TranslatorAPI.create(opts)
    }
    if (typeof window.translation?.createTranslator === 'function') {
      return await window.translation.createTranslator(opts)
    }
    return null
  }

  /**
   * 快速测试本地端侧 Translator API
   */
  static async testTranslate(text = 'Hello world! Built-in on-device AI is working.', sourceLanguage = 'en', targetLanguage = 'zh') {
    const translator = await this.createTranslatorInstance(sourceLanguage, targetLanguage)
    if (!translator) {
      throw new Error('未检测到本地 Translator API')
    }
    const start = performance.now()
    const result = await translator.translate(text)
    const duration = Math.round(performance.now() - start)
    translator.destroy?.()
    return { result, duration }
  }

  /**
   * 文本翻译：优先使用原生 Translator API（端侧专用小模型）
   * 若浏览器未提供或语言对不受支持，则自动回退到 Prompt API 流式生成
   */
  static async translate(text, options = {}, onChunk, signal) {
    const { sourceLanguage = 'en', targetLanguage = 'zh' } = options

    try {
      const translator = await this.createTranslatorInstance(sourceLanguage, targetLanguage)
      if (translator) {
        const result = await translator.translate(text, { signal })
        translator.destroy?.()
        onChunk?.(result)
        return result
      }
    } catch (e) {
      console.warn('[NanoAI] Translator API 调用失败，回退 Prompt API:', e)
    }

    // 回退：通用对话模型
    const session = await this.createChatSession({
      systemPrompt:
        '你是一位精通中英学术互译的专业译者。忠实原文不增删事实，使用目标语言的学术惯用表达，' +
        '术语保持一致，保留原文的段落结构与逻辑连接词。只输出译文，不要任何解释或前后缀。',
    })
    return await this.streamPrompt(
      session,
      `请将以下文本从「${sourceLanguage}」翻译为「${targetLanguage}」，只输出译文：\n\n${text}`,
      onChunk,
      signal
    )
  }

  /**
   * 安全读取会话的上下文用量
   *
   * 名称演进（W3C 草案）：
   *   inputUsage    → contextUsage（当前已用）
   *   inputQuota    → contextWindow（总窗口）
   * 旧的 tokensSoFar / maxTokens 在现行规范中已无对应物，
   * 但仍作为兜底读取，以兼容旧版 Chrome 实现。
   * 三者均不存在时返回 null，交由 UI 隐藏占用表盘而不是显示错误的 0。
   */
  static readTokenUsage(session) {
    if (!session) return { used: null, total: null, hasUsage: false }

    const pick = (...keys) => {
      for (const k of keys) {
        const v = session[k]
        if (typeof v === 'number' && !Number.isNaN(v)) return v
      }
      return null
    }

    const used = pick('contextUsage', 'inputUsage', 'tokensSoFar')
    const total = pick('contextWindow', 'inputQuota', 'maxTokens')

    return { used, total, hasUsage: used !== null || total !== null }
  }

  /**
   * 预估某段文本将占用的上下文 token 数（不实际处理）
   * 规范方法名：measureContextUsage（旧名 measureInputUsage）
   */
  static async measureContextUsage(session, text, signal) {
    if (!session) return null
    for (const name of ['measureContextUsage', 'measureInputUsage']) {
      if (typeof session[name] === 'function') {
        try {
          return await session[name](text, { signal })
        } catch (e) {
          console.warn(`[NanoAI] ${name} 调用失败:`, e)
          return null
        }
      }
    }
    return null
  }

  /**
   * 读取会话的采样模式：samplingMode 为只读属性
   */
  static readSamplingMode(session) {
    return session?.samplingMode || session?.__nanoSamplingMode || 'balanced'
  }

  /**
   * 向已有会话追加 system 消息
   * 规范允许 append([{role:'system', ...}])，且必须在序列第 0 位语义下使用
   */
  static async appendSystemPrompt(session, systemPrompt) {
    if (!session || !systemPrompt) return false
    if (typeof session.append !== 'function') return false
    try {
      await session.append([{ role: 'system', content: systemPrompt }])
      return true
    } catch (e) {
      console.warn('[NanoAI] session.append 注入 system 失败:', e)
      return false
    }
  }

  /**
   * 克隆会话：保留创建参数但不保留历史，用于「重新开始」而不必重建模型
   */
  static async cloneSession(session) {
    if (session && typeof session.clone === 'function') {
      try {
        return this.wrapSession(await session.clone())
      } catch (e) {
        console.warn('[NanoAI] session.clone 失败，将改用重建:', e)
      }
    }
    return null
  }

  /**
   * 结构化输出：使用 responseConstraint 让模型按 JSON Schema / RegExp 返回
   *
   * 规范要点：responseConstraint 是 **prompt() 层** 的选项，不是 create() 的选项。
   * 取值 JSON Schema 对象或 RegExp；UA 不支持 schema 特性时抛 NotSupportedError，
   * 无法产出符合约束的响应时抛 SyntaxError，故此处按错误类型分别回退。
   */
  static async promptWithConstraint(session, promptText, jsonSchema, onChunk, signal) {
    if (!session) throw new Error('会话未初始化')

    if (jsonSchema && typeof session.prompt === 'function') {
      try {
        const result = await session.prompt(promptText, { responseConstraint: jsonSchema, signal })
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        onChunk?.({ chunk: text, full: text })
        return text
      } catch (e) {
        const name = e?.name || ''
        if (name === 'NotSupportedError') {
          console.warn('[NanoAI] 该浏览器不支持所给 JSON Schema 特性，回退普通生成:', e.message)
        } else if (name === 'SyntaxError') {
          console.warn('[NanoAI] 模型未能产出符合约束的响应，回退普通生成:', e.message)
        } else {
          console.warn('[NanoAI] responseConstraint 调用失败，回退普通生成:', e)
        }
      }
    }
    return await this.streamPrompt(session, promptText, onChunk, signal)
  }

  /**
   * 读取模型能力参数（仅扩展上下文可用；网页上下文返回 null）
   */
  static async readModelParams() {
    const ModelAPI = this.getLanguageModelAPI()
    if (!ModelAPI || typeof ModelAPI.params !== 'function') return null
    try {
      return await ModelAPI.params()
    } catch (e) {
      return null
    }
  }

  /**
   * 会话空闲自动销毁，释放端侧模型占用的显存
   */
  static scheduleIdleDestroy(session, onDestroy) {
    if (!session) return () => {}
    let timer = setTimeout(() => {
      session.destroy?.()
      onDestroy?.()
    }, SESSION_IDLE_MS)
    return () => clearTimeout(timer)
  }
}
