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
    if (typeof window.translation?.createDetector === 'function') {
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
      // checking = 尚未得出结果，UI 据此显示「检测中」而不是先亮一下「待配置」
      prompt: 'checking',
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
        let avail = 'available'
        if (typeof lm.availability === 'function') {
          avail = await lm.availability()
        } else if (typeof lm.capabilities === 'function') {
          const caps = await lm.capabilities()
          avail = caps.available
        }
        // 兼容标准值: 'readily', 'available', 'after-download', 'downloadable', 'downloading', 'no', 'unavailable'
        if (avail === 'readily' || avail === 'available') {
          status.prompt = 'available'
        } else if (avail === 'after-download' || avail === 'downloadable' || avail === 'downloading') {
          status.prompt = 'downloadable'
        } else if (avail === 'no' || avail === 'unavailable') {
          status.prompt = 'unavailable'
        } else {
          // 出现了标准之外的新状态值，保持 pending 让用户点击自检，不再谎报可用
          status.prompt = 'downloadable'
        }
      } catch (e) {
        console.warn('LanguageModel check error:', e)
        // 检测失败时不再乐观置为 available（旧代码会显示 ✓ 却发不出消息）
        status.prompt = 'unavailable'
      }
    }

    // 2. Summarizer API
    const sm = this.getSummarizerAPI()
    if (sm) {
      try {
        if (typeof sm.availability === 'function') {
          const avail = await sm.availability()
          status.summarizer = (avail === 'readily' || avail === 'available') ? 'available' : 'unavailable'
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
          const avail = await rw.availability()
          status.rewriter = (avail === 'readily' || avail === 'available') ? 'available' : 'unavailable'
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
          const avail = await wr.availability()
          status.writer = (avail === 'readily' || avail === 'available') ? 'available' : 'unavailable'
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
   * 文本翻译：优先使用原生 Translator API（端侧专用小模型）
   * 若浏览器未提供或语言对不受支持，则自动回退到 Prompt API 流式生成
   */
  static async translate(text, options = {}, onChunk, signal) {
    const { sourceLanguage = 'en', targetLanguage = 'zh' } = options

    const TranslatorAPI = this.getTranslatorAPI()
    if (TranslatorAPI) {
      try {
        let translator
        if (typeof TranslatorAPI.create === 'function') {
          translator = await TranslatorAPI.create({ sourceLanguage, targetLanguage })
        } else if (typeof window.translation?.createTranslator === 'function') {
          translator = await window.translation.createTranslator({ sourceLanguage, targetLanguage })
        }
        if (translator) {
          const result = await translator.translate(text)
          translator.destroy?.()
          onChunk?.(result)
          return result
        }
      } catch (e) {
        console.warn('Translator API 调用失败，回退 Prompt API:', e)
      }
    }

    // 回退：通用对话模型
    const session = await this.createChatSession({
      systemPrompt: '你是一位精通中英学术互译的专业译者。忠实原文不增删事实，使用目标语言的学术惯用表达，术语保持一致，保留原文的段落结构与逻辑连接词。只输出译文，不要任何解释或前后缀。'
    })
    return await this.streamPrompt(
      session,
      `请将以下文本从「${sourceLanguage}」翻译为「${targetLanguage}」，只输出译文：\n\n${text}`,
      onChunk,
      signal
    )
  }

  /**
   * 创建多轮对话会话 (Prompt API)
   */
  static async createChatSession(options = {}) {
    const ModelAPI = this.getLanguageModelAPI()
    if (!ModelAPI) {
      throw new Error(
        '当前浏览器尚未启用端侧 Prompt API 大模型。\n\n' +
        '📌 兼容性说明：\n' +
        '1. 本应用基于 W3C 标准 Prompt API 规范构建，原生双向支持 Google Chrome (Gemini Nano) 与 Microsoft Edge (Phi-4-mini / Phi-Silica)；\n' +
        '2. 翻译功能使用的是轻量专用小模型，主流浏览器已默认开放；而通用对话大模型目前需在 Chrome 或 Edge 的 Dev/Canary 开发者频道开启；\n' +
        '3. 解决办法：请使用 Chrome 或 Edge 的 Dev/Canary 频道并开启对应 Flags，或点击右上角「⚙️ 状态与诊断」查看详细指引。'
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

    // 容错机制：针对 Edge / 不同内核实现进行渐进式回退
    let session
    try {
      session = await ModelAPI.create(sessionOptions)
    } catch (createErr) {
      console.warn('LanguageModel.create with full options failed, falling back to minimal options:', createErr)
      try {
        session = await ModelAPI.create(systemPrompt ? { systemPrompt } : {})
      } catch (err2) {
        session = await ModelAPI.create()
      }
    }
    return session
  }

  /**
   * 流式生成对话回答 (promptStreaming 兼容同步流、Promise流、ReadableStream及普通prompt回退)
   */
  static async streamPrompt(session, promptText, onChunk, signal) {
    if (!session) throw new Error('会话未初始化')

    // Edge 与某些实现可能返回 Promise<ReadableStream> 或同步流
    let stream
    try {
      if (typeof session.promptStreaming === 'function') {
        const res = session.promptStreaming(promptText, { signal })
        stream = (res && typeof res.then === 'function') ? await res : res
      }
    } catch (e) {
      console.warn('promptStreaming call failed, falling back to prompt():', e)
    }

    let fullResponse = ''
    let previousLength = 0

    // 模式 A：支持 AsyncIterable (for await)
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream) {
        if (signal?.aborted) break
        const diff = chunk.startsWith(fullResponse) ? chunk.slice(previousLength) : chunk
        previousLength = chunk.length
        fullResponse = chunk.startsWith(fullResponse) ? chunk : (fullResponse + chunk)
        onChunk?.({ chunk: diff, full: fullResponse })
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
          const diff = chunk.startsWith(fullResponse) ? chunk.slice(previousLength) : chunk
          previousLength = chunk.length
          fullResponse = chunk.startsWith(fullResponse) ? chunk : (fullResponse + chunk)
          onChunk?.({ chunk: diff, full: fullResponse })
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
   * 不同浏览器实现差异较大，有的每一片是「增量片段」，有的是「从头累积的全文」。
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
   * 带降级的实例创建：部分浏览器实现不支持 sharedContext 等扩展参数
   */
  static async createInstance(API, options) {
    try {
      return await API.create(options)
    } catch (err) {
      const { sharedContext, ...rest } = options
      if (sharedContext === undefined) throw err
      try {
        return await API.create(rest)
      } catch (_) {
        throw err
      }
    }
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
      sharedContext = '',
    } = options

    const summarizer = await this.createInstance(SummarizerAPI, {
      type,
      format,
      length,
      sharedContext,
    })

    try {
      if (summarizer.summarizeStreaming) {
        const stream = summarizer.summarizeStreaming(text, { signal })
        let full = ''
        for await (const chunk of stream) {
          if (signal?.aborted) break
          full = this.mergeStreamChunk(full, chunk)
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

    const rewriter = await this.createInstance(RewriterAPI, {
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
          full = this.mergeStreamChunk(full, chunk)
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
      scene = '',
    } = options

    const sharedContext = [scene, context].filter(Boolean).join('\n\n')

    const writer = await this.createInstance(WriterAPI, {
      tone,
      format,
      length,
      sharedContext,
    })

    try {
      if (writer.writeStreaming) {
        const stream = writer.writeStreaming(prompt, { signal })
        let full = ''
        for await (const chunk of stream) {
          if (signal?.aborted) break
          full = this.mergeStreamChunk(full, chunk)
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
