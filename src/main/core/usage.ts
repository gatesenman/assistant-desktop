/**
 * v0.7 Token / 费用统计：
 *  - 解析 OpenAI 兼容 usage（含 DeepSeek prompt_cache_hit_tokens / prompt_cache_miss_tokens、
 *    OpenAI prompt_tokens_details.cached_tokens、completion_tokens_details.reasoning_tokens）；
 *  - 价格表（每百万 token，可在设置里编辑）；DeepSeek 默认价格取自官方定价页
 *    https://api-docs.deepseek.com/quick_start/pricing（2026-10-19 核对），含高峰 / 低谷时段；
 *  - 账本：按消息、任务/智能体、定时任务、每天累计，持久化到 usage.json；
 *  - 预算：单任务 / 每天上限（美元），超出时暂停智能体。
 */
import fs from 'fs'
import path from 'path'
import type { BudgetSettings, PriceEntry, PriceTier, UsageBucket, UsageNumbers, UsageSummary } from '../../shared/types'
export type { BudgetSettings, PriceEntry, PriceTier, UsageBucket, UsageNumbers, UsageSummary }


export interface UsageCost extends UsageNumbers {
  /** 美元 */
  cost: number
  /** 是否找到了价格 */
  priced: boolean
  model: string
}

/** 从 API 的 usage 对象解析（兼容 OpenAI / DeepSeek / Ollama / vLLM） */
export function parseUsage(u: any): UsageNumbers | null {
  if (!u || typeof u !== 'object') return null
  const input = Number(u.prompt_tokens ?? u.input_tokens)
  const output = Number(u.completion_tokens ?? u.output_tokens)
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null
  let cacheHit = Number(u.prompt_cache_hit_tokens)
  if (!Number.isFinite(cacheHit)) cacheHit = Number(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens)
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens)
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cacheHit: Number.isFinite(cacheHit) ? Math.max(0, cacheHit) : 0,
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoning } : {})
  }
}

export function addUsage<T extends UsageNumbers>(a: T, b: UsageNumbers): T {
  return {
    ...a,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheHit: a.cacheHit + b.cacheHit,
    reasoning: (a.reasoning || 0) + (b.reasoning || 0) || undefined,
    estimated: !!(a.estimated || b.estimated)
  }
}

/* ------------------------------ 价格表 ------------------------------ */



/** DeepSeek 官方价格（美元 / 百万 token），2026-10-19 核对 api-docs.deepseek.com/quick_start/pricing */
export const DEFAULT_PRICES: PriceEntry[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash（deepseek-flash）',
    provider: 'deepseek.com',
    models: 'deepseek-flash,deepseek-v4-flash,deepseek-v4-flash-vision-exp',
    currency: 'USD',
    price: { cacheHit: 0.003, input: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, input: 0.3, output: 1.2, utcHours: [[1, 4], [6, 10]], weekdaysOnly: true },
    note: '高峰：UTC 01:00–04:00、06:00–10:00（北京时间 09:00–12:00、14:00–18:00），周一至周五；其余时段及周末为低谷价（半价）。中国法定节假日按低谷计，本应用未内置节假日表。',
    builtin: true
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro（deepseek-v4-pro）',
    provider: 'deepseek.com',
    models: 'deepseek-v4-pro',
    currency: 'USD',
    price: { cacheHit: 0.022, input: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, input: 1.32, output: 3.96, utcHours: [[1, 4], [6, 10]], weekdaysOnly: true },
    note: '同上高峰规则。',
    builtin: true
  }
]

export function modelMatches(pattern: string, model: string): boolean {
  const m = model.trim().toLowerCase()
  return pattern
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => (p.endsWith('*') ? m.startsWith(p.slice(0, -1)) : p === m))
}

export function findPrice(prices: PriceEntry[], baseUrl: string, model: string): PriceEntry | undefined {
  const b = (baseUrl || '').toLowerCase()
  // 指定了服务商的条目优先
  const cands = prices.filter((p) => modelMatches(p.models, model) && (!p.provider || b.includes(p.provider.toLowerCase())))
  return cands.find((p) => p.provider) || cands[0]
}

