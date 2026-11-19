import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ScreenLock } from '../src/main/core/screenlock'
import { Store } from '../src/main/core/store'
import { Agent } from '../src/main/core/agent'
import { TaskManager } from '../src/main/core/tasks'
import { DefaultToolHost } from '../src/main/core/toolhost'
import { ComputerController, type ComputerDeps } from '../src/main/core/computer'
import { startServer, sse, textChunks, toolCallChunks, type MockServer } from './helpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ScreenLock', () => {
  it('is FIFO, re-entrant and abortable', async () => {
    const changes: (string | null)[] = []
    const l = new ScreenLock((o) => changes.push(o))
    await l.acquire('a')
    await l.acquire('a') // 可重入
    const order: string[] = []
    const pb = l.acquire('b').then(() => order.push('b'))
    const ac = new AbortController()
    const pc = l.acquire('c', ac.signal).catch((e) => order.push('c:' + e.message))
    const pd = l.acquire('d').then(() => order.push('d'))
    expect(l.waiting).toEqual(['b', 'c', 'd'])
    ac.abort()
    await pc
    expect(l.waiting).toEqual(['b', 'd'])
    l.release('a')
    await pb
    expect(l.owner).toBe('b')
    l.release('b')
    await pd
    expect(order).toEqual(['c:已取消', 'b', 'd'])
    l.release('d')
    expect(l.owner).toBe(null)
    expect(l.history.map((h) => h.owner)).toEqual(['a', 'b', 'd'])
    for (const h of l.history) expect(h.releasedAt).toBeGreaterThanOrEqual(h.acquiredAt)
  })
})

