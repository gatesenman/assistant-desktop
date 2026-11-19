import type { Store } from './store'
import type { ToolDef } from './llm'
import { TOOL_DEFS, executeTool } from './tools'
import { BROWSER_TOOL_DEFS, type BrowserManager, type ToolResult } from './browser'
import type { McpManager } from './mcp'
import { COMPUTER_TOOL_DEFS, isComputerTool, type ComputerController } from './computer'
import type { ComputerLogEntry, TaskInfo } from '../../shared/types'
import { uid } from './util'

export type { ToolResult }

export interface ToolExecContext {
  assistantId: string
  signal: AbortSignal
  isTask: boolean
  taskId?: string
  autoApproveAll?: boolean
}

export interface ToolHost {
  defs(opts: { isTask: boolean }): ToolDef[]
  needsApproval(name: string): boolean
  isComputerTool?(name: string): boolean
  execute(name: string, args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult>
}

export interface TaskSpawner {
  spawn(assistantId: string, title: string, prompt: string, opts?: { autoApproveAll?: boolean }): string
  delegate?(
    parentAssistantId: string,
    items: { assistantId: string; title: string; prompt: string }[],
    opts?: { autoApproveAll?: boolean; signal?: AbortSignal }
  ): Promise<TaskInfo[]>
}

export const DELEGATE_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'delegate_to_agent',
    description:
      '作为协调者，把一个大任务拆分成若干子任务，委派给其它助手（智能体）并行执行。每个子任务在对应助手的人设、记忆和模型下独立运行，全部完成后返回汇总的结果，你再整合后回复用户。子任务之间互不可见，请写清楚完整、自包含的说明。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '要并行执行的子任务列表',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: '执行该子任务的助手名称（见系统提示中的可用助手列表）' },
              title: { type: 'string', description: '简短标题' },
              prompt: { type: 'string', description: '完整、自包含的子任务说明' }
            },
            required: ['agent', 'prompt']
          }
        }
      },
      required: ['tasks']
    }
  }
}

export const SPAWN_TASK_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'spawn_task',
    description:
      '在后台启动一个独立的子任务（独立上下文、可使用相同的工具），适合耗时的调研、批量文件处理、网页浏览等。立即返回任务 ID，主对话可以继续；任务完成后结果会自动发回对话，届时你再向用户总结。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简短的任务标题' },
        prompt: { type: 'string', description: '完整、自包含的任务说明（子任务看不到当前对话）' }
      },
      required: ['title', 'prompt']
    }
  }
}

export const LOAD_SKILL_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'load_skill',
    description: '加载一个技能的完整说明（SKILL.md），按其中的步骤与推荐工具执行。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '技能 id，例如 builtin/email-triage' } }, required: ['id'] }
  }
}
export const ORCHESTRATE_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'orchestrate',
    description: '把一个大目标拆成带依赖的子任务编排（DAG），自动并行/串行执行、失败重试。适合多步骤复杂目标。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '总体目标' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'number' }, description: '依赖的步骤序号（从 0 开始）' },
              priority: { type: 'number' }
            },
            required: ['title']
          }
        }
      },
      required: ['goal']
    }
  }
}
export const CHANNEL_REPLY_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'channel_reply',
    description: '向消息通道（Telegram/Slack/微信桥）回复。默认进入待批准草稿，除非通道关闭了审批或处于信任模式。',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        chat_key: { type: 'string', description: 'Telegram chat_id / Slack channel id' },
        text: { type: 'string' }
      },
      required: ['channel_id', 'chat_key', 'text']
    }
  }
}


export const ASK_USER_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'ask_user',
    description:
      '向用户提问并等待回答（聊天中出现审批卡片，可输入文本）。用于登录验证码、付款确认、歧义澄清等。未回答前循环会暂停。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题' },
        placeholder: { type: 'string', description: '输入框占位提示' }
      },
      required: ['question']
    }
  }
}

const NO_APPROVAL = new Set(['save_memory', 'spawn_task', 'delegate_to_agent', 'load_skill', 'orchestrate', 'ask_user'])

export class DefaultToolHost implements ToolHost {
  tasks: TaskSpawner | null = null

  /** v0.8：当前电脑操控 runId（由 Agent 设置） */
  currentRunId: string | null = null

