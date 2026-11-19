/**
 * v0.7 规划 / grounding 双模型：主模型（如 DeepSeek）负责规划，坐标定位交给专门的 GUI grounding 模型。
 *
 * 坐标格式均按上游源码核实（2026-10）：
 *  - UI-TARS-1.5（基于 Qwen2.5-VL）：输出「绝对坐标」，坐标系为 smart_resize 后的图像尺寸
 *    （factor=28, min_pixels=100*28*28, max_pixels=16384*28*28），见 bytedance/UI-TARS
 *    README_coordinates.md 与 codes/ui_tars/action_parser.py（model_type="qwen25vl"）。
 *    动作格式：click(start_box='(x,y)')、click(start_box='<|box_start|>(x,y)<|box_end|>')、
 *    click(point='<point>x y</point>')（prompt.py 中的新模板），4 个数为框 → 取中心。
 *  - UI-TARS（初版，基于 Qwen2-VL）：相对坐标，除以 factor=1000（action_parser.py 中非 qwen25vl 分支）。
 *  - Fara-7B（基于 Qwen2.5-VL）：<tool_call>{"name":"computer_use","arguments":{"action":"left_click","coordinate":[x,y]}}</tool_call>，
 *    坐标为 smart_resize 后的尺寸（patch 14 × merge 2 = 28, min_pixels=3136, max_pixels=12845056），
 *    见 microsoft/fara src/fara/fara_7b/fara_agent.py（MLM_PROCESSOR_IM_CFG / convert_resized_coords_to_original）。
 *  - 主模型 / 通用视觉模型：要求直接输出截图像素坐标 JSON {"x":..,"y":..}。
 */

export type CoordSpace = 'smart_resize' | 'relative1000' | 'pixel'
export type GroundingPresetId = 'main' | 'uitars15-vllm' | 'uitars15-openrouter' | 'uitars-v1' | 'fara7b' | 'custom'

export interface GroundingPreset {
  id: GroundingPresetId
  name: string
  description: string
  baseUrl: string
  model: string
  coordSpace: CoordSpace
  /** smart_resize 参数 */
  minPixels?: number
  maxPixels?: number
  promptStyle: 'uitars' | 'fara' | 'json'
  keyUrl?: string
  noKey?: boolean
}

export const UITARS_MIN_PIXELS = 100 * 28 * 28
export const UITARS_MAX_PIXELS = 16384 * 28 * 28
export const FARA_MIN_PIXELS = 3136
export const FARA_MAX_PIXELS = 12845056

export const GROUNDING_PRESETS: GroundingPreset[] = [
  {
    id: 'main',
    name: '使用主模型',
    description: '不单独部署 grounding 模型，让主模型（需支持图片）直接给出坐标；主模型不能看图时自动改用编号列表匹配。',
    baseUrl: '',
    model: '',
    coordSpace: 'pixel',
    promptStyle: 'json'
  },
  {
    id: 'uitars15-vllm',
    name: 'UI-TARS-1.5-7B（本地 vLLM）',
    description: '字节开源 GUI 模型，ScreenSpot-V2 94.2%。vLLM：vllm serve ByteDance-Seed/UI-TARS-1.5-7B（OpenAI 兼容 /v1）。',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'ByteDance-Seed/UI-TARS-1.5-7B',
    coordSpace: 'smart_resize',
    minPixels: UITARS_MIN_PIXELS,
    maxPixels: UITARS_MAX_PIXELS,
    promptStyle: 'uitars',
    noKey: true
  },
  {
    id: 'uitars15-openrouter',
    name: 'UI-TARS-1.5-7B（OpenRouter）',
    description: '云端托管，无需显卡。需要 OpenRouter API Key。',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'bytedance/ui-tars-1.5-7b',
    coordSpace: 'smart_resize',
    minPixels: UITARS_MIN_PIXELS,
    maxPixels: UITARS_MAX_PIXELS,
    promptStyle: 'uitars',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'uitars-v1',
    name: 'UI-TARS 初版（7B/72B，相对坐标）',
    description: '基于 Qwen2-VL 的初版 UI-TARS（如 bytedance-research/UI-TARS-7B-DPO），输出 0–1000 相对坐标。',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'bytedance-research/UI-TARS-7B-DPO',
    coordSpace: 'relative1000',
    promptStyle: 'uitars',
    noKey: true
  },
  {
    id: 'fara7b',
    name: 'Fara-7B（微软，本地 vLLM）',
    description: '微软开源电脑操作模型（Qwen2.5-VL 7B）。vLLM：vllm serve microsoft/Fara-7B。',
    baseUrl: 'http://127.0.0.1:5000/v1',
    model: 'microsoft/Fara-7B',
    coordSpace: 'smart_resize',
    minPixels: FARA_MIN_PIXELS,
    maxPixels: FARA_MAX_PIXELS,
    promptStyle: 'fara',
    noKey: true
  },
  {
    id: 'custom',
    name: '自定义',
    description: '任意 OpenAI 兼容视觉模型，自行选择坐标格式。',
    baseUrl: '',
    model: '',
    coordSpace: 'pixel',
    promptStyle: 'json'
  }
]

