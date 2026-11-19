import os from 'os'
import type { AppEvent, Assistant, ChatMessage, TaskInfo, ToolCallRecord } from '../../shared/types'
import type { Store } from './store'
import { streamChatWithRetry, toApiMessages } from './llm'
import { classifyNetwork, LlmError, repairJson } from './errors'
import { selectContextByBudget } from './tokens'
import { DefaultToolHost, type ToolHost } from './toolhost'
import { truncate, uid } from './util'
import { ScreenLock } from './screenlock'
import { estimateTokens, IMAGE_TOKENS } from './tokens'
import { sumUsage, type UsageTracker } from './usageTracker'
import type { MessageUsage } from '../../shared/types'
import { heuristicPlan, shouldReflect, REFLECT_PROMPT } from './plan'
import type { ExperienceStore } from './experience'

export interface AgentDeps {
  store: Store
  emit: (ev: AppEvent) => void
  tools?: ToolHost
  fetchImpl?: typeof fetch
  /** 审批等待超时（毫秒），默认 30 分钟 */
  approvalTimeoutMs?: number
  /** 电脑控制会话开始/结束（用于显示遮罩、全局急停快捷键等） */
  onComputerSession?: (active: boolean) => void
  /** 屏幕锁（多个智能体共享一块屏幕） */
  screenLock?: ScreenLock
  /** 当前代理描述（用于错误提示） */
  proxyLabel?: () => string | undefined
  /** 电脑控制前的能力检查：返回阻止原因或 null */
  computerPreflight?: (model: string) => Promise<string | null>
  /** 该模型是否可以接收图片（默认取 settings.vision） */
  visionFor?: (model: string) => boolean
  skillsSummary?: () => string
  /** v0.6：当前电脑控制目标说明（本机 / 某个虚拟电脑） */
  computerTargetSummary?: () => string
  /** 重试基础间隔（测试用） */
  retryBaseDelayMs?: number
  /** v0.7：用量统计与预算 */
  usage?: UsageTracker
  /** v0.8：经验库 */
  experience?: ExperienceStore
  /** v0.8：电脑操控后截一张图（交还时注入） */
  captureComputerThumb?: () => Promise<string | null>
  /** v0.8：通知 UI 接管状态 */
  onTakeover?: (assistantId: string, active: boolean, reason?: string) => void
}

export interface RunOptions {
  text: string
  images?: string[]
  source?: 'routine' | 'task'
  routineName?: string
  routineId?: string
  taskId?: string
  /** 自动批准本轮中的所有工具（无人值守定时任务） */
  autoApproveAll?: boolean
  /** 重试：不追加新的用户消息，移除末尾出错的回复后重新请求 */
  retry?: boolean
}

export interface RunResult {
  text: string
  error?: string
  /** v0.7：本次运行的总用量 */
  usage?: MessageUsage
  /** v0.7：因预算暂停 */
  budgetPaused?: boolean
}

/** 服务商没有返回 usage 时的本地估算 */
function estimateUsage(apiMessages: unknown[], out: string): { input: number; output: number; cacheHit: number; estimated: true } {
  let input = 0
  for (const m of apiMessages as any[]) {
    const c = m?.content
    if (typeof c === 'string') input += estimateTokens(c)
    else if (Array.isArray(c)) for (const part of c) input += part?.type === 'image_url' ? IMAGE_TOKENS : estimateTokens(String(part?.text || ''))
    if (m?.tool_calls) input += estimateTokens(JSON.stringify(m.tool_calls))
    input += 4
  }
  return { input, output: estimateTokens(out), cacheHit: 0, estimated: true }
}

