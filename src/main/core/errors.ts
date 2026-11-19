/** 模型接口错误分类：给出清晰的中文说明、是否可重试 */
export type LlmErrorKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'model_not_found'
  | 'no_tools'
  | 'no_vision'
  | 'context_overflow'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'proxy'
  | 'timeout'
  | 'unknown'

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: LlmErrorKind,
    public retryable: boolean,
    public status?: number,
    public retryAfterMs?: number,
    public detail?: string
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

function extractMessage(body: string): string {
  try {
    const j = JSON.parse(body)
    const m = j?.error?.message || j?.message || j?.error || j?.detail
    if (typeof m === 'string') return m
    if (m) return JSON.stringify(m)
  } catch {
    /* 非 JSON */
  }
  return body.replace(/\s+/g, ' ').trim()
}

const CONTEXT_RE = /context[_ ]length|maximum context|context window|too many tokens|token limit|prompt is too long|reduce the length|上下文|超出.*长度|max_tokens.*exceed|string too long/i
const TOOLS_RE = /(tools?|function[_ ]?call(ing)?|tool_choice)[^.]{0,60}(not (supported|support|available)|unsupported|不支持)|does not support (tools|function)/i
const VISION_RE = /(image|vision|image_url|multimodal|图片|图像)[^.]{0,60}(not (supported|support|allowed)|unsupported|不支持|invalid content type)|does not support (image|vision)|only supports? text/i
const MODEL_RE = /model[^.]{0,40}(not (found|exist)|does not exist|unknown|invalid|无效|不存在)|model_not_found|no such model/i
const QUOTA_RE = /insufficient_quota|quota|余额|balance|billing|credit|欠费|exceeded your current/i

/** 根据 HTTP 状态码与响应体分类 */
export function classifyHttp(status: number, body: string, ctx: { model?: string; retryAfter?: string | null } = {}): LlmError {
  const msg = extractMessage(body).slice(0, 300)
  const detail = `HTTP ${status}${msg ? '：' + msg : ''}`
  const ra = ctx.retryAfter ? Number(ctx.retryAfter) * 1000 : undefined
  if (CONTEXT_RE.test(msg)) return new LlmError(`对话内容超出模型的上下文长度（${detail}）。已尝试自动裁剪历史；如仍失败，请清空对话或在设置中调小「上下文预算」。`, 'context_overflow', false, status, undefined, msg)
  if (status === 401 || (status === 403 && !QUOTA_RE.test(msg)))
    return new LlmError(`API Key 无效或没有权限（${detail}）。请在「全局设置 → 模型接口」检查密钥是否填写正确、是否属于该服务商。`, 'auth', false, status, undefined, msg)
  if (status === 402 || (QUOTA_RE.test(msg) && status !== 404))
    return new LlmError(`账户余额不足或额度已用完（${detail}）。请到服务商控制台充值或更换密钥。`, 'quota', false, status, undefined, msg)
  if (status === 429)
    return new LlmError(`请求过于频繁，触发了服务商的速率限制（${detail}）。请稍后重试。`, 'rate_limit', true, status, ra && Number.isFinite(ra) ? ra : undefined, msg)
  if (status === 404 || MODEL_RE.test(msg))
    return new LlmError(`模型「${ctx.model || '?'}」不存在或当前密钥无权使用（${detail}）。请检查模型名称，或检查 Base URL 是否以 /v1 结尾。`, 'model_not_found', false, status, undefined, msg)
  if (TOOLS_RE.test(msg)) return new LlmError(`当前模型「${ctx.model || '?'}」不支持工具调用（${detail}）。请换用支持 function calling 的模型。`, 'no_tools', false, status, undefined, msg)
  if (VISION_RE.test(msg))
    return new LlmError(`当前模型「${ctx.model || '?'}」不支持图片输入（${detail}）。截图、电脑控制等功能需要视觉模型，或在设置中关闭「发送图片给模型」。`, 'no_vision', false, status, undefined, msg)
  if (status >= 500) return new LlmError(`模型服务暂时不可用（${detail}）。通常稍后重试即可。`, 'server', true, status, ra, msg)
  if (status === 408) return new LlmError(`请求超时（${detail}），请重试。`, 'timeout', true, status, undefined, msg)
  return new LlmError(`接口请求失败（${detail}）`, 'bad_request', false, status, undefined, msg)
}

