import type { ModelCapabilities } from '../../shared/types'
import { streamChat } from './llm'
import { classifyNetwork, LlmError } from './errors'

/** 32×32 纯红色 PNG，用于检测模型是否能看图 */
export const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg=='

export const capKey = (baseUrl: string, model: string): string => `${baseUrl.replace(/\/+$/, '')}|${model}`

export { PROVIDER_PRESETS } from '../../shared/providers'

export interface ProbeOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  proxyLabel?: string
  timeoutMs?: number
  /** 只做基础连通性测试 */
  basicOnly?: boolean
}

const PING_TOOL = {
  type: 'function' as const,
  function: {
    name: 'capability_ping',
    description: '能力检测用的工具。收到指令时必须调用它。',
    parameters: { type: 'object', properties: { word: { type: 'string', description: '固定填写 pong' } }, required: ['word'] }
  }
}

const sig = (ms: number): AbortSignal => AbortSignal.timeout(ms)

/**
 * 连接测试 + 能力检测：
 * 1. 基础对话（失败则直接抛出分类后的 LlmError）
 * 2. 工具调用：提供一个工具并要求调用
 * 3. 图片输入：发送纯红色图片询问颜色
 */
export async function probeModel(o: ProbeOptions): Promise<ModelCapabilities> {
  const timeout = o.timeoutMs ?? 30000
  const base = { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model, fetchImpl: o.fetchImpl, proxyLabel: o.proxyLabel }
  const caps: ModelCapabilities = { model: o.model, baseUrl: o.baseUrl, chat: false, tools: 'unknown', vision: 'unknown', notes: [], checkedAt: Date.now() }
  const t0 = Date.now()
  try {
    await streamChat({ ...base, messages: [{ role: 'user', content: '这是一次连接测试，请只回复：OK' }], signal: sig(timeout) })
  } catch (e) {
    throw e instanceof LlmError ? e : classifyNetwork(e, { baseUrl: o.baseUrl, proxy: o.proxyLabel })
  }
  caps.chat = true
  caps.latencyMs = Date.now() - t0
  if (o.basicOnly) return caps

  try {
    const r = await streamChat({
      ...base,
      messages: [{ role: 'user', content: 'CAPABILITY_PROBE_TOOLS 请立即调用 capability_ping 工具，参数 word 填 pong。不要输出其它内容。' }],
      tools: [PING_TOOL],
      signal: sig(timeout)
    })
    if (r.toolCalls.some((t) => t.name === 'capability_ping')) caps.tools = 'yes'
    else {
      caps.tools = 'unknown'
      caps.notes.push('工具调用：模型没有按要求调用工具，可能不擅长 function calling')
    }
  } catch (e) {
    const err = e instanceof LlmError ? e : classifyNetwork(e, { baseUrl: o.baseUrl })
    if (['no_tools', 'bad_request'].includes(err.kind)) {
      caps.tools = 'no'
      caps.notes.push('工具调用：' + err.message)
    } else caps.notes.push('工具调用检测失败：' + err.message)
  }

  try {
    const r = await streamChat({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'CAPABILITY_PROBE_VISION 这张图片是什么颜色？只回答颜色名称。' },
            { type: 'image_url', image_url: { url: RED_PNG } }
          ]
        }
      ],
      signal: sig(timeout)
    })
    if (/红|red/i.test(r.content)) caps.vision = 'yes'
    else {
      caps.vision = 'no'
      caps.notes.push(`图片输入：模型没有识别出图片内容（回答：${r.content.slice(0, 40) || '空'}）`)
    }
  } catch (e) {
    const err = e instanceof LlmError ? e : classifyNetwork(e, { baseUrl: o.baseUrl })
    if (['no_vision', 'bad_request'].includes(err.kind)) {
      caps.vision = 'no'
      caps.notes.push('图片输入：' + err.message)
    } else caps.notes.push('图片输入检测失败：' + err.message)
  }
  caps.checkedAt = Date.now()
  return caps
}

export function describeCapabilities(c: ModelCapabilities): string {
  const s = (v: string): string => (v === 'yes' ? '支持' : v === 'no' ? '不支持' : '未确定')
  return `连接成功（${c.latencyMs ?? '?'} ms）· 工具调用：${s(c.tools)} · 图片输入：${s(c.vision)}`
}

export type ScreenMode = 'auto' | 'image' | 'text'

/**
 * 电脑控制前决定屏幕感知方式：
 * - 视觉模型 → 发送截图（image）
 * - 不能看图的模型（如 DeepSeek）→ OCR 文字描述（text），需要 OCR 引擎
 * 返回 mode=null 表示无法进行电脑控制，reason 为中文原因。
 */
export function decideComputerMode(
  c: ModelCapabilities | undefined,
  s: { vision: boolean; mode?: ScreenMode },
  ocrAvailable: boolean
): { mode: 'image' | 'text' | null; reason?: string } {
  const model = c?.model || '当前模型'
  if (c?.tools === 'no') return { mode: null, reason: `当前模型「${model}」不支持工具调用，无法进行电脑控制。` }
  const noOcr = '没有可用的 OCR 引擎，纯文本模式无法读取屏幕。Linux 可安装：sudo apt install tesseract-ocr tesseract-ocr-chi-sim；Windows/macOS 安装包已内置 OCR，请重新安装。'
  const canSee = s.vision && c?.vision !== 'no'
  const mode = s.mode || 'auto'
  if (mode === 'text' || (mode === 'auto' && !canSee)) return ocrAvailable ? { mode: 'text' } : { mode: null, reason: (canSee ? '' : `当前模型「${model}」不能看图；`) + noOcr }
  if (!s.vision) return { mode: null, reason: '已在设置中关闭「发送图片给模型」，模型将看不到屏幕截图。请开启，或把「屏幕感知方式」改为「文字描述（OCR）」。' }
  if (c?.vision === 'no')
    return { mode: null, reason: `当前模型「${model}」不支持图片输入，看不到屏幕截图。请把「屏幕感知方式」设为「自动」或「文字描述（OCR）」，或换用视觉模型。` }
  return { mode: 'image' }
}

/** 兼容旧接口：返回阻止原因或 null（不考虑 OCR） */
export function computerUseBlocker(c: ModelCapabilities | undefined, visionSetting: boolean): string | null {
  const r = decideComputerMode(c, { vision: visionSetting, mode: 'image' }, false)
  return r.mode ? null : r.reason!
}