  constructor(
    private deps: {
      store: Store
      onMemorySaved?: () => void
      browser?: BrowserManager
      mcp?: McpManager
      computer?: ComputerController
      onComputerLog?: (e: ComputerLogEntry) => void
      fetchImpl?: typeof fetch
      loadSkill?: (id: string) => Promise<string>
      orchestrate?: (assistantId: string, goal: string, steps?: any[]) => Promise<string>
      channelReply?: (channelId: string, chatKey: string, text: string) => Promise<string>
      getAssistantId?: () => string | undefined
      /** v0.8：向用户提问并等待文本回答；返回 null 表示取消 */
      askUser?: (question: string, ctx: ToolExecContext, callMeta?: { placeholder?: string }) => Promise<string | null>
      onBrowserTakeoverHint?: (reason: string, ctx: ToolExecContext) => void
    }
  ) {}

  isComputerTool(name: string): boolean {
    return isComputerTool(name)
  }

  defs({ isTask }: { isTask: boolean }): ToolDef[] {
    const out = [...TOOL_DEFS]
    if (this.deps.browser) out.push(...BROWSER_TOOL_DEFS)
    if (!isTask && this.tasks) out.push(SPAWN_TASK_DEF)
    if (!isTask && this.tasks?.delegate && this.deps.store.state.assistants.length > 1) out.push(DELEGATE_DEF)
    const aid = this.deps.getAssistantId?.()
    const a = aid ? this.deps.store.getAssistant(aid) : undefined
    const botOk = !a || (a.computerEnabled !== false && a.computerMode !== 'off')
    if (this.deps.computer && this.deps.store.settings.computerEnabled && botOk) out.push(...COMPUTER_TOOL_DEFS)
    if (this.deps.loadSkill) out.push(LOAD_SKILL_DEF)
    if (this.deps.orchestrate && !isTask) out.push(ORCHESTRATE_DEF)
    if (this.deps.channelReply) out.push(CHANNEL_REPLY_DEF)
    if (this.deps.askUser) out.push(ASK_USER_DEF)
    if (this.deps.mcp) out.push(...this.deps.mcp.toolDefs())
    return out
  }

  needsApproval(name: string): boolean {
    if (NO_APPROVAL.has(name)) return false
    if (name.startsWith('mcp__')) {
      const r = this.deps.mcp?.resolve(name)
      return !r?.cfg.autoApprove
    }
    if (isComputerTool(name) && this.deps.store.settings.trustedMode) return false
    return !this.deps.store.settings.autoApprove[name]
  }