/** 网络层错误（DNS、拒绝连接、代理、超时等） */
export function classifyNetwork(err: unknown, ctx: { baseUrl?: string; proxy?: string } = {}): LlmError {
  if (err instanceof LlmError) return err
  const e = err as any
  const raw = [e?.message, e?.cause?.code, e?.cause?.message, e?.code].filter(Boolean).join(' ')
  let host = ctx.baseUrl || ''
  try {
    host = new URL(ctx.baseUrl || '').host
  } catch {
    /* ignore */
  }
  if (e?.name === 'TimeoutError' || /timed? ?out|ETIMEDOUT|UND_ERR_.*TIMEOUT|ERR_TIMED_OUT/i.test(raw))
    return new LlmError(`连接 ${host} 超时。请检查网络或代理设置后重试。`, 'timeout', true, undefined, undefined, raw)
  if (ctx.proxy && /PROXY|SOCKS|ERR_TUNNEL|ERR_PROXY|ECONNREFUSED/i.test(raw))
    return new LlmError(`代理连接失败（${ctx.proxy}）。请确认代理软件已启动、地址和端口正确，或在「全局设置 → 网络代理」中更换。`, 'proxy', true, undefined, undefined, raw)
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(raw))
    return new LlmError(`无法解析域名 ${host}。请检查网络连接；在中国大陆访问海外模型服务通常需要在「全局设置 → 网络代理」中配置代理。`, 'network', true, undefined, undefined, raw)
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(raw))
    return new LlmError(`${host} 拒绝连接。如果使用本地模型（如 Ollama），请确认它已启动；否则请检查 Base URL。`, 'network', true, undefined, undefined, raw)
  if (/ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|socket hang up|EPIPE|ERR_NETWORK_CHANGED/i.test(raw))
    return new LlmError(`与 ${host} 的连接被中断。这在中国大陆直连海外服务时很常见，请配置代理后重试。`, 'network', true, undefined, undefined, raw)
  if (/CERT|SSL|TLS/i.test(raw)) return new LlmError(`与 ${host} 建立安全连接失败（证书/TLS 错误）。如使用了抓包或公司代理，请检查证书设置。`, 'network', false, undefined, undefined, raw)
  if (/ERR_UNSAFE_PORT/.test(raw)) return new LlmError(`${host} 使用了浏览器禁止的端口，请更换端口。`, 'network', false, undefined, undefined, raw)
  if (/fetch failed|network|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH|ENETUNREACH/i.test(raw))
    return new LlmError(`无法连接到 ${host}。请检查网络；在中国大陆访问 OpenAI / xAI 等服务通常需要配置代理（全局设置 → 网络代理）。`, 'network', true, undefined, undefined, raw)
  return new LlmError(e?.message || String(err), 'unknown', false, undefined, undefined, raw)
}

/**
 * 尽力修复模型输出的不完整 / 不规范 JSON（代码块包裹、尾随逗号、被截断的字符串和括号）。
 * 返回解析结果；无法修复时返回 null。
 */
export function repairJson(input: string): Record<string, any> | null {
  const tryParse = (s: string): any => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  let s = (input || '').trim()
  if (!s) return {}
  let v = tryParse(s)
  if (v !== undefined) return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  s = s.slice(start)
  // 有些模型会把两个 JSON 对象连在一起（{...}{...}），只取第一个完整对象
  let depth = 0
  let inStr = false
  let esc = false
  const stack: string[] = []
  let end = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']')
      depth++
    } else if (c === '}' || c === ']') {
      stack.pop()
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end >= 0) {
    v = tryParse(s.slice(0, end + 1).replace(/,\s*([}\]])/g, '$1'))
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
    return null
  }
  // 被截断：补全字符串与括号
  let t = s
  if (inStr) t += esc ? '\\"' : '"'
  t = t.replace(/,\s*$/, '').replace(/:\s*$/, ': null')
  t += stack.reverse().join('')
  t = t.replace(/,\s*([}\]])/g, '$1')
  v = tryParse(t)
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}