export function buildSystemPrompt(a: Assistant, workDir: string, opts: { task?: boolean; canSpawn?: boolean; computer?: boolean; agents?: Assistant[]; delegatedBy?: string; skillsSummary?: string; computerTarget?: string; experienceBlock?: string } = {}): string {
  const lines = [
    `你是名为「${a.name}」的个人 AI 助手，运行在用户的桌面电脑上。`,
    a.systemPrompt ? `\n${a.systemPrompt}` : '',
    '',
    `当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `操作系统：${os.type()} ${os.release()} (${process.platform})`,
    `默认工作目录：${workDir}`,
    '',
    '你可以调用工具来执行命令、读写文件、浏览目录、抓取网页、操作浏览器以及使用已连接的 MCP 工具。高风险操作可能需要用户审批，被拒绝时请尊重用户的决定，不要换方式重试。',
    '当用户告诉你值得长期记住的信息（偏好、身份、项目背景等）时，使用 save_memory 工具保存。'
  ]
  if (opts.task) {
    lines.push(
      '',
      '## 后台子任务模式',
      '你正在作为一个后台子任务独立执行，用户不会实时看到你的过程。请自主完成任务，最后输出一段完整、简洁的最终结果（这段结果会交给主助手汇报给用户）。'
    )
  } else if (opts.canSpawn) {
    lines.push('对于耗时较长、可独立完成的工作，可以使用 spawn_task 在后台执行，同时继续与用户对话。')
  }
  if (opts.agents?.length) {
    lines.push('', '## 多智能体协作', '你可以作为协调者，用 delegate_to_agent 把可以并行的大任务拆分给下列助手同时执行，完成后整合结果回复用户：')
    for (const o of opts.agents) lines.push(`- ${o.name}${o.systemPrompt ? `：${o.systemPrompt.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`)
  }
  if (opts.delegatedBy) lines.push('', `这个子任务由协调者「${opts.delegatedBy}」委派给你，与其它助手并行执行；请专注完成自己的部分。`)
  if (opts.skillsSummary) lines.push('', opts.skillsSummary)
  if (opts.experienceBlock) lines.push('', opts.experienceBlock)
  if (opts.computer) {
    lines.push(
      '',
      '## 电脑控制',
      '你可以直接操作这台电脑：先用 computer_screenshot 查看屏幕，再用 mouse_click / type_text / key_press / scroll 等工具操作，每次操作后会自动返回新的截图。',
      '坐标一律以最近一次截图的像素坐标为准（左上角为 0,0）。每步只做一个动作，根据新截图确认效果后再继续；完成后用简短文字说明结果。',
      '屏幕顶部中间的「小助手正在控制电脑」悬浮条属于本应用，不要点击它。遇到密码、支付、删除等敏感操作时先用 ask_user 确认，或提示用户点击「我来接管」。',
      '浏览器任务优先使用 browser_state + browser_click_index / browser_type_index；碰到验证码 / 2FA 时停止并请用户接管。'
    )
    if (opts.computerTarget) lines.push(opts.computerTarget)
  }
  if (a.memory.length) {
    lines.push('', '## 长期记忆（关于用户的已知信息）')
    for (const m of a.memory) lines.push(`- ${m.text}`)
  }
  return lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n')
}

interface LoopParams {
  assistantId: string
  messages: ChatMessage[]
  system: () => string
  model: string
  signal: AbortSignal
  controller: AbortController
  isTask: boolean
  taskId?: string
  meta: Pick<ChatMessage, 'source' | 'routineName' | 'taskId'>
  routineId?: string
  /** 预算统计的运行 key */
  runKey: string
  onUsage?: (u: MessageUsage) => void
  autoApproveAll?: boolean
  key: string
  onUpsert: (m: ChatMessage) => void
  onDelta: (m: ChatMessage, d: string) => void
  save: () => void
}

export class Agent {
  private running = new Map<string, AbortController>()
  private taskControllers = new Map<string, AbortController>()
  private approvals = new Map<string, (ok: boolean) => void>()
  private queues = new Map<string, Promise<unknown>>()
  private computerRuns = new Map<string, AbortController>()
  private computerWaiting = new Map<string, AbortController>()
  readonly screen: ScreenLock
  private stopReasons = new Map<string, string>()
  /** v0.8：运行中用户新消息 */
  private guidance = new Map<string, string[]>()
  /** v0.8：ask_user 等待 */
  private askWaiters = new Map<string, (answer: string | null) => void>()
  /** v0.8：计划确认等待 messageId -> resolve */
  private planWaiters = new Map<string, (action: 'confirm' | 'reject' | 'edit', text?: string) => void>()
  /** v0.8：接管中的 assistant/task key */
  private takeoverKeys = new Set<string>()
  private takeoverReasons = new Map<string, string>()
  /** 暂停循环的 Promise 门闩 */
  private pauseGates = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  readonly tools: ToolHost

  constructor(private deps: AgentDeps) {
    this.tools = deps.tools || new DefaultToolHost({ store: deps.store, fetchImpl: deps.fetchImpl })
    this.screen = deps.screenLock || new ScreenLock()
  }

  /** 运行中插入用户引导；若未在跑则返回 false */
  enqueueGuidance(assistantId: string, text: string): boolean {
    if (!this.running.has(assistantId)) return false
    const q = this.guidance.get(assistantId) || []
    q.push(text)
    this.guidance.set(assistantId, q)
    return true
  }