  async execute(name: string, args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
    if (name === 'load_skill') {
      if (!this.deps.loadSkill) throw new Error('技能系统未启用')
      return { text: await this.deps.loadSkill(String(args.id || '')) }
    }
    if (name === 'orchestrate') {
      if (!this.deps.orchestrate) throw new Error('编排系统未启用')
      const aid = ctx.assistantId || this.deps.getAssistantId?.()
      if (!aid) throw new Error('缺少助手 id')
      return { text: await this.deps.orchestrate(aid, String(args.goal || ''), args.steps) }
    }
    if (name === 'channel_reply') {
      if (!this.deps.channelReply) throw new Error('消息通道未启用')
      return { text: await this.deps.channelReply(String(args.channel_id), String(args.chat_key), String(args.text)) }
    }
    const { store } = this.deps
    if (name === 'spawn_task') {
      if (ctx.isTask || !this.tasks) throw new Error('子任务中不能再创建子任务')
      const title = String(args.title || '后台任务').slice(0, 60)
      const prompt = String(args.prompt || '').trim()
      if (!prompt) throw new Error('缺少任务说明 prompt')
      const id = this.tasks.spawn(ctx.assistantId, title, prompt, { autoApproveAll: ctx.autoApproveAll })
      return { text: `已在后台启动任务「${title}」（ID: ${id}）。任务完成后结果会自动发回对话，现在请先简短告知用户任务已开始。` }
    }
    if (name === 'delegate_to_agent') {
      if (ctx.isTask || !this.tasks?.delegate) throw new Error('子任务中不能再委派')
      const list: any[] = Array.isArray(args.tasks) ? args.tasks : []
      if (!list.length) throw new Error('tasks 不能为空')
      if (list.length > 16) throw new Error('一次最多委派 16 个子任务')
      const all = store.state.assistants
      const find = (q: string) => {
        const k = String(q || '').trim()
        return all.find((a) => a.id === k) || all.find((a) => a.name === k) || all.find((a) => k && (a.name.includes(k) || k.includes(a.name)))
      }
      const items = list.map((t, i) => {
        const a = find(t.agent)
        if (!a) throw new Error(`找不到助手「${t.agent}」。可用助手：${all.map((x) => x.name).join('、')}`)
        const prompt = String(t.prompt || '').trim()
        if (!prompt) throw new Error(`第 ${i + 1} 个子任务缺少 prompt`)
        return { assistantId: a.id, title: String(t.title || prompt).slice(0, 60), prompt }
      })
      const t0 = Date.now()
      const done = await this.tasks.delegate(ctx.assistantId, items, { autoApproveAll: ctx.autoApproveAll, signal: ctx.signal })
      const secs = (ms: number) => (ms / 1000).toFixed(1) + 's'
      const ok = done.filter((t) => t.status === 'done').length
      const lines = [`委派完成：${done.length} 个子任务并行执行，${ok} 个成功，总用时 ${secs(Date.now() - t0)}。`, '']
      done.forEach((t, i) => {
        const name = store.getAssistant(t.assistantId)?.name || t.assistantId
        const st = t.status === 'done' ? '完成' : t.status === 'cancelled' ? '已取消' : '失败'
        const dur = t.startedAt && t.finishedAt ? secs(t.finishedAt - t.startedAt) : '-'
        lines.push(`### ${i + 1}. ${name} · ${t.title}（${st}，用时 ${dur}）`)
        lines.push(t.result?.trim() || (t.error ? `错误：${t.error}` : '(无结果)'), '')
      })
      return { text: lines.join('\n').trim() }
    }
    if (name === 'ask_user') {
      if (!this.deps.askUser) throw new Error('ask_user 不可用')
      const q = String(args.question || '').trim()
      if (!q) throw new Error('缺少 question')
      const ans = await this.deps.askUser(q, ctx, { placeholder: args.placeholder ? String(args.placeholder) : undefined })
      if (ans == null) return { text: '用户取消了回答或已超时。' }
      return { text: `用户回答：${ans}` }
    }
    if (name.startsWith('browser_')) {
      if (!this.deps.browser) throw new Error('浏览器自动化不可用')
      const r = await this.deps.browser.execute(ctx.taskId ? `task:${ctx.taskId}` : ctx.assistantId, name, args)
      if ((r as any).needsTakeover) this.deps.onBrowserTakeoverHint?.((r as any).takeoverReason || '需要人工接管', ctx)
      return r
    }
    if (isComputerTool(name)) {
      if (!this.deps.computer || !store.settings.computerEnabled) throw new Error('电脑控制未启用')
      const a = store.getAssistant(ctx.assistantId)
      if (a && (a.computerEnabled === false || a.computerMode === 'off')) throw new Error('该助手已关闭电脑控制（预览≠授权）')
      const entry: ComputerLogEntry = {
        id: uid(),
        assistantId: ctx.assistantId,
        taskId: ctx.taskId,
        runId: this.currentRunId || undefined,
        tool: name,
        args: JSON.stringify(args),
        ok: true,
        at: Date.now()
      }
      try {
        const r = await this.deps.computer.execute(name, args)
        entry.thumb = r.thumb
        return { text: r.text, images: r.images }
      } catch (e: any) {
        entry.ok = false
        entry.error = e?.message || String(e)
        throw e
      } finally {
        this.deps.onComputerLog?.(entry)
      }
    }
    if (name.startsWith('mcp__')) {
      if (!this.deps.mcp) throw new Error('MCP 不可用')
      return this.deps.mcp.call(name, args)
    }
    const text = await executeTool(name, args, {
      workDir: store.getAssistant(ctx.assistantId)?.workDir?.trim() || store.settings.workDir,
      signal: ctx.signal,
      fetchImpl: this.deps.fetchImpl,
      saveMemory: (t) => {
        store.addMemory(ctx.assistantId, t)
        this.deps.onMemorySaved?.()
      }
    })
    return { text }
  }
}