export function isPeak(entry: PriceEntry, at: Date): boolean {
  if (!entry.peak) return false
  const day = at.getUTCDay()
  if (entry.peak.weekdaysOnly && (day === 0 || day === 6)) return false
  const h = at.getUTCHours() + at.getUTCMinutes() / 60
  return entry.peak.utcHours.some(([a, b]) => h >= a && h < b)
}

/** 计算一次调用的费用（统一换算成美元） */
export function priceUsage(u: UsageNumbers, entry: PriceEntry | undefined, at: Date, cnyPerUsd = 7.1): { cost: number; priced: boolean; peak: boolean } {
  if (!entry) return { cost: 0, priced: false, peak: false }
  const peak = isPeak(entry, at)
  const t = peak && entry.peak ? entry.peak : entry.price
  const hit = Math.min(u.cacheHit, u.input)
  const miss = Math.max(0, u.input - hit)
  let cost = (miss * t.input + hit * (t.cacheHit ?? t.input) + u.output * t.output) / 1e6
  if (entry.currency === 'CNY') cost /= cnyPerUsd || 7.1
  return { cost, priced: true, peak }
}

export { fmtTokens, fmtUsd } from '../../shared/usageFormat'
import { fmtTokens, fmtUsd } from '../../shared/usageFormat'

/* ------------------------------ 账本 ------------------------------ */

export type UsageKind = 'chat' | 'task' | 'routine' | 'grounding' | 'probe'

export interface UsageRecord extends UsageNumbers {
  at: number
  day: string
  model: string
  baseUrl: string
  kind: UsageKind
  assistantId?: string
  taskId?: string
  routineId?: string
  /** 一次运行（对话一轮 / 后台任务）的 key，用于单任务预算 */
  runKey?: string
  cost: number
  priced: boolean
}



export const emptyBucket = (): UsageBucket => ({ input: 0, output: 0, cacheHit: 0, cost: 0, calls: 0, unpricedCalls: 0 })

function addToBucket(b: UsageBucket | undefined, r: UsageRecord): UsageBucket {
  const x = b || emptyBucket()
  x.input += r.input
  x.output += r.output
  x.cacheHit += r.cacheHit
  if (r.reasoning) x.reasoning = (x.reasoning || 0) + r.reasoning
  x.cost += r.cost
  x.calls += 1
  if (!r.priced) x.unpricedCalls += 1
  if (r.estimated) x.estimated = true
  return x
}

/** 本地日期 YYYY-MM-DD（用户所在时区） */
export function localDay(t: number | Date): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}


export const DEFAULT_BUDGET: BudgetSettings = { perTaskUsd: 0, perDayUsd: 0, perTaskTokens: 0 }

export interface BudgetCheck {
  ok: boolean
  reason?: 'task' | 'day' | 'tokens'
  message?: string
}

/** 检查预算：runSpent 为本次运行已花费 */
export function checkBudget(b: BudgetSettings | undefined, runSpent: { cost: number; tokens: number }, todaySpent: number): BudgetCheck {
  if (!b) return { ok: true }
  if (b.perDayUsd > 0 && todaySpent >= b.perDayUsd)
    return { ok: false, reason: 'day', message: `⏸ 已达到今日预算上限：今天已花费 ${fmtUsd(todaySpent)}（上限 ${fmtUsd(b.perDayUsd)}），智能体已暂停。可在「用量」页提高上限后点「继续」。` }
  if (b.perTaskUsd > 0 && runSpent.cost >= b.perTaskUsd)
    return { ok: false, reason: 'task', message: `⏸ 已达到单任务预算上限：本任务已花费 ${fmtUsd(runSpent.cost)}（上限 ${fmtUsd(b.perTaskUsd)}），智能体已暂停。可在「用量」页提高上限后点「继续」。` }
  if (b.perTaskTokens > 0 && runSpent.tokens >= b.perTaskTokens)
    return { ok: false, reason: 'tokens', message: `⏸ 已达到单任务 token 上限：本任务已用 ${fmtTokens(runSpent.tokens)} token（上限 ${fmtTokens(b.perTaskTokens)}），智能体已暂停。可在「用量」页调整后点「继续」。` }
  return { ok: true }
}