export function groundingPreset(id: string | undefined): GroundingPreset {
  return GROUNDING_PRESETS.find((p) => p.id === id) || GROUNDING_PRESETS[0]
}

/* ------------------------- smart_resize（与上游 Python 逐行一致） ------------------------- */

const roundBy = (n: number, f: number): number => Math.round(n / f) * f
const ceilBy = (n: number, f: number): number => Math.ceil(n / f) * f
const floorBy = (n: number, f: number): number => Math.floor(n / f) * f

/** Python round() 是银行家舍入；Qwen 的 smart_resize 用的就是 Python round，这里保持一致 */
function pyRound(x: number): number {
  const r = Math.round(x)
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2)
  return r
}

export function smartResize(height: number, width: number, factor = 28, minPixels = UITARS_MIN_PIXELS, maxPixels = UITARS_MAX_PIXELS): { height: number; width: number } {
  if (Math.max(height, width) / Math.min(height, width) > 200) throw new Error('图像宽高比过大（>200），grounding 模型不支持')
  let hBar = Math.max(factor, pyRound(height / factor) * factor)
  let wBar = Math.max(factor, pyRound(width / factor) * factor)
  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels)
    hBar = floorBy(height / beta, factor)
    wBar = floorBy(width / beta, factor)
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width))
    hBar = ceilBy(height * beta, factor)
    wBar = ceilBy(width * beta, factor)
  }
  void roundBy
  return { height: hBar, width: wBar }
}

/* ------------------------- 输出解析 ------------------------- */

export interface GroundingParse {
  /** 模型原始坐标（未换算） */
  x: number
  y: number
  /** 若模型给的是框 */
  box?: [number, number, number, number]
  action?: string
  thought?: string
  format: 'start_box' | 'point_tag' | 'box_token' | 'tool_call' | 'json' | 'plain'
}

const num = (s: string): number => Number(String(s).trim())

