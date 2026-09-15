/**
 * Chrome 原生端侧 AI API 统一驱动层 (Gemini Nano)
 * 适配 WICG 官方标准标准与 Chrome 138+ 规范
 */

export class ChromeAIService {
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
    }

    try {
      if ('ai' in window && 'languageModel' in window.ai) {
        const caps = await window.ai.languageModel.capabilities()
        status.prompt = caps.available // 'readily' | 'after-download' | 'no'
      }
    } catch (e) {
      console.warn('LanguageModel check error:', e)
    }

    try {
      if ('ai' in window && 'summarizer' in window.ai) {
        const caps = await window.ai.summarizer.capabilities()
        status.summarizer = caps.available
      }
    } catch (e) {
      console.warn('Summarizer check error:', e)
    }

    try {
      if ('ai' in window && 'rewriter' in window.ai) {
        const caps = await window.ai.rewriter.capabilities()
        status.rewriter = caps.available
      }
    } catch (e) {
      console.warn('Rewriter check error:', e)
    }

    try {
      if ('ai' in window && 'writer' in window.ai) {
        const caps = await window.ai.writer.capabilities()
        status.writer = caps.available
      }
    } catch (e) {
      console.warn('Writer check error:', e)
    }

    try {
      if ('Translator' in window) {
        status.translator = 'supported'
      }
    } catch (e) {
      console.warn('Translator check error:', e)
    }

    try {
      if ('LanguageDetector' in window) {
        status.detector = 'supported'
      }
    } catch (e) {
      console.warn('LanguageDetector check error:', e)
    }

    return status
  }

  /**
   * 创建多轮对话会话 (Prompt API)
   */
  static async createChatSession(options = {}) {
    if (!('ai' in window) || !('languageModel' in window.ai)) {
      throw new Error('当前浏览器不支持 Chrome Prompt API (window.ai.languageModel)，请使用 Google Chrome 138+ 并开启对应 Flags。')
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

    const session = await window.ai.languageModel.create(sessionOptions)
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
      // Chrome promptStreaming 默认返回的是累积文本，计算增量以适应不同消费习惯
      const diff = chunk.slice(previousLength)
      previousLength = chunk.length
      fullResponse = chunk
      onChunk?.({ chunk: diff, full: fullResponse })
    }

    return fullResponse
  }

  /**
   * 执行文本摘要 (Summarizer API)
   */
  static async summarize(text, options = {}, onChunk, signal) {
    if (!('ai' in window) || !('summarizer' in window.ai)) {
      throw new Error('当前浏览器不支持 Chrome Summarizer API。')
    }

    const {
      type = 'key-points', // 'key-points' | 'tl;dr' | 'teaser' | 'headline'
      format = 'markdown',  // 'markdown' | 'plain-text'
      length = 'medium',   // 'short' | 'medium' | 'long'
    } = options

    const summarizer = await window.ai.summarizer.create({
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
    if (!('ai' in window) || !('rewriter' in window.ai)) {
      throw new Error('当前浏览器不支持 Chrome Rewriter API。')
    }

    const {
      tone = 'more-formal', // 'more-formal' | 'more-casual' | 'as-is'
      format = 'markdown',  // 'markdown' | 'plain-text'
      length = 'as-is',     // 'shorter' | 'longer' | 'as-is'
      sharedContext = '',
    } = options

    const rewriter = await window.ai.rewriter.create({
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
    if (!('ai' in window) || !('writer' in window.ai)) {
      throw new Error('当前浏览器不支持 Chrome Writer API。')
    }

    const {
      tone = 'formal',
      format = 'markdown',
      length = 'medium',
      context = '',
    } = options

    const writer = await window.ai.writer.create({
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
