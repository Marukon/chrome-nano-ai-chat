/**
 * Chrome 原生端侧 AI API 统一驱动层 (Gemini Nano)
 * 全面兼容最新标准全局对象 (window.LanguageModel 等) 与早期版本 (window.ai.*)
 */

export class ChromeAIService {
  /**
   * 获取 Prompt API (优先匹配标准 window.LanguageModel，回退 window.ai.languageModel)
   */
  static getLanguageModelAPI() {
    if (typeof window.LanguageModel !== 'undefined') {
      return window.LanguageModel
    }
    if (typeof window.ai !== 'undefined' && window.ai?.languageModel) {
      return window.ai.languageModel
    }
    return null
  }

  /**
   * 获取 Summarizer API
   */
  static getSummarizerAPI() {
    if (typeof window.Summarizer !== 'undefined') {
      return window.Summarizer
    }
    if (typeof window.ai !== 'undefined' && window.ai?.summarizer) {
      return window.ai.summarizer
    }
    return null
  }

  /**
   * 获取 Rewriter API
   */
  static getRewriterAPI() {
    if (typeof window.Rewriter !== 'undefined') {
      return window.Rewriter
    }
    if (typeof window.ai !== 'undefined' && window.ai?.rewriter) {
      return window.ai.rewriter
    }
    return null
  }

  /**
   * 获取 Writer API
   */
  static getWriterAPI() {
    if (typeof window.Writer !== 'undefined') {
      return window.Writer
    }
    if (typeof window.ai !== 'undefined' && window.ai?.writer) {
      return window.ai.writer
    }
    return null
  }

  /**
   * 获取 Translator API
   */
  static getTranslatorAPI() {
    if (typeof window.Translator !== 'undefined') {
      return window.Translator
    }
    if (typeof window.translation?.createTranslator !== 'undefined') {
      return window.translation
    }
    if (typeof window.ai !== 'undefined' && window.ai?.translator) {
      return window.ai.translator
    }
    return null
  }

  /**
   * 获取 LanguageDetector API
   */
  static getDetectorAPI() {
    if (typeof window.LanguageDetector !== 'undefined') {
      return window.LanguageDetector
    }
    if (typeof window.translation?.createDetector !== 'undefined') {
      return window.translation
    }
    if (typeof window.ai !== 'undefined' && window.ai?.languageDetector) {
      return window.ai.languageDetector
    }
    return null
  }

