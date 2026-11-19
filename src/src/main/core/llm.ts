import { classifyHttp, classifyNetwork, LlmError } from './errors'
import type { ChatMessage } from '../../shared/types'
import { parseUsage, type UsageNumbers } from './usage'

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface StreamChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: unknown[]
  tools?: ToolDef[]
  temperature?: number
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  fetchImpl?: typeof fetch
  /** 当前代理描述（用于错误提示） */
  proxyLabel?: string
}

export interface StreamChatResult {
  content: string
  toolCalls: LlmToolCall[]
  finishReason: string | null
  /** 推理模型的思考过程（reasoning_content） */
  reasoning?: string
  /** v0.7：服务商返回的用量（stream_options.include_usage） */
  usage?: UsageNumbers
}

/** 不接受 stream_options 的服务（首次 400 后记住，之后不再携带） */
const noStreamOptions = new Set<string>()
export function _resetStreamOptionsCache(): void {
  noStreamOptions.clear()
}

export function chatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(b)) return b
  return b + '/chat/completions'
}

/** 把本地消息转换成 OpenAI 兼容格式 */
export function toApiMessages(system: string, history: ChatMessage[], opts: { vision?: boolean; maxToolImages?: number } = {}): unknown[] {
  const vision = opts.vision !== false
  const maxToolImages = opts.maxToolImages ?? 2
  // 只把最近几条工具截图发给模型，节省 token
  const toolImageIdx = new Set<number>()
  if (vision) {
    for (let i = history.length - 1; i >= 0 && toolImageIdx.size < maxToolImages; i--)
      if (history[i].role === 'tool' && history[i].images?.length) toolImageIdx.add(i)
  }
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })
  let pendingImages: string[] = []
  const flushImages = (): void => {
    if (!pendingImages.length) return
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: '（以下是上一步工具返回的截图，供你查看）' },
        ...pendingImages.map((url) => ({ type: 'image_url', image_url: { url } }))
      ]
    })
    pendingImages = []
  }
  history.forEach((m, i) => {
    if (m.role !== 'tool') flushImages()
    if (m.role === 'user') {
      if (m.images && m.images.length) {
        if (vision)
          out.push({
            role: 'user',
            content: [{ type: 'text', text: m.content || '(图片)' }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
          })
        else out.push({ role: 'user', content: `${m.content}\n[附带 ${m.images.length} 张图片，当前模型未启用视觉]` })
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          // 推理模型（如 DeepSeek 思考模式）在工具调用回合中需要回传思考内容
          ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
          tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments || '{}' } }))
        })
      } else if (m.content) {
        out.push({ role: 'assistant', content: m.content })
      }
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
      if (toolImageIdx.has(i) && m.images) pendingImages.push(...m.images)
    }
  })
  flushImages()
  return out
}

/** 调用 /chat/completions（stream=true），解析 SSE 增量 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const f = opts.fetchImpl || fetch
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true
  }
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature
  if (opts.tools && opts.tools.length) body.tools = opts.tools
  const optKey = opts.baseUrl.trim().replace(/\/+$/, '')
  // v0.7：请求在最后一个流式片段里附带用量（OpenAI / DeepSeek / vLLM / 新版 Ollama 均支持）
  if (!noStreamOptions.has(optKey)) body.stream_options = { include_usage: true }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

  let res: Response
  try {
    res = await f(chatCompletionsUrl(opts.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal
    })
  } catch (e) {
    if (opts.signal?.aborted) throw e
    throw classifyNetwork(e, { baseUrl: opts.baseUrl, proxy: opts.proxyLabel })
  }
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
    } catch {
      /* ignore */
    }
    if (res.status === 400 && body.stream_options && /stream_options|include_usage|unrecognized|unknown (field|parameter)|extra (fields|inputs)/i.test(text)) {
      noStreamOptions.add(optKey)
      return streamChat(opts)
    }
    throw classifyHttp(res.status, text, { model: opts.model, retryAfter: res.headers.get('retry-after') })
  }

  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let usage: UsageNumbers | undefined
  const calls: { id: string; name: string; arguments: string }[] = []

  const handleJson = (json: any): void => {
    if (json?.error && !json?.choices) {
      // 部分服务在流中返回错误对象
      throw classifyHttp(Number(json.error.code) >= 400 ? Number(json.error.code) : 400, JSON.stringify(json), { model: opts.model })
    }
    if (json?.usage) usage = parseUsage(json.usage) || usage
    const choice = json?.choices?.[0]
    if (!choice) return
    const delta = choice.delta || choice.message || {}
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content
      opts.onReasoning?.(delta.reasoning_content)
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      opts.onDelta?.(delta.content)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : calls.length
        if (!calls[idx]) calls[idx] = { id: '', name: '', arguments: '' }
        if (tc.id) calls[idx].id = tc.id
        if (tc.function?.name && calls[idx].name !== tc.function.name) calls[idx].name += tc.function.name
        if (tc.function?.arguments) calls[idx].arguments += tc.function.arguments
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const ctype = res.headers.get('content-type') || ''
  if (!res.body || ctype.includes('application/json')) {
    // 部分服务忽略 stream 参数，直接返回完整 JSON
    handleJson(await res.json())
  } else {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let done = false
    while (!done) {
      const r = await reader.read()
      if (r.done) break
      buf += decoder.decode(r.value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          done = true
          break
        }
        let parsedJson: any
        try {
          parsedJson = JSON.parse(data)
        } catch {
          /* 忽略无法解析的片段 */
        }
        if (parsedJson !== undefined) {
          handleJson(parsedJson)
        }
      }
    }
    try {
      reader.cancel().catch(() => {})
    } catch {
      /* ignore */
    }
  }

  const toolCalls = calls
    .filter((c) => c && c.name)
    .map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.arguments || '{}' }))
  return { content, toolCalls, finishReason, reasoning: reasoning || undefined, usage }
}

/** 带自动重试的流式调用：仅在尚未输出任何内容时，对可重试错误（429 / 5xx / 网络）重试 */
export async function streamChatWithRetry(
  opts: StreamChatOptions,
  retry: { attempts?: number; baseDelayMs?: number; onRetry?: (e: LlmError, attempt: number, delayMs: number) => void } = {}
): Promise<StreamChatResult> {
  const attempts = retry.attempts ?? 2
  let emitted = false
  const wrapped: StreamChatOptions = {
    ...opts,
    onDelta: (d) => {
      emitted = true
      opts.onDelta?.(d)
    }
  }
  for (let i = 0; ; i++) {
    try {
      return await streamChat(wrapped)
    } catch (e) {
      if (opts.signal?.aborted || !(e instanceof LlmError) || !e.retryable || emitted || i >= attempts) throw e
      const delay = Math.min(20000, e.retryAfterMs ?? (retry.baseDelayMs ?? 1000) * 2 ** i)
      retry.onRetry?.(e, i + 1, delay)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        }, { once: true })
      })
    }
  }
}
