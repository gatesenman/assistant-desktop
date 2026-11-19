import type { AppEvent, TaskInfo } from '../../shared/types'
import type { Store } from './store'
import type { Agent } from './agent'
import type { TaskSpawner } from './toolhost'
import { uid } from './util'

export interface TaskManagerDeps {
  store: Store
  agent: Agent
  emit: (ev: AppEvent) => void
  /** 任务完成时（用于桌面通知） */
  onFinished?: (task: TaskInfo, assistantName: string) => void
  /** 完成后是否让主助手跟进总结，默认 true */
  followUp?: boolean
}

/** 后台子任务管理：独立 agent 循环，完成后把结果发回主对话并触发一次总结 */
export class TaskManager implements TaskSpawner {
  constructor(private deps: TaskManagerDeps) {}

  list(): TaskInfo[] {
    return this.deps.store.tasks
  }

  get(id: string): TaskInfo | undefined {
    return this.deps.store.tasks.find((t) => t.id === id)
  }

  private changed(t: TaskInfo, persist = false): void {
    this.deps.emit({ type: 'task-upsert', task: JSON.parse(JSON.stringify(t)) })
    if (persist) this.deps.store.saveTasks()
  }

  private active = 0
  private pending: TaskInfo[] = []
  private resolvers = new Map<string, () => void>()
  /** 返回任务结束（含回传总结）的 Promise */
  private finished = new Map<string, Promise<void>>()
  whenDone(id: string): Promise<void> | undefined {
    return this.finished.get(id)
  }

  /** 当前并发上限 */
  get limit(): number {
    return Math.max(1, Math.min(32, this.deps.store.settings.maxConcurrentAgents || 10))
  }

  get activeCount(): number {
    return this.active
  }

  spawn(
    assistantId: string,
    title: string,
    prompt: string,
    opts: { autoApproveAll?: boolean; parentAssistantId?: string; groupId?: string } = {}
  ): string {
    const task: TaskInfo = {
      id: uid().slice(0, 8),
      assistantId,
      title,
      prompt,
      status: 'queued',
      createdAt: Date.now(),
      messages: [],
      autoApproveAll: opts.autoApproveAll,
      parentAssistantId: opts.parentAssistantId,
      groupId: opts.groupId
    }
    this.deps.store.tasks.push(task)
    this.finished.set(task.id, new Promise<void>((r) => this.resolvers.set(task.id, r)))
    this.pending.push(task)
    this.changed(task, true)
    // 异步调度，不阻塞调用方
    setTimeout(() => this.pump(), 0)
    return task.id
  }

  /** 在并发上限内启动排队中的任务 */
  private pump(): void {
    while (this.active < this.limit && this.pending.length) {
      const t = this.pending.shift()!
      if (t.status !== 'queued') continue
      this.active++
      t.status = 'running'
      t.startedAt = Date.now()
      this.changed(t, true)
      void this.execute(t).finally(() => {
        this.active--
        this.resolvers.get(t.id)?.()
        this.resolvers.delete(t.id)
        this.pump()
      })
    }
  }

  /**
   * 协调者把多个子任务委派给其它助手并行执行，等待全部完成后返回（结果由调用方汇总）。
   * signal 中止时取消整组任务。
   */
  async delegate(
    parentAssistantId: string,
    items: { assistantId: string; title: string; prompt: string }[],
    opts: { autoApproveAll?: boolean; signal?: AbortSignal } = {}
  ): Promise<TaskInfo[]> {
    const groupId = uid().slice(0, 8)
    const ids = items.map((it) => this.spawn(it.assistantId, it.title, it.prompt, { autoApproveAll: opts.autoApproveAll, parentAssistantId, groupId }))
    const onAbort = (): void => ids.forEach((id) => this.cancel(id))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.all(ids.map((id) => this.whenDone(id)))
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
    return ids.map((id) => this.get(id)!).filter(Boolean)
  }

  private async execute(task: TaskInfo): Promise<void> {
    const { agent, store } = this.deps
    let res
    try {
      res = await agent.runTask(task, (t) => this.changed(t))
    } catch (e: any) {
      res = { text: '', error: e?.message || String(e) }
    }
    task.finishedAt = Date.now()
    task.result = res.text
    if (res.error === '已取消' || res.error === '已紧急停止') task.status = 'cancelled'
    else if (res.error && !res.text) task.status = 'error'
    else task.status = 'done'
    task.error = res.error
    this.changed(task, true)
    const a = store.getAssistant(task.assistantId)
    if (!a) return
    this.deps.onFinished?.(task, a.name)
    // 委派任务的结果由协调者汇总，不单独回传
    if (task.parentAssistantId || this.deps.followUp === false || task.status === 'cancelled') return
    const statusText = task.status === 'done' ? '已完成' : '失败'
    const body =
      task.status === 'done'
        ? `结果：\n${task.result || '(无文本结果)'}`
        : `错误：${task.error || '未知错误'}${task.result ? `\n部分结果：\n${task.result}` : ''}`
    await agent.runQueued(task.assistantId, {
      text: `【后台任务${statusText}】「${task.title}」（ID: ${task.id}）\n\n${body}\n\n请根据以上结果向用户做简要总结。`,
      source: 'task',
      taskId: task.id
    })
  }

  cancel(id: string): void {
    const t = this.get(id)
    if (t?.status === 'queued') {
      t.status = 'cancelled'
      t.error = '已取消'
      t.finishedAt = Date.now()
      this.pending = this.pending.filter((x) => x !== t)
      this.changed(t, true)
      this.resolvers.get(id)?.()
      this.resolvers.delete(id)
      return
    }
    this.deps.agent.stopTask(id)
  }

  clearFinished(assistantId: string): void {
    this.deps.store.tasks = this.deps.store.tasks.filter((t) => (t.assistantId !== assistantId && t.parentAssistantId !== assistantId) || t.status === 'running' || t.status === 'queued')
    this.deps.store.saveTasks()
  }
}