  /**
   * 检查所有可用端侧 AI API 的就绪状态
   */
  static async checkStatus() {
    const status = {
      prompt: 'unavailable',
      summarizer: 'unavailable',
      rewriter: 'unavailable',
      writer: 'unavailable',
      translator: 'unavailable',
      detector: 'unavailable',
      detectedAPIs: {
        LanguageModel: false,
        windowAi: false,
        Translator: false,
        LanguageDetector: false,
        Summarizer: false,
        Rewriter: false,
        Writer: false,
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

    // 1. Prompt API / LanguageModel
    const lm = this.getLanguageModelAPI()
    if (lm) {
      try {
        if (typeof lm.availability === 'function') {
          status.prompt = await lm.availability()
        } else if (typeof lm.capabilities === 'function') {
          const caps = await lm.capabilities()
          status.prompt = caps.available === 'readily' ? 'available' : (caps.available === 'after-download' ? 'downloadable' : 'unavailable')
        } else {
          status.prompt = 'available'
        }
      } catch (e) {
        console.warn('LanguageModel check error:', e)
        status.prompt = 'available'
      }
    }

    // 2. Summarizer API
    const sm = this.getSummarizerAPI()
    if (sm) {
      try {
        if (typeof sm.availability === 'function') {
          status.summarizer = await sm.availability()
        } else if (typeof sm.capabilities === 'function') {
          const caps = await sm.capabilities()
          status.summarizer = caps.available === 'readily' ? 'available' : 'unavailable'
        } else {
          status.summarizer = 'available'
        }
      } catch (e) {
        console.warn('Summarizer check error:', e)
      }
    }

    // 3. Rewriter API
    const rw = this.getRewriterAPI()
    if (rw) {
      try {
        if (typeof rw.availability === 'function') {
          status.rewriter = await rw.availability()
        } else if (typeof rw.capabilities === 'function') {
          const caps = await rw.capabilities()
          status.rewriter = caps.available === 'readily' ? 'available' : 'unavailable'
        } else {
          status.rewriter = 'available'
        }
      } catch (e) {
        console.warn('Rewriter check error:', e)
      }
    }

    // 4. Writer API
    const wr = this.getWriterAPI()
    if (wr) {
      try {
        if (typeof wr.availability === 'function') {
          status.writer = await wr.availability()
        } else if (typeof wr.capabilities === 'function') {
          const caps = await wr.capabilities()
          status.writer = caps.available === 'readily' ? 'available' : 'unavailable'
        } else {
          status.writer = 'available'
        }
      } catch (e) {
        console.warn('Writer check error:', e)
      }
    }

    // 5. Translator API
    if (this.getTranslatorAPI()) {
      status.translator = 'available'
    }

    // 6. LanguageDetector API
    if (this.getDetectorAPI()) {
      status.detector = 'available'
    }

    return status
  }

  /**
   * 快速测试本地端侧 Translator API
   */
  static async testTranslate(text = 'Hello world! Built-in on-device AI is working.', sourceLanguage = 'en', targetLanguage = 'zh') {
    const TranslatorAPI = this.getTranslatorAPI()
    if (!TranslatorAPI) {
      throw new Error('未检测到本地 Translator API')
    }

    let translator
    if (typeof TranslatorAPI.create === 'function') {
      translator = await TranslatorAPI.create({ sourceLanguage, targetLanguage })
    } else if (typeof window.translation?.createTranslator === 'function') {
      translator = await window.translation.createTranslator({ sourceLanguage, targetLanguage })
    } else {
      throw new Error('当前环境无法创建 Translator 实例')
    }

    const start = performance.now()
    const result = await translator.translate(text)
    const duration = Math.round(performance.now() - start)
    translator.destroy?.()
    return { result, duration }
  }

  /**
   * 创建多轮对话会话 (Prompt API)
   */
  static async createChatSession(options = {}) {
    const ModelAPI = this.getLanguageModelAPI()
    if (!ModelAPI) {
      throw new Error(
        '当前浏览器尚未启用 Chrome Prompt API (Gemini Nano)。\n\n' +
        '📌 为什么“翻译能用”而“自由对话”无法使用？\n' +
        '1. 翻译（Translator API）使用的是独立轻量小模型（数十兆），Chrome 正式版已逐步默认开放；\n' +
        '2. 对话（Gemini Nano）是 1.5GB 的端侧大语言模型，Google 目前仅在 Chrome Dev / Canary (138+) 开发者频道开放，普通正式版中 Flags 被官方隐藏；\n' +
        '3. 解决办法：请使用 Chrome Canary / Dev 并在 chrome://flags 中开启 #prompt-api-for-gemini-nano，或点击右上角「⚙️ 状态与诊断」查看详细指引。'
      )
    }

    const { systemPrompt, temperature = 0.7, topK = 3, onDownloadProgress } = options

    const sessionOptions = {
      temperature,
      topK,
    }

    if (systemPrompt) {
      sessionOptions.systemPrompt = systemPrompt
    }

    if (onDownloadProgress) {
      sessionOptions.monitor = (monitor) => {
        monitor.addEventListener('downloadprogress', (e) => {
          onDownloadProgress(e.loaded || 0)
        })
      }
    }

    const session = await ModelAPI.create(sessionOptions)
    return session
  }

  /**
   * 流式生成对话回答 (promptStreaming)
   */
  static async streamPrompt(session, promptText, onChunk, signal) {
    if (!session) throw new Error('会话未初始化')

    const stream = session.promptStreaming(promptText, { signal })
    let fullResponse = ''
    let previousLength = 0

    for await (const chunk of stream) {
      if (signal?.aborted) break
      // Chrome promptStreaming 在不同版本下可能返回增量或累积文本，进行自适应容错
      const diff = chunk.startsWith(fullResponse) ? chunk.slice(previousLength) : chunk
      previousLength = chunk.length
      fullResponse = chunk.startsWith(fullResponse) ? chunk : (fullResponse + chunk)
      onChunk?.({ chunk: diff, full: fullResponse })
    }

    return fullResponse
  }

  /**
   * 执行文本摘要 (Summarizer API)
   */
  static async summarize(text, options = {}, onChunk, signal) {
    const SummarizerAPI = this.getSummarizerAPI()
    if (!SummarizerAPI) {
      throw new Error('当前浏览器未检测到 Chrome Summarizer API。')
    }

    const {
      type = 'key-points',
      format = 'markdown',
      length = 'medium',
    } = options

    const summarizer = await SummarizerAPI.create({
      type,
      format,
      length,
    })

    try {
      if (summarizer.summarizeStreaming) {
        const stream = summarizer.summarizeStreaming(text, { signal })
        let full = ''
        for await (const chunk of stream) {
          if (signal?.aborted) break
          full = chunk
          onChunk?.(full)
        }
        return full
      } else {
        const result = await summarizer.summarize(text, { signal })
        onChunk?.(result)
        return result
      }
    } finally {
      summarizer.destroy?.()
    }
  }

  /**
   * 执行文本润色改写 (Rewriter API)
   */
  static async rewrite(text, options = {}, onChunk, signal) {
    const RewriterAPI = this.getRewriterAPI()
    if (!RewriterAPI) {
      throw new Error('当前浏览器未检测到 Chrome Rewriter API。')
    }

    const {
      tone = 'more-formal',
      format = 'markdown',
      length = 'as-is',
      sharedContext = '',
    } = options

    const rewriter = await RewriterAPI.create({
      tone,
      format,
      length,
      sharedContext,
    })

    try {
      if (rewriter.rewriteStreaming) {
        const stream = rewriter.rewriteStreaming(text, { signal })
        let full = ''
        for await (const chunk of stream) {
          if (signal?.aborted) break
          full = chunk
          onChunk?.(full)
        }
        return full
      } else {
        const result = await rewriter.rewrite(text, { signal })
        onChunk?.(result)
        return result
      }
    } finally {
      rewriter.destroy?.()
    }
  }

  /**
   * 执行定向辅助写作 (Writer API)
   */
  static async write(prompt, options = {}, onChunk, signal) {
    const WriterAPI = this.getWriterAPI()
    if (!WriterAPI) {
      throw new Error('当前浏览器未检测到 Chrome Writer API。')
    }

    const {
      tone = 'formal',
      format = 'markdown',
      length = 'medium',
      context = '',
    } = options

    const writer = await WriterAPI.create({
      tone,
      format,
      length,
      sharedContext: context,
    })

    try {
      if (writer.writeStreaming) {
        const stream = writer.writeStreaming(prompt, { signal })
        let full = ''
        for await (const chunk of stream) {
          if (signal?.aborted) break
          full = chunk
          onChunk?.(full)
        }
        return full
      } else {
        const result = await writer.write(prompt, { signal })
        onChunk?.(result)
        return result
      }
    } finally {
      writer.destroy?.()
    }
  }
}