/** 解析 grounding 模型输出；无法解析返回 null */
export function parseGroundingOutput(text: string): GroundingParse | null {
  const t = String(text || '').trim()
  if (!t) return null
  const thought = t.match(/Thought:\s*([\s\S]+?)(?=\s*Action:|$)/)?.[1]?.trim()
  const action = t.match(/Action:\s*([a-z_]+)\s*\(/i)?.[1] || t.match(/^\s*([a-z_]+)\s*\(/i)?.[1]

  // Fara / Qwen 函数调用：<tool_call>{json}</tool_call>
  const tc = t.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/)
  if (tc) {
    try {
      const j = JSON.parse(tc[1])
      const c = j?.arguments?.coordinate ?? j?.coordinate
      if (Array.isArray(c) && c.length >= 2 && c.every((v: unknown) => Number.isFinite(Number(v)))) return { x: Number(c[0]), y: Number(c[1]), action: j?.arguments?.action, thought, format: 'tool_call' }
    } catch {
      /* 继续尝试其它格式 */
    }
  }
  // <point>x y</point> 或 <point>x1 y1 x2 y2</point>
  const pt = t.match(/<point>\s*([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+)[\s,]+([\d.]+))?\s*<\/point>/)
  if (pt) {
    if (pt[3] !== undefined) {
      const b: [number, number, number, number] = [num(pt[1]), num(pt[2]), num(pt[3]), num(pt[4])]
      return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, box: b, action, thought, format: 'point_tag' }
    }
    return { x: num(pt[1]), y: num(pt[2]), action, thought, format: 'point_tag' }
  }
  // <|box_start|>(x,y)<|box_end|> 或 (x1,y1),(x2,y2)
  const bt = t.match(/<\|box_start\|>\s*\(?\s*([\d.]+)\s*,\s*([\d.]+)\s*\)?(?:\s*,?\s*\(?\s*([\d.]+)\s*,\s*([\d.]+)\s*\)?)?\s*<\|box_end\|>/)
  if (bt) {
    if (bt[3] !== undefined) {
      const b: [number, number, number, number] = [num(bt[1]), num(bt[2]), num(bt[3]), num(bt[4])]
      return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, box: b, action, thought, format: 'box_token' }
    }
    return { x: num(bt[1]), y: num(bt[2]), action, thought, format: 'box_token' }
  }
  // start_box='(x,y)' 或 start_box='(x1,y1,x2,y2)' / '[x1, y1, x2, y2]'
  const sb = t.match(/(?:start_box|point)\s*=\s*['"]?\s*[([]\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*,\s*([\d.]+))?\s*[)\]]/)
  if (sb) {
    if (sb[3] !== undefined) {
      const b: [number, number, number, number] = [num(sb[1]), num(sb[2]), num(sb[3]), num(sb[4])]
      return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, box: b, action, thought, format: 'start_box' }
    }
    return { x: num(sb[1]), y: num(sb[2]), action, thought, format: 'start_box' }
  }
  // JSON {"x":..,"y":..} / {"point":[x,y]} / {"bbox":[...]}
  const js = t.match(/\{[\s\S]*\}/)
  if (js) {
    try {
      const j = JSON.parse(js[0])
      if (Number.isFinite(Number(j.x)) && Number.isFinite(Number(j.y))) return { x: Number(j.x), y: Number(j.y), thought, format: 'json' }
      const p = j.point || j.coordinate || j.click
      if (Array.isArray(p) && p.length >= 2) return { x: Number(p[0]), y: Number(p[1]), thought, format: 'json' }
      const b = j.bbox || j.box
      if (Array.isArray(b) && b.length >= 4) return { x: (Number(b[0]) + Number(b[2])) / 2, y: (Number(b[1]) + Number(b[3])) / 2, box: b.slice(0, 4).map(Number) as any, thought, format: 'json' }
      if (j.found === false || j.x === null) return null
    } catch {
      /* ignore */
    }
  }
  // 兜底：最后一对 (x, y)
  const pl = [...t.matchAll(/\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g)].pop()
  if (pl) return { x: num(pl[1]), y: num(pl[2]), action, thought, format: 'plain' }
  return null
}

/** 把模型坐标换算为「截图像素坐标」 */
export function toImageCoords(
  p: { x: number; y: number },
  space: CoordSpace,
  image: { width: number; height: number },
  opts: { minPixels?: number; maxPixels?: number } = {}
): { x: number; y: number } {
  let x: number
  let y: number
  if (space === 'relative1000') {
    x = (p.x / 1000) * image.width
    y = (p.y / 1000) * image.height
  } else if (space === 'smart_resize') {
    const r = smartResize(image.height, image.width, 28, opts.minPixels ?? UITARS_MIN_PIXELS, opts.maxPixels ?? UITARS_MAX_PIXELS)
    x = (p.x / r.width) * image.width
    y = (p.y / r.height) * image.height
  } else {
    x = p.x
    y = p.y
  }
  return { x: Math.max(0, Math.min(image.width - 1, Math.round(x))), y: Math.max(0, Math.min(image.height - 1, Math.round(y))) }
}

/* ------------------------- 提示词 ------------------------- */

/** UI-TARS 官方 GROUNDING 模板（codes/ui_tars/prompt.py GROUNDING_DOUBAO） */
export function uitarsGroundingPrompt(instruction: string): string {
  return `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task. \n\n## Output Format\n\nAction: ...\n\n\n## Action Space\nclick(point='<point>x1 y1</point>'')\n\n## User Instruction\n${instruction}`
}

