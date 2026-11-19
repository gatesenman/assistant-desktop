import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Store } from '../src/main/core/store'
import { Agent, buildSystemPrompt } from '../src/main/core/agent'
import { Scheduler, isValidCron } from '../src/main/core/scheduler'
import type { AppEvent } from '../src/shared/types'
import { startServer, sse, textChunks, toolCallChunks, type MockServer } from './helpers'

let dir: string
let srv: MockServer | null = null
let store: Store
let events: AppEvent[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'))
  store = new Store(dir)
  events = []
})
afterEach(async () => {
  await srv?.close()
  srv = null
  fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): { agent: Agent; aid: string } {
  store.updateSettings({ baseUrl: srv!.url + '/v1', apiKey: 'k', model: 'mock', workDir: dir })
  const agent = new Agent({ store, emit: (e) => events.push(e) })
  return { agent, aid: store.state.assistants[0].id }
}

describe('store', () => {
  it('creates default assistant and persists', () => {
    expect(store.state.assistants).toHaveLength(1)
    const a = store.createAssistant('编程助手')
    store.addMemory(a.id, '用户使用 TypeScript')
    store.createRoutine({ assistantId: a.id, name: 'r', cron: '0 9 * * *', prompt: 'p', enabled: true })
    store.getMessages(a.id).push({ id: 'm', role: 'user', content: 'hi', createdAt: 1 })
    store.saveMessages(a.id)
    const s2 = new Store(dir)
    expect(s2.state.assistants.map((x) => x.name)).toEqual(['小助手', '编程助手'])
    expect(s2.getAssistant(a.id)!.memory[0].text).toBe('用户使用 TypeScript')
    expect(s2.state.routines).toHaveLength(1)
    expect(s2.getMessages(a.id)[0].content).toBe('hi')
    s2.deleteAssistant(a.id)
    expect(new Store(dir).state.routines).toHaveLength(0)
  })

  it('injects memory into system prompt', () => {
    const a = store.state.assistants[0]
    store.addMemory(a.id, '用户名叫小明')
    expect(buildSystemPrompt(store.getAssistant(a.id)!, '/w')).toContain('- 用户名叫小明')
  })
})

describe('agent loop', () => {
  it('streams a plain answer and persists messages', async () => {
    srv = await startServer((_b, _q, res) => sse(res, textChunks('你好！我是助手。')))
    const { agent, aid } = setup()
    const r = await agent.run(aid, { text: '你好' })
    expect(r.text).toBe('你好！我是助手。')
    expect(events.some((e) => e.type === 'message-delta')).toBe(true)
    expect(events.filter((e) => e.type === 'run-state').map((e: any) => e.running)).toEqual([true, false])
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chats', aid + '.json'), 'utf8'))
    expect(saved.map((m: any) => m.role)).toEqual(['user', 'assistant'])
    expect(srv.requests[0].body.messages[0].role).toBe('system')
  })

  it('runs auto-approved tools + save_memory then answers; memory appears in next prompt', async () => {
    srv = await startServer((_b, _q, res, n) => {
      if (n === 1)
        return sse(res, toolCallChunks([
          { id: 'c1', name: 'save_memory', args: { text: '用户喜欢猫' } },
          { id: 'c2', name: 'list_dir', args: {} }
        ]))
      return sse(res, textChunks('好的，已记住。'))
    })
    const { agent, aid } = setup()
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'x')
    const r = await agent.run(aid, { text: '记住我喜欢猫，并看看目录' })
    expect(r.text).toBe('好的，已记住。')
    expect(store.getAssistant(aid)!.memory.map((m) => m.text)).toEqual(['用户喜欢猫'])
    const second = srv.requests[1].body.messages
    expect(second[0].content).toContain('用户喜欢猫')
    const toolMsgs = second.filter((m: any) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[1].content).toContain('marker.txt')
    const msgs = store.getMessages(aid)
    const asst = msgs.find((m) => m.toolCalls)!
    expect(asst.toolCalls!.map((t) => t.status)).toEqual(['done', 'done'])
  })

  it('waits for approval on run_shell and executes when approved', async () => {
    srv = await startServer((_b, _q, res, n) => {
      if (n === 1) return sse(res, toolCallChunks([{ id: 'sh1', name: 'run_shell', args: { command: 'echo approved-run' } }]))
      return sse(res, textChunks('命令完成'))
    })
    const { agent, aid } = setup()
    const p = agent.run(aid, { text: '执行 echo' })
    // 等待审批事件
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === 'message-upsert' && e.message.toolCalls?.[0]?.status === 'awaiting')) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(events.some((e) => e.type === 'message-upsert' && e.message.toolCalls?.[0]?.status === 'awaiting')).toBe(true)
    agent.respondApproval('sh1', true)
    const r = await p
    expect(r.text).toBe('命令完成')
    const tc = store.getMessages(aid).find((m) => m.toolCalls)!.toolCalls![0]
    expect(tc.status).toBe('done')
    expect(tc.result).toContain('approved-run')
  })

  it('reports denial to the model', async () => {
    srv = await startServer((_b, _q, res, n) => {
      if (n === 1) return sse(res, toolCallChunks([{ id: 'w1', name: 'write_file', args: { path: 'x.txt', content: 'x' } }]))
      return sse(res, textChunks('好的，不写了'))
    })
    const { agent, aid } = setup()
    const p = agent.run(aid, { text: '写文件' })
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'message-upsert' && e.message.toolCalls?.[0]?.status === 'awaiting'); i++)
      await new Promise((r) => setTimeout(r, 20))
    agent.respondApproval('w1', false)
    await p
    expect(fs.existsSync(path.join(dir, 'x.txt'))).toBe(false)
    const toolMsg = srv.requests[1].body.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('拒绝')
  })

  it('stop aborts streaming', async () => {
    srv = await startServer((_b, _q, res) => sse(res, textChunks('慢'.repeat(40), 40), 50))
    const { agent, aid } = setup()
    const p = agent.run(aid, { text: 'go' })
    await new Promise((r) => setTimeout(r, 200))
    expect(agent.isRunning(aid)).toBe(true)
    agent.stop(aid)
    await p
    expect(agent.isRunning(aid)).toBe(false)
    const last = store.getMessages(aid).at(-1)!
    expect(last.stopped).toBe(true)
    expect(last.streaming).toBe(false)
  })

  it('records API errors on the message', async () => {
    srv = await startServer((_b, _q, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    const { agent, aid } = setup()
    const r = await agent.run(aid, { text: 'x' })
    expect(r.error).toMatch(/500/)
    expect(store.getMessages(aid).at(-1)!.error).toMatch(/boom/)
  })
})

