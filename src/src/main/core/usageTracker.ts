import type { MessageUsage, UsageView } from '../../shared/types'
import type { Store } from './store'
import { addUsage, checkBudget, findPrice, priceUsage, UsageLedger, type BudgetCheck, type UsageKind, type UsageNumbers } from './usage'

export interface UsageContext {
  model: string
  baseUrl: string
  kind: UsageKind
  assistantId?: string
  taskId?: string
  routineId?: string
  runKey?: string
}

/** 把账本、价格表、预算串起来，供智能体 / grounding 调用 */
export class UsageTracker {
  readonly paused = new Map<string, { message: string; at: number }>()

  constructor(readonly ledger: UsageLedger, private store: Store) {}

  record(u: UsageNumbers, ctx: UsageContext, at = new Date()): MessageUsage {
    const entry = findPrice(this.store.settings.prices || [], ctx.baseUrl, ctx.model)
    const { cost, priced, peak } = priceUsage(u, entry, at, this.store.settings.cnyPerUsd)
    this.ledger.record({ ...u, at: at.getTime(), model: ctx.model, baseUrl: ctx.baseUrl, kind: ctx.kind, assistantId: ctx.assistantId, taskId: ctx.taskId, routineId: ctx.routineId, runKey: ctx.runKey, cost, priced })
    return { ...u, cost, priced, model: ctx.model, calls: 1, ...(peak ? { peak } : {}) }
  }

  check(runKey: string): BudgetCheck {
    return checkBudget(this.store.settings.budget, this.ledger.runSpent(runKey), this.ledger.today().cost)
  }

  endRun(runKey: string): void {
    this.ledger.resetRun(runKey)
  }

  view(): UsageView {
    return {
      summary: this.ledger.summary,
      days: this.ledger.lastDays(30),
      today: this.ledger.today(),
      prices: this.store.settings.prices,
      budget: this.store.settings.budget,
      paused: [...this.paused.entries()].map(([assistantId, v]) => ({ assistantId, ...v })),
      recent: this.ledger.records
        .slice(-40)
        .reverse()
        .map((r) => ({ at: r.at, model: r.model, kind: r.kind, input: r.input, output: r.output, cacheHit: r.cacheHit, cost: r.cost, priced: r.priced, assistantId: r.assistantId, routineId: r.routineId, taskId: r.taskId }))
    }
  }
}

/** 合并多次调用的用量 */
export function sumUsage(a: MessageUsage | undefined, b: MessageUsage): MessageUsage {
  if (!a) return { ...b }
  const s = addUsage(a, b)
  return { ...s, cost: a.cost + b.cost, priced: a.priced && b.priced, model: b.model || a.model, calls: a.calls + b.calls, peak: a.peak || b.peak || undefined }
}