export function faraSystemPrompt(displayW: number, displayH: number): string {
  const tool = {
    type: 'function',
    function: {
      name: 'computer_use',
      description: `Use a mouse and keyboard to interact with a computer, and take screenshots.\n* The screen's resolution is ${displayW}x${displayH}.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['left_click', 'mouse_move', 'terminate'] },
          coordinate: { type: 'array', description: '(x, y): pixels from the left / top edge.' }
        },
        required: ['action']
      }
    }
  }
  return `You are a helpful assistant.\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${JSON.stringify(tool)}\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>`
}

export function jsonGroundingPrompt(instruction: string, w: number, h: number): string {
  return `你是界面元素定位器。截图尺寸为 ${w}x${h} 像素（左上角为 0,0）。请找到下列目标元素，只输出一行 JSON：{"x": 像素横坐标, "y": 像素纵坐标}（元素中心点）；找不到时输出 {"found": false}。\n目标：${instruction}`
}

export function buildGroundingMessages(preset: Pick<GroundingPreset, 'promptStyle' | 'minPixels' | 'maxPixels'>, imageDataUrl: string, instruction: string, image: { width: number; height: number }): unknown[] {
  const img = { type: 'image_url', image_url: { url: imageDataUrl } }
  if (preset.promptStyle === 'uitars') {
    return [{ role: 'user', content: [{ type: 'text', text: uitarsGroundingPrompt(instruction) }, img] }]
  }
  if (preset.promptStyle === 'fara') {
    const r = smartResize(image.height, image.width, 28, preset.minPixels ?? FARA_MIN_PIXELS, preset.maxPixels ?? FARA_MAX_PIXELS)
    return [
      { role: 'system', content: faraSystemPrompt(r.width, r.height) },
      { role: 'user', content: [img, { type: 'text', text: `Click on: ${instruction}` }] }
    ]
  }
  return [{ role: 'user', content: [{ type: 'text', text: jsonGroundingPrompt(instruction, image.width, image.height) }, img] }]
}

export interface GroundingConfig {
  preset: GroundingPresetId
  baseUrl: string
  apiKey: string
  model: string
  coordSpace: CoordSpace
  promptStyle: GroundingPreset['promptStyle']
  minPixels?: number
  maxPixels?: number
}

export interface GroundResult {
  x: number
  y: number
  raw: string
  parse: GroundingParse
  usage?: { prompt_tokens?: number; completion_tokens?: number; [k: string]: unknown }
  ms: number
}

/** 非流式调用 grounding 模型，返回截图坐标 */
export async function groundOnce(
  cfg: GroundingConfig,
  imageDataUrl: string,
  image: { width: number; height: number },
  instruction: string,
  o: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<GroundResult> {
  if (!cfg.baseUrl || !cfg.model) throw new Error('grounding 模型未配置（需要 Base URL 和模型名）')
  const f = o.fetchImpl || fetch
  const t0 = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 60000)
  o.signal?.addEventListener('abort', () => ac.abort(), { once: true })
  let res: Response
  try {
    const url = cfg.baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions'
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, messages: buildGroundingMessages(cfg, imageDataUrl, instruction, image), temperature: 0, max_tokens: 256, stream: false }),
      signal: ac.signal
    })
  } catch (e: any) {
    clearTimeout(timer)
    if (ac.signal.aborted && !o.signal?.aborted) throw new Error(`grounding 模型请求超时（${Math.round((o.timeoutMs ?? 60000) / 1000)} 秒）`)
    throw new Error(`无法连接 grounding 模型（${cfg.baseUrl}）：${e?.cause?.code || e?.message || e}`)
  }
  clearTimeout(timer)
  const body = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? 'API Key 无效或无权限' : res.status === 404 ? '模型或地址不存在（检查 Base URL 和模型名）' : res.status === 400 ? '请求被拒绝（模型可能不支持图片输入）' : `HTTP ${res.status}`
    throw new Error(`grounding 模型返回错误：${hint}。${body.slice(0, 200)}`)
  }
  let j: any
  try {
    j = JSON.parse(body)
  } catch {
    throw new Error('grounding 模型返回的不是 JSON：' + body.slice(0, 120))
  }
  const msg = j?.choices?.[0]?.message
  const raw = String(msg?.content ?? '')
  const parse = parseGroundingOutput(raw)
  if (!parse) throw new Error(`grounding 模型没有给出可解析的坐标：「${raw.slice(0, 160)}」`)
  const p = toImageCoords(parse, cfg.coordSpace, image, { minPixels: cfg.minPixels, maxPixels: cfg.maxPixels })
  return { ...p, raw, parse, usage: j?.usage, ms: Date.now() - t0 }
}