describe('scheduler', () => {
  it('validates cron', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/5 * * * * *')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('')).toBe(false)
  })

  it('runs a routine, posts into chat and notifies', async () => {
    srv = await startServer((_b, _q, res) => sse(res, textChunks('今日摘要：一切正常')))
    const { agent, aid } = setup()
    const done: any[] = []
    const sched = new Scheduler({ store, agent, onRoutineDone: (r, name, text, err) => done.push({ r: r.name, name, text, err }) })
    const r = store.createRoutine({ assistantId: aid, name: '每日摘要', cron: '* * * * * *', prompt: '总结今天', enabled: true })
    sched.sync()
    expect(sched.scheduledCount).toBe(1)
    // 每秒触发一次的 cron：等待真实调度触发
    for (let i = 0; i < 60 && done.length === 0; i++) await new Promise((x) => setTimeout(x, 100))
    sched.stopAll()
    await agent.waitIdle(aid)
    expect(done[0]).toMatchObject({ r: '每日摘要', name: '小助手', text: '今日摘要：一切正常' })
    const msgs = store.getMessages(aid)
    expect(msgs[0]).toMatchObject({ role: 'user', source: 'routine', routineName: '每日摘要', content: '总结今天' })
    expect(store.state.routines.find((x) => x.id === r.id)!.lastStatus).toBe('ok')
  })
})