  isTakeover(assistantId: string): boolean {
    return this.takeoverKeys.has(assistantId) || [...this.takeoverKeys].some((k) => k.startsWith(`task:`) && k.includes(assistantId))
  }

  /** 用户接管：释放屏幕锁并暂停智能体循环 */
  async takeover(assistantId: string, reason = '用户接管'): Promise<void> {
    const keys = [assistantId, ...[...this.computerRuns.keys()].filter((k) => k === assistantId || k.startsWith('task:'))]
    for (const key of new Set(keys)) {
      if (!this.running.has(assistantId) && !key.startsWith('task:')) continue
      this.takeoverKeys.add(key === assistantId ? assistantId : key)
      this.takeoverReasons.set(key === assistantId ? assistantId : key, reason)
      this.screen.release(key)
      // 为 key 建立暂停门闩（循环会 await）
      if (!this.pauseGates.has(key === assistantId ? assistantId : key)) {
        let resolve!: () => void
        const promise = new Promise<void>((r) => (resolve = r))
        this.pauseGates.set(key === assistantId ? assistantId : key, { promise, resolve })
      }
    }
    // 也按 assistantId 建门闩，主循环用 assistantId / task key
    if (!this.pauseGates.has(assistantId)) {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      this.pauseGates.set(assistantId, { promise, resolve })
    }
    this.takeoverKeys.add(assistantId)
    this.takeoverReasons.set(assistantId, reason)
    this.deps.onTakeover?.(assistantId, true, reason)
    this.deps.store.runtime.takeover = { assistantId, reason, since: Date.now() }
    this.deps.emit({ type: 'takeover', assistantId, active: true, reason })
    this.deps.emit({ type: 'runtime', runtime: { ...this.deps.store.runtime } })
  }

  /** 交还：解除暂停，截图并注入「用户刚才做了…」 */
  async handback(assistantId: string, note?: string): Promise<void> {
    const reason = this.takeoverReasons.get(assistantId) || '用户接管'
    this.takeoverKeys.delete(assistantId)
    this.takeoverReasons.delete(assistantId)
    for (const k of [...this.takeoverKeys]) {
      if (k === assistantId || k.startsWith('task:')) {
        this.takeoverKeys.delete(k)
        this.takeoverReasons.delete(k)
      }
    }
    const gate = this.pauseGates.get(assistantId)
    if (gate) {
      this.pauseGates.delete(assistantId)
      gate.resolve()
    }
    for (const [k, g] of [...this.pauseGates]) {
      if (k.startsWith('task:')) {
        this.pauseGates.delete(k)
        g.resolve()
      }
    }
    let thumb: string | null = null
    try {
      thumb = (await this.deps.captureComputerThumb?.()) || null
    } catch {
      /* ignore */
    }
    const text = `（系统）用户已交还控制权。此前接管原因：${reason}。用户刚才做了：${note?.trim() || '（未说明，请根据最新截图继续）'}。请根据最新屏幕状态继续任务。`
    this.enqueueGuidance(assistantId, text)
    // 若不在跑，也把消息写入对话
    if (!this.running.has(assistantId)) {
      const msgs = this.deps.store.getMessages(assistantId)
      const m: ChatMessage = { id: uid(), role: 'user', content: text, images: thumb ? [thumb] : undefined, createdAt: Date.now() }
      msgs.push(m)
      this.deps.emit({ type: 'message-upsert', assistantId, message: m })
      this.deps.store.saveMessages(assistantId)
    } else if (thumb) {
      // 带图的引导：作为下一条 user 消息内容附加说明（图片在 flush 时处理困难，直接 upsert）
      const msgs = this.deps.store.getMessages(assistantId)
      const m: ChatMessage = { id: uid(), role: 'user', content: text, images: [thumb], createdAt: Date.now() }
      msgs.push(m)
      this.deps.emit({ type: 'message-upsert', assistantId, message: m })
    }
    this.deps.store.runtime.takeover = null
    this.deps.onTakeover?.(assistantId, false)
    this.deps.emit({ type: 'takeover', assistantId, active: false })
    this.deps.emit({ type: 'runtime', runtime: { ...this.deps.store.runtime } })
  }

  respondAskUser(callId: string, answer: string | null): void {
    const w = this.askWaiters.get(callId)
    if (w) {
      this.askWaiters.delete(callId)
      w(answer)
    }
  }

  confirmPlan(messageId: string, action: 'confirm' | 'reject' | 'edit', text?: string): void {
    const w = this.planWaiters.get(messageId)
    if (w) {
      this.planWaiters.delete(messageId)
      w(action, text)
    }
  }

