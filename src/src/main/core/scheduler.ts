import cron from 'node-cron'
import type { Routine } from '../../shared/types'
import type { Store } from './store'
import type { Agent } from './agent'

export interface SchedulerDeps {
  store: Store
  agent: Agent
  onRoutineDone?: (routine: Routine, assistantName: string, text: string, error?: string) => void
  onStateChanged?: () => void
}

export function isValidCron(expr: string): boolean {
  return typeof expr === 'string' && expr.trim().length > 0 && cron.validate(expr.trim())
}

/** 基于 node-cron 的定时任务调度器（应用打开期间在后台运行） */
export class Scheduler {
  private tasks = new Map<string, cron.ScheduledTask>()

  constructor(private deps: SchedulerDeps) {}

  sync(): void {
    for (const t of this.tasks.values()) t.stop()
    this.tasks.clear()
    for (const r of this.deps.store.state.routines) {
      if (!r.enabled || !isValidCron(r.cron)) continue
      const task = cron.schedule(r.cron.trim(), () => {
        if (this.deps.store.settings.routinesPaused) return
        void this.runRoutine(r.id)
      })
      this.tasks.set(r.id, task)
    }
  }

  stopAll(): void {
    for (const t of this.tasks.values()) t.stop()
    this.tasks.clear()
  }

  get scheduledCount(): number {
    return this.tasks.size
  }

  async runRoutine(id: string): Promise<void> {
    const { store, agent } = this.deps
    const r = store.state.routines.find((x) => x.id === id)
    if (!r) return
    const a = store.getAssistant(r.assistantId)
    if (!a) return
    let text = ''
    let error: string | undefined
    let usage: import('../../shared/types').MessageUsage | undefined
    try {
      const res = await agent.runQueued(a.id, { text: r.prompt, source: 'routine', routineName: r.name, routineId: r.id, autoApproveAll: !!r.unattended })
      text = res.text
      error = res.error
      usage = res.usage
    } catch (e: any) {
      error = e?.message || String(e)
    }
    const cur = store.state.routines.find((x) => x.id === id)
    if (cur) {
      store.updateRoutine(id, { lastRunAt: Date.now(), lastStatus: error ? 'error' : 'ok', lastError: error, ...(usage ? { lastUsage: usage } : {}) })
      this.deps.onStateChanged?.()
    }
    this.deps.onRoutineDone?.(r, a.name, text, error)
  }
}
