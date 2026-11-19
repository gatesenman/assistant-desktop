/**
 * 任务编排：把大目标拆成带依赖的子任务 DAG，按优先级调度，失败退避重试。
 */
import { EventEmitter } from 'events'
import type { OrchestratorJob, OrchestratorNode, TaskInfo } from '../../shared/types'
import { uid } from './util'

export interface OrchestratorDeps {
  spawnTask: (assistantId: string, title: string, prompt: string, opts?: { autoApproveAll?: boolean; parentAssistantId?: string; groupId?: string }) => Promise<TaskInfo>
  onJob: (job: OrchestratorJob) => void
}

function topoReady(nodes: OrchestratorNode[]): OrchestratorNode[] {
  const done = new Set(nodes.filter((n) => n.status === 'done').map((n) => n.id))
  return nodes
    .filter((n) => n.status === 'pending' || n.status === 'ready')
    .filter((n) => (n.dependsOn || []).every((d) => done.has(d)))
    .map((n) => ({ ...n, status: 'ready' as const }))
    .sort((a, b) => b.priority - a.priority)
}

/** 启发式拆分（无模型时的回退）：按中文分号/数字列表切开 */
export function heuristicSplit(goal: string): Omit<OrchestratorNode, 'status' | 'attempts'>[] {
  const parts = goal
    .split(/\n+|(?:(?<=\d)[\.、]|\；|;|然后|接着|最后)/)
    .map((s) => s.replace(/^\s*\d+[\.、)\]]\s*/, '').trim())
    .filter((s) => s.length >= 4)
  const uniq = parts.length >= 2 ? parts.slice(0, 8) : ['理解目标并列出步骤', '执行主要工作', '汇总结果并检查']
  return uniq.map((title, i) => ({
    id: uid(),
    title: title.slice(0, 40),
    prompt: `作为编排子任务「${title}」，总体目标：${goal}\n\n请完成该子任务并给出简洁结果。`,
    priority: uniq.length - i,
    dependsOn: i === 0 ? [] : [/* filled below */],
    maxAttempts: 2
  })).map((n, i, arr) => (i === 0 ? n : { ...n, dependsOn: [arr[i - 1].id] }))
}

export class Orchestrator extends EventEmitter {
  jobs = new Map<string, OrchestratorJob>()
  private running = new Set<string>()
  constructor(private deps: OrchestratorDeps) {
    super()
  }

  list(): OrchestratorJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  create(assistantId: string, goal: string, nodes?: Partial<OrchestratorNode>[]): OrchestratorJob {
    const built =
      nodes && nodes.length
        ? nodes.map((n, i) => ({
            id: n.id || uid(),
            title: n.title || `步骤 ${i + 1}`,
            prompt: n.prompt || String(n.title),
            status: 'pending' as const,
            priority: n.priority ?? nodes.length - i,
            dependsOn: n.dependsOn || [],
            attempts: 0,
            maxAttempts: n.maxAttempts ?? 2
          }))
        : heuristicSplit(goal).map((n) => ({ ...n, status: 'pending' as const, attempts: 0 }))
    const job: OrchestratorJob = {
      id: uid(),
      assistantId,
      title: goal.slice(0, 40),
      goal,
      status: 'queued',
      nodes: built,
      createdAt: Date.now()
    }
    this.jobs.set(job.id, job)
    this.emitJob(job)
    void this.pump(job.id)
    return job
  }

  pause(id: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    j.status = 'paused'
    this.emitJob(j)
  }
  resume(id: string): void {
    const j = this.jobs.get(id)
    if (!j || j.status !== 'paused') return
    j.status = 'running'
    this.emitJob(j)
    void this.pump(id)
  }
  cancel(id: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    j.status = 'cancelled'
    for (const n of j.nodes) if (n.status === 'pending' || n.status === 'ready' || n.status === 'running') n.status = 'cancelled'
    j.finishedAt = Date.now()
    this.emitJob(j)
  }

  /** 子任务完成回调 */
  onTaskFinished(task: TaskInfo): void {
    for (const j of this.jobs.values()) {
      const n = j.nodes.find((x) => x.taskId === task.id)
      if (!n) continue
      if (task.status === 'done') {
        n.status = 'done'
        n.result = task.result
        n.finishedAt = Date.now()
      } else if (task.status === 'cancelled') {
        n.status = 'cancelled'
        n.finishedAt = Date.now()
      } else {
        n.attempts++
        if (n.attempts < n.maxAttempts) {
          n.status = 'pending'
          n.error = task.error
          const delay = Math.min(30000, 1000 * 2 ** n.attempts)
          setTimeout(() => void this.pump(j.id), delay)
        } else {
          n.status = 'error'
          n.error = task.error || '失败'
          n.finishedAt = Date.now()
        }
      }
      this.emitJob(j)
      void this.pump(j.id)
    }
  }

  private emitJob(j: OrchestratorJob): void {
    this.deps.onJob({ ...j, nodes: j.nodes.map((n) => ({ ...n })) })
  }

  private async pump(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return
    this.running.add(jobId)
    try {
      const j = this.jobs.get(jobId)
      if (!j || j.status === 'paused' || j.status === 'cancelled') return
      if (j.status === 'queued') {
        j.status = 'running'
        j.startedAt = Date.now()
      }
      // 标记 ready
      const readyIds = new Set(topoReady(j.nodes).map((n) => n.id))
      for (const n of j.nodes) if (readyIds.has(n.id) && n.status === 'pending') n.status = 'ready'
      const ready = j.nodes.filter((n) => n.status === 'ready').sort((a, b) => b.priority - a.priority)
      for (const n of ready.slice(0, 3)) {
        n.status = 'running'
        n.startedAt = Date.now()
        this.emitJob(j)
        try {
          const task = await this.deps.spawnTask(j.assistantId, n.title, n.prompt, { parentAssistantId: j.assistantId, groupId: j.id })
          n.taskId = task.id
          this.emitJob(j)
        } catch (e: any) {
          n.status = 'error'
          n.error = e?.message || String(e)
          n.finishedAt = Date.now()
          this.emitJob(j)
        }
      }
      const allDone = j.nodes.every((n) => ['done', 'error', 'cancelled'].includes(n.status))
      if (allDone) {
        j.status = j.nodes.some((n) => n.status === 'error') ? 'error' : j.nodes.every((n) => n.status === 'cancelled') ? 'cancelled' : 'done'
        j.finishedAt = Date.now()
        this.emitJob(j)
      }
    } finally {
      this.running.delete(jobId)
    }
  }
}