  waitAsk(callId: string, signal: AbortSignal): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.respondAskUser(callId, null), this.deps.approvalTimeoutMs ?? 30 * 60 * 1000)
      const onAbort = (): void => this.respondAskUser(callId, null)
      signal.addEventListener('abort', onAbort)
      this.askWaiters.set(callId, (ans) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        resolve(ans)
      })
    })
  }

  waitPlan(messageId: string, signal: AbortSignal): Promise<{ action: 'confirm' | 'reject' | 'edit'; text?: string }> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.confirmPlan(messageId, 'reject'), this.deps.approvalTimeoutMs ?? 30 * 60 * 1000)
      const onAbort = (): void => this.confirmPlan(messageId, 'reject')
      signal.addEventListener('abort', onAbort)
      this.planWaiters.set(messageId, (action, text) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        resolve({ action, text })
      })
    })
  }

  private async awaitIfTakeover(key: string, assistantId: string, signal: AbortSignal): Promise<void> {
    const gateKey = this.pauseGates.has(key) ? key : this.pauseGates.has(assistantId) ? assistantId : null
    if (!gateKey) return
    const gate = this.pauseGates.get(gateKey)
    if (!gate) return
    await Promise.race([
      gate.promise,
      new Promise<void>((_, rej) => {
        if (signal.aborted) return rej(new Error('aborted'))
        signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      })
    ]).catch(() => {})
  }

  private flushGuidance(assistantId: string, messages: ChatMessage[], onUpsert: (m: ChatMessage) => void): void {
    const q = this.guidance.get(assistantId)
    if (!q?.length) return
    this.guidance.set(assistantId, [])
    for (const text of q) {
      const m: ChatMessage = { id: uid(), role: 'user', content: text, createdAt: Date.now() }
      messages.push(m)
      onUpsert(m)
    }
  }

  isRunning(assistantId: string): boolean {
    return this.running.has(assistantId)
  }

  stop(assistantId: string): void {
    this.running.get(assistantId)?.abort()
  }

  stopTask(taskId: string): void {
    this.taskControllers.get(taskId)?.abort()
  }

  get computerActive(): boolean {
    return this.computerRuns.size > 0
  }

  /** 紧急停止所有正在控制电脑的对话/任务 */
  emergencyStop(reason = '已紧急停止电脑控制'): number {
    let n = 0
    for (const [key, ac] of [...this.computerRuns, ...this.computerWaiting]) {
      this.stopReasons.set(key, reason)
      ac.abort()
      n++
    }
    return n
  }

  private computerBegin(key: string, ac: AbortController): void {
    if (this.computerRuns.has(key)) return
    this.computerRuns.set(key, ac)
    if (this.computerRuns.size === 1) this.deps.onComputerSession?.(true)
  }

  private computerEnd(key: string): void {
    this.screen.release(key)
    if (!this.computerRuns.delete(key)) return
    if (this.computerRuns.size === 0) this.deps.onComputerSession?.(false)
  }

  respondApproval(callId: string, approved: boolean): void {
    const r = this.approvals.get(callId)
    if (r) {
      this.approvals.delete(callId)
      r(approved)
    }
  }

  pendingApprovals(): string[] {
    return [...this.approvals.keys()]
  }

  private waitApproval(callId: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.respondApproval(callId, false), this.deps.approvalTimeoutMs ?? 30 * 60 * 1000)
      const onAbort = (): void => this.respondApproval(callId, false)
      signal.addEventListener('abort', onAbort)
      this.approvals.set(callId, (ok) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        resolve(ok)
      })
    })
  }

  async waitIdle(assistantId: string, maxMs = 30 * 60 * 1000): Promise<void> {
    const start = Date.now()
    while (this.running.has(assistantId) && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  /** 排队执行（定时任务、后台任务回传等），等待当前回复结束后再运行 */
  runQueued(assistantId: string, opts: RunOptions): Promise<RunResult> {
    const prev = this.queues.get(assistantId) || Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.waitIdle(assistantId)
        return this.run(assistantId, opts)
      })
    this.queues.set(assistantId, next)
    void next.finally(() => {
      if (this.queues.get(assistantId) === next) this.queues.delete(assistantId)
    })
    return next
  }

  /** 核心循环：调用模型 →（审批）执行工具 → 再调用模型，直到没有工具调用 */
  private async loop(p: LoopParams): Promise<RunResult> {
    const { store } = this.deps
    const settings = store.settings
    const baseSteps = Math.max(1, settings.maxToolSteps || 12)
    let usedComputer = false
    const limit = (): number => (usedComputer ? Math.max(baseSteps, settings.computerMaxSteps || 40) : baseSteps)
    let finalText = ''
    let error: string | undefined
    let computerBlock: string | null | undefined
    let runUsage: MessageUsage | undefined
    let budgetPaused = false
    const tracker = this.deps.usage
    const push = (m: ChatMessage): void => {
      p.messages.push(m)
      p.onUpsert(m)
    }
    let planned = false
    let computerSteps = 0
    try {
    const runId = p.runKey
    try {
      ;(this.tools as any).currentRunId = runId
    } catch {
      /* ignore */
    }
    for (let step = 0; step <= limit(); step++) {
      await this.awaitIfTakeover(p.key, p.assistantId, p.signal)
      if (p.signal.aborted) break
      this.flushGuidance(p.assistantId, p.messages, p.onUpsert)
      const asst: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: Date.now(), streaming: true, ...p.meta }
      let budget = settings.contextTokens || 24000
      push(asst)
      if (!settings.apiKey && /api\.(openai|x)\.(com|ai)|deepseek\.com/.test(settings.baseUrl)) {
        asst.streaming = false
        asst.error = '尚未配置 API Key，请在「全局设置」中填写。'
        error = asst.error
        p.onUpsert(asst)
        break
      }
      // v0.7：预算检查（每次调用模型前）
      const bc = tracker?.check(p.runKey)
      if (bc && !bc.ok) {
        asst.streaming = false
        asst.stopped = true
        asst.stopReason = bc.message
        asst.errorKind = 'budget'
        budgetPaused = true
        tracker!.paused.set(p.assistantId, { message: bc.message || '', at: Date.now() })
        error = bc.message
        p.onUpsert(asst)
        break
      }
      const tools = step < limit() ? this.tools.defs({ isTask: p.isTask }) : undefined
      let result
      let sentMessages: unknown[] = []
      for (let attempt = 0; ; attempt++) {
        const context = selectContextByBudget(
          p.messages.filter((m) => m !== asst),
          budget
        )
        const apiMessages = toApiMessages(p.system(), context, { vision: this.deps.visionFor ? this.deps.visionFor(p.model) : settings.vision })
        sentMessages = apiMessages
        try {
          result = await streamChatWithRetry(
            {
              baseUrl: settings.baseUrl,
              apiKey: settings.apiKey,
              model: p.model,
              temperature: settings.temperature,
              messages: apiMessages,
              tools,
              signal: p.signal,
              fetchImpl: this.deps.fetchImpl,
              proxyLabel: this.deps.proxyLabel?.(),
              onDelta: (d) => {
                if (asst.notice) {
                  asst.notice = undefined
                  p.onUpsert(asst)
                }
                asst.content += d
                p.onDelta(asst, d)
              },
              onReasoning: () => {
                if (!asst.notice && !asst.content) {
                  asst.notice = '正在深度思考…'
                  p.onUpsert(asst)
                }
              }
            },
            {
              baseDelayMs: this.deps.retryBaseDelayMs,
              onRetry: (e, n, ms) => {
                asst.notice = `${e.message.split('（')[0]}，${Math.round(ms / 1000)} 秒后自动重试（第 ${n} 次）…`
                p.onUpsert(asst)
              }
            }
          )
          asst.notice = undefined
          break
        } catch (e: any) {
          const err = p.signal.aborted ? null : e instanceof LlmError ? e : classifyNetwork(e, { baseUrl: settings.baseUrl, proxy: this.deps.proxyLabel?.() })
          // 上下文超长：把预算减半后自动重试（最多 2 次）
          if (err?.kind === 'context_overflow' && attempt < 2 && !asst.content) {
            budget = Math.max(1500, Math.floor(budget / 2))
            asst.notice = `对话过长，已自动裁剪历史后重试…`
            p.onUpsert(asst)
            continue
          }
          asst.streaming = false
          asst.notice = undefined
          if (!err) asst.stopped = true
          else {
            asst.error = err.message
            asst.errorKind = err.kind
            asst.retryable = true
            error = asst.error
          }
          p.onUpsert(asst)
          result = null
          break
        }
      }
      if (!result) break
      if (tracker) {
        const u = result.usage || estimateUsage(sentMessages, (result.content || '') + (result.reasoning || '') + JSON.stringify(result.toolCalls || []))
        const mu = tracker.record(u, { model: p.model, baseUrl: settings.baseUrl, kind: p.isTask ? 'task' : p.routineId ? 'routine' : 'chat', assistantId: p.assistantId, taskId: p.taskId, routineId: p.routineId, runKey: p.runKey })
        asst.usage = mu
        runUsage = sumUsage(runUsage, mu)
        p.onUsage?.(mu)
      }
      asst.streaming = false
      asst.content = result.content
      if (result.reasoning) asst.reasoning = result.reasoning
      if (result.content) finalText = result.content
      if (!result.toolCalls.length) {
        p.onUpsert(asst)
        break
      }
      asst.toolCalls = result.toolCalls.map((t): ToolCallRecord => ({ id: t.id, name: t.name, arguments: t.arguments, status: 'running' }))
      p.onUpsert(asst)

      for (const tc of asst.toolCalls) {
        let args: Record<string, any> = {}
        let parsed = true
        const known = new Set((tools || []).map((d) => d.function.name))
        const repaired = repairJson(tc.arguments || '')
        if (repaired) {
          args = repaired
          if (tc.arguments && tc.arguments.trim() !== JSON.stringify(repaired)) {
            try {
              JSON.parse(tc.arguments)
            } catch {
              tc.arguments = JSON.stringify(repaired)
            }
          }
        } else {
          parsed = false
          tc.status = 'error'
          tc.result = `参数不是合法的 JSON（可能被截断${result.finishReason === 'length' ? '：输出达到长度上限' : ''}）。请重新调用 ${tc.name}，并提供完整、合法的 JSON 参数。`
        }
        if (parsed && known.size && !known.has(tc.name)) {
          parsed = false
          tc.status = 'error'
          tc.result = `不存在名为「${tc.name}」的工具。可用工具：${[...known].join(', ')}`
        }
        if (parsed && !usedComputer && this.tools.isComputerTool?.(tc.name) && this.deps.computerPreflight) {
          // 电脑控制前检查模型能力（需要视觉 + 工具调用），结果按模型缓存
          if (computerBlock === undefined) {
            tc.result = '正在检测模型是否支持电脑控制（图片输入 / 工具调用）…'
            p.onUpsert(asst)
            computerBlock = await this.deps.computerPreflight(p.model).catch(() => null)
            tc.result = undefined
          }
          if (computerBlock) {
            parsed = false
            tc.status = 'error'
            tc.result = computerBlock
          }
        }
        if (parsed) {
          if (p.signal.aborted) {
            tc.status = 'cancelled'
            tc.result = '已取消'
          } else {
            let approved = true
            const isComputer = !!this.tools.isComputerTool?.(tc.name)
            if (isComputer && !usedComputer && !planned && !p.autoApproveAll) {
              planned = true
              const goal = [...p.messages].reverse().find((m) => m.role === 'user')?.content || ''
              const planText = heuristicPlan(goal)
              if (settings.planAutoConfirm || settings.trustedMode) {
                const notice: ChatMessage = {
                  id: uid(),
                  role: 'assistant',
                  content: '',
                  plan: { text: planText, status: 'confirmed' },
                  createdAt: Date.now(),
                  ...p.meta
                }
                push(notice)
                p.messages.push({ id: uid(), role: 'user', content: '（系统）计划已自动确认，请按计划执行电脑操控。\n' + planText, createdAt: Date.now() })
              } else {
                const planMsg: ChatMessage = {
                  id: uid(),
                  role: 'assistant',
                  content: '即将开始电脑操控，请确认或编辑计划：',
                  plan: { text: planText, status: 'pending' },
                  createdAt: Date.now(),
                  ...p.meta
                }
                push(planMsg)
                this.deps.emit({ type: 'plan', assistantId: p.assistantId, messageId: planMsg.id, text: planText, status: 'pending' })
                const decision = await this.waitPlan(planMsg.id, p.signal)
                if (decision.action === 'reject' || p.signal.aborted) {
                  planMsg.plan = { text: planText, status: 'rejected' }
                  p.onUpsert(planMsg)
                  tc.status = 'denied'
                  tc.result = '用户拒绝了执行计划。'
                  approved = false
                } else {
                  const finalPlan = decision.action === 'edit' && decision.text ? decision.text : planText
                  planMsg.plan = { text: finalPlan, status: decision.action === 'edit' ? 'edited' : 'confirmed' }
                  planMsg.content = '计划已确认，开始执行。'
                  p.onUpsert(planMsg)
                  p.messages.push({
                    id: uid(),
                    role: 'user',
                    content: '（系统）用户已确认计划，请严格按下列步骤执行：\n' + finalPlan,
                    createdAt: Date.now()
                  })
                }
              }
            }
            if (approved && isComputer && !usedComputer && tc.status !== 'denied') {
              // 屏幕只有一块：排队获取屏幕锁，非 GUI 工具不受影响
              if (this.screen.owner && this.screen.owner !== p.key) {
                tc.result = '⏳ 等待屏幕控制权：另一个智能体正在操作电脑…'
                p.onUpsert(asst)
              }
              this.computerWaiting.set(p.key, p.controller)
              try {
                await this.screen.acquire(p.key, p.signal)
              } catch {
                /* 等待期间被取消 */
              } finally {
                this.computerWaiting.delete(p.key)
              }
              tc.result = undefined
              if (!p.signal.aborted) {
                usedComputer = true
                this.computerBegin(p.key, p.controller)
              }
            }
            if (!approved || tc.status === 'denied') {
              /* 计划被拒或已否决 */
            } else if (p.signal.aborted) {
              approved = false
            } else if (!p.autoApproveAll && this.tools.needsApproval(tc.name)) {
              tc.status = 'awaiting'
              p.onUpsert(asst)
              approved = await this.waitApproval(tc.id, p.signal)
            }
            if (!approved) {
              tc.status = p.signal.aborted ? 'cancelled' : 'denied'
              tc.result = p.signal.aborted ? '已取消' : '用户拒绝了此操作。'
            } else {
              tc.status = 'running'
              tc.startedAt = Date.now()
              p.onUpsert(asst)
              try {
                const r = await this.tools.execute(tc.name, args, {
                  assistantId: p.assistantId,
                  signal: p.signal,
                  isTask: p.isTask,
                  taskId: p.taskId,
                  autoApproveAll: p.autoApproveAll
                })
                tc.result = truncate(r.text, 50000)
                if (r.images?.length) tc.images = r.images
                tc.status = 'done'
              } catch (e: any) {
                tc.status = 'error'
                tc.result = `错误：${e?.message || String(e)}`
              }
              tc.finishedAt = Date.now()
                if (isComputer && tc.status === 'done') {
                  computerSteps++
                  const every = settings.reflectEveryNSteps ?? 5
                  if (shouldReflect(computerSteps, every, tc.name)) {
                    p.messages.push({
                      id: uid(),
                      role: 'user',
                      content: REFLECT_PROMPT,
                      createdAt: Date.now()
                    })
                  }
                }
            }
          }
        }
        p.onUpsert(asst)
        p.messages.push({
          id: uid(),
          role: 'tool',
          toolCallId: tc.id,
          content: tc.result || '',
          images: tc.images,
          createdAt: Date.now()
        })
      }
      p.save()
      if (p.signal.aborted) {
        asst.stopped = true
        p.onUpsert(asst)
        break
      }
    }
    } finally {
      const reason = this.stopReasons.get(p.key)
      if (reason) {
        this.stopReasons.delete(p.key)
        const last = [...p.messages].reverse().find((m) => m.role === 'assistant')
        if (last) {
          last.stopped = true
          last.stopReason = reason
          p.onUpsert(last)
        }
      }
      this.computerEnd(p.key)
      tracker?.endRun(p.runKey)
    }
    if (!budgetPaused) tracker?.paused.delete(p.assistantId)
    if (usedComputer && !error && finalText && this.deps.experience) {
      try {
        const goal = [...p.messages].find((m) => m.role === 'user')?.content || ''
        this.deps.experience.add({
          app: 'desktop',
          keywords: goal.split(/\s+/).slice(0, 8),
          summary: truncate(finalText, 200),
          steps: computerSteps || 1,
          success: true,
          assistantId: p.assistantId
        })
      } catch {
        /* ignore */
      }
    }
    try {
      ;(this.tools as any).currentRunId = null
    } catch {
      /* ignore */
    }
    return { text: finalText, error, usage: runUsage, budgetPaused }
  }

  /** 在主对话中运行一轮 */
  /** 重新发送上一次失败的请求 */
  retryLast(assistantId: string): Promise<RunResult> {
    const msgs = this.deps.store.getMessages(assistantId)
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (!lastUser) throw new Error('没有可重试的消息')
    return this.run(assistantId, { text: lastUser.content, retry: true })
  }

  async run(assistantId: string, opts: RunOptions): Promise<RunResult> {
    const { store, emit } = this.deps
    if (this.running.has(assistantId)) throw new Error('该助手正在回复中')
    const assistant = store.getAssistant(assistantId)
    if (!assistant) throw new Error('助手不存在')
    const ac = new AbortController()
    this.running.set(assistantId, ac)
    emit({ type: 'run-state', assistantId, running: true })
    const msgs = store.getMessages(assistantId)
    const meta = { source: opts.source, routineName: opts.routineName, taskId: opts.taskId }
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: opts.text,
      images: opts.images?.length ? opts.images : undefined,
      createdAt: Date.now(),
      ...meta
    }
    if (opts.retry) {
      while (msgs.length && msgs[msgs.length - 1].role === 'assistant' && (msgs[msgs.length - 1].error || (!msgs[msgs.length - 1].content && !msgs[msgs.length - 1].toolCalls?.length))) msgs.pop()
      emit({ type: 'messages-reset', assistantId })
    } else {
      msgs.push(userMsg)
      emit({ type: 'message-upsert', assistantId, message: userMsg })
    }
    store.saveMessages(assistantId)
    try {
      return await this.loop({
        assistantId,
        messages: msgs,
        system: () =>
          buildSystemPrompt(store.getAssistant(assistantId) || assistant, (store.getAssistant(assistantId)||assistant).workDir?.trim() || store.settings.workDir, {
            canSpawn: this.tools.defs({ isTask: false }).some((d) => d.function.name === 'spawn_task'),
            computer: this.tools.defs({ isTask: false }).some((d) => d.function.name === 'computer_screenshot'),
            agents: this.tools.defs({ isTask: false }).some((d) => d.function.name === 'delegate_to_agent')
              ? store.state.assistants.filter((x) => x.id !== assistantId)
              : undefined,
            skillsSummary: this.deps.skillsSummary?.(),
            computerTarget: this.deps.computerTargetSummary?.(),
            experienceBlock: this.deps.experience?.promptBlock(opts.text || '')
          }),
        model: assistant.model?.trim() || store.settings.model,
        signal: ac.signal,
        controller: ac,
        isTask: false,
        meta,
        routineId: opts.routineId,
        runKey: `run:${assistantId}:${userMsg.id}`,
        autoApproveAll: opts.autoApproveAll,
        key: assistantId,
        onUpsert: (m) => emit({ type: 'message-upsert', assistantId, message: { ...m, toolCalls: m.toolCalls?.map((t) => ({ ...t })) } }),
        onDelta: (m, d) => emit({ type: 'message-delta', assistantId, messageId: m.id, delta: d }),
        save: () => store.saveMessages(assistantId)
      })
    } catch (e: any) {
      return { text: '', error: e?.message || String(e) }
    } finally {
      for (const m of msgs) if (m.streaming) m.streaming = false
      store.saveMessages(assistantId)
      this.running.delete(assistantId)
      emit({ type: 'run-state', assistantId, running: false })
    }
  }

  /** 运行一个后台子任务（独立上下文） */
  async runTask(task: TaskInfo, onChange: (t: TaskInfo) => void): Promise<RunResult> {
    const { store } = this.deps
    const assistant = store.getAssistant(task.assistantId)
    if (!assistant) throw new Error('助手不存在')
    const ac = new AbortController()
    this.taskControllers.set(task.id, ac)
    task.messages.push({ id: uid(), role: 'user', content: task.prompt, createdAt: Date.now() })
    let timer: NodeJS.Timeout | null = null
    const throttled = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        onChange(task)
      }, 250)
    }
    try {
      const r = await this.loop({
        assistantId: task.assistantId,
        messages: task.messages,
        system: () => buildSystemPrompt(store.getAssistant(task.assistantId) || assistant, (store.getAssistant(task.assistantId)||assistant).workDir?.trim() || store.settings.workDir, { task: true, computer: this.tools.defs({ isTask: true }).some((d) => d.function.name === 'computer_screenshot'), delegatedBy: task.parentAssistantId ? store.getAssistant(task.parentAssistantId)?.name : undefined, computerTarget: this.deps.computerTargetSummary?.(), experienceBlock: this.deps.experience?.promptBlock(task.prompt || '') }),
        model: assistant.model?.trim() || store.settings.model,
        signal: ac.signal,
        controller: ac,
        isTask: true,
        taskId: task.id,
        meta: {},
        runKey: `task:${task.id}`,
        onUsage: (u) => {
          task.usage = sumUsage(task.usage, u)
        },
        autoApproveAll: task.autoApproveAll,
        key: `task:${task.id}`,
        onUpsert: () => onChange(task),
        onDelta: throttled,
        save: () => onChange(task)
      })
      if (ac.signal.aborted) return { text: r.text, error: task.messages.some((m) => m.stopReason) ? '已紧急停止' : '已取消' }
      return r
    } finally {
      if (timer) clearTimeout(timer)
      for (const m of task.messages) if (m.streaming) m.streaming = false
      this.taskControllers.delete(task.id)
    }
  }
}