export class UsageLedger {
  private file: string
  records: UsageRecord[] = []
  summary: UsageSummary = { days: {}, byModel: {}, byAssistant: {}, byRoutine: {}, byTask: {}, total: emptyBucket() }
  private runs = new Map<string, { cost: number; tokens: number }>()
  private saveTimer: NodeJS.Timeout | null = null
  /** 每条记录写入后回调（推送到界面） */
  onChange?: () => void

  constructor(dir: string | null, private maxRecords = 5000) {
    this.file = dir ? path.join(dir, 'usage.json') : ''
    if (this.file) {
      try {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (Array.isArray(j.records)) this.records = j.records
        if (j.summary?.total) this.summary = { byTask: {}, ...j.summary }
      } catch {
        /* 首次使用 */
      }
    }
  }

  record(r: Omit<UsageRecord, 'day'>): UsageRecord {
    const rec: UsageRecord = { ...r, day: localDay(r.at) }
    this.records.push(rec)
    if (this.records.length > this.maxRecords) this.records = this.records.slice(-this.maxRecords)
    const s = this.summary
    s.days[rec.day] = addToBucket(s.days[rec.day], rec)
    s.byModel[rec.model || '?'] = addToBucket(s.byModel[rec.model || '?'], rec)
    if (rec.assistantId) s.byAssistant[rec.assistantId] = addToBucket(s.byAssistant[rec.assistantId], rec)
    if (rec.routineId) s.byRoutine[rec.routineId] = addToBucket(s.byRoutine[rec.routineId], rec)
    if (rec.taskId) {
      s.byTask[rec.taskId] = addToBucket(s.byTask[rec.taskId], rec)
      const keys = Object.keys(s.byTask)
      if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete s.byTask[k]
    }
    s.total = addToBucket(s.total, rec)
    if (rec.runKey) {
      const run = this.runs.get(rec.runKey) || { cost: 0, tokens: 0 }
      run.cost += rec.cost
      run.tokens += rec.input + rec.output
      this.runs.set(rec.runKey, run)
    }
    this.scheduleSave()
    this.onChange?.()
    return rec
  }

  runSpent(runKey: string): { cost: number; tokens: number } {
    return this.runs.get(runKey) || { cost: 0, tokens: 0 }
  }

  resetRun(runKey: string): void {
    this.runs.delete(runKey)
  }

  today(now = Date.now()): UsageBucket {
    return this.summary.days[localDay(now)] || emptyBucket()
  }

  /** 最近 n 天（含今天），缺失的天补 0 */
  lastDays(n: number, now = Date.now()): { day: string; bucket: UsageBucket }[] {
    const out: { day: string; bucket: UsageBucket }[] = []
    for (let i = n - 1; i >= 0; i--) {
      const d = localDay(now - i * 86400000)
      out.push({ day: d, bucket: this.summary.days[d] || emptyBucket() })
    }
    return out
  }

  clear(): void {
    this.records = []
    this.summary = { days: {}, byModel: {}, byAssistant: {}, byRoutine: {}, byTask: {}, total: emptyBucket() }
    this.runs.clear()
    this.flush()
    this.onChange?.()
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 500)
    this.saveTimer.unref?.()
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.file) return
    try {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: this.records, summary: this.summary }), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[usage] 保存失败', e)
    }
  }

  /** 诊断导出用的摘要 */
  diagnostics(now = Date.now()): Record<string, unknown> {
    const today = this.today(now)
    return {
      today: { ...today, cost: Number(today.cost.toFixed(6)) },
      last7d: this.lastDays(7, now).map((d) => ({ day: d.day, calls: d.bucket.calls, input: d.bucket.input, output: d.bucket.output, cacheHit: d.bucket.cacheHit, cost: Number(d.bucket.cost.toFixed(6)) })),
      total: { ...this.summary.total, cost: Number(this.summary.total.cost.toFixed(6)) },
      byModel: Object.fromEntries(Object.entries(this.summary.byModel).map(([k, v]) => [k, { calls: v.calls, input: v.input, output: v.output, cost: Number(v.cost.toFixed(6)), unpricedCalls: v.unpricedCalls }])),
      records: this.records.length
    }
  }
}