describe('multi-agent', () => {
  let dir: string
  let srv: MockServer | null = null
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'par-'))
  })
  afterEach(async () => {
    await srv?.close()
    srv = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function computerDeps(): ComputerDeps {
    return {
      capture: async () => ({ jpeg: Buffer.from('x'), thumb: Buffer.from('t'), width: 100, height: 100 }),
      driver: async () => ({
        size: async () => ({ width: 100, height: 100 }),
        move: async () => {},
        click: async () => {},
        drag: async () => {},
        scroll: async () => {},
        type: async () => {},
        keys: async () => {},
        windows: async () => [],
        focus: async () => true
      }),
      openApp: async () => 'ok',
      openUrl: async () => {},
      settleMs: 0
    }
  }

  async function setup(handler: Parameters<typeof startServer>[0], names: string[]) {
    srv = await startServer(handler)
    const store = new Store(dir)
    store.updateSettings({ baseUrl: srv.url, apiKey: 'k', model: 'm', trustedMode: true })
    store.updateAssistant(store.state.assistants[0].id, { name: '协调者' })
    for (const n of names) store.createAssistant(n)
    const host = new DefaultToolHost({ store, computer: new ComputerController(computerDeps()) })
    const agent = new Agent({ store, emit: () => {}, tools: host })
    const tasks = new TaskManager({ store, agent, emit: () => {} })
    host.tasks = tasks
    const id = (n: string) => store.state.assistants.find((a) => a.name === n)!.id
    return { store, agent, tasks, host, id }
  }

  const nameOf = (body: any) => String(body.messages[0].content).match(/你是名为「(.+?)」/)?.[1]

  it('coordinator delegates to 3 agents that run in parallel; results are aggregated', async () => {
    const spans: Record<string, { start: number; end: number }> = {}
    const ctx = await setup(async (body, _q, res) => {
      const who = nameOf(body)
      const tools = (body.messages as any[]).filter((m) => m.role === 'tool')
      if (who === '协调者') {
        if (!tools.length) {
          expect(body.messages[0].content).toContain('多智能体协作')
          return sse(
            res,
            toolCallChunks([
              {
                id: 'd1',
                name: 'delegate_to_agent',
                args: { tasks: ['甲', '乙', '丙'].map((n, i) => ({ agent: n, title: `部分${i + 1}`, prompt: `WORK ${i + 1}` })) }
              }
            ])
          )
        }
        return sse(res, textChunks('汇总：' + tools[0].content.replace(/\n/g, ' | ')))
      }
      expect(body.messages[0].content).toContain('协调者「协调者」委派')
      spans[who!] = { start: Date.now(), end: 0 }
      await sleep(400)
      spans[who!].end = Date.now()
      return sse(res, textChunks(`${who}的结果`))
    }, ['甲', '乙', '丙'])
    const r = await ctx.agent.run(ctx.id('协调者'), { text: '大任务' })
    expect(Object.keys(spans).sort()).toEqual(['丙', '乙', '甲'])
    const starts = Object.values(spans).map((s) => s.start)
    const ends = Object.values(spans).map((s) => s.end)
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends)) // 三个时间段互相重叠
    expect(r.text).toContain('3 个子任务并行执行，3 个成功')
    for (const n of ['甲', '乙', '丙']) expect(r.text).toContain(`${n}的结果`)
    const group = ctx.store.tasks.filter((t) => t.parentAssistantId === ctx.id('协调者'))
    expect(group).toHaveLength(3)
    expect(new Set(group.map((t) => t.groupId)).size).toBe(1)
    // 委派任务不会在执行者的聊天中触发跟进总结
    expect(ctx.store.getMessages(ctx.id('甲'))).toHaveLength(0)
  })

  it('runs 10 agents at once with the default limit of 10', async () => {
    let active = 0
    let maxActive = 0
    const ctx = await setup(async (_b, _q, res) => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(300)
      active--
      return sse(res, textChunks('ok'))
    }, ['甲'])
    expect(ctx.store.settings.maxConcurrentAgents).toBe(10)
    const done = await ctx.tasks.delegate(ctx.id('协调者'), Array.from({ length: 12 }, (_, i) => ({ assistantId: ctx.id('甲'), title: 't' + i, prompt: 'p' })))
    expect(done.every((t) => t.status === 'done')).toBe(true)
    expect(maxActive).toBe(10)
  })

  it('respects the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const ctx = await setup(async (_b, _q, res) => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(200)
      active--
      return sse(res, textChunks('ok'))
    }, ['甲'])
    ctx.store.updateSettings({ maxConcurrentAgents: 2 })
    const done = await ctx.tasks.delegate(ctx.id('协调者'), [1, 2, 3, 4].map((i) => ({ assistantId: ctx.id('甲'), title: 't' + i, prompt: 'p' })))
    expect(done.every((t) => t.status === 'done')).toBe(true)
    expect(maxActive).toBe(2)
  })

  it('two agents contending for the screen are serialised; non-GUI work stays parallel', async () => {
    const seq = ['computer_screenshot', 'mouse_move', 'mouse_click']
    const ctx = await setup(async (body, _q, res) => {
      const n = (body.messages as any[]).filter((m) => m.role === 'tool').length
      await sleep(120)
      if (n < seq.length) return sse(res, toolCallChunks([{ id: 'c' + n + Math.random(), name: seq[n], args: { x: 1, y: 1 } }]))
      return sse(res, textChunks('done'))
    }, ['甲'])
    const a = ctx.id('协调者')
    const b = ctx.id('甲')
    const t0 = Date.now()
    await Promise.all([ctx.agent.run(a, { text: 'A', autoApproveAll: true }), ctx.agent.run(b, { text: 'B', autoApproveAll: true })])
    const elapsed = Date.now() - t0
    const h = ctx.agent.screen.history
    expect(h.map((x) => x.owner).sort()).toEqual([a, b].sort())
    const [first, second] = [...h].sort((x, y) => x.acquiredAt - y.acquiredAt)
    expect(second.acquiredAt).toBeGreaterThanOrEqual(first.releasedAt!) // 互斥
    expect(second.acquiredAt - second.requestedAt).toBeGreaterThan(100) // 第二个确实排队等待过
    // 第一次模型请求（非 GUI）是并行的：总耗时小于完全串行
    expect(elapsed).toBeLessThan(2 * 4 * 120 + 200)
    expect(ctx.agent.screen.owner).toBe(null)
  })
})
