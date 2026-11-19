import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ComputerController, parseKeyCombo, type ComputerDeps, type InputDriver } from '../src/main/core/computer'
import { CrashGuard } from '../src/main/core/crash'
import { Store } from '../src/main/core/store'
import { Agent } from '../src/main/core/agent'
import { DefaultToolHost } from '../src/main/core/toolhost'
import type { AppEvent, ComputerLogEntry } from '../src/shared/types'
import { startServer, sse, textChunks, toolCallChunks, type MockServer } from './helpers'

function mockDeps(): { deps: ComputerDeps; calls: string[] } {
  const calls: string[] = []
  const driver: InputDriver = {
    size: async () => ({ width: 2560, height: 1440 }),
    move: async (x, y) => void calls.push(`move ${x},${y}`),
    click: async (b, d) => void calls.push(`click ${b}${d ? ' double' : ''}`),
    drag: async (a, b, c, d) => void calls.push(`drag ${a},${b}->${c},${d}`),
    scroll: async (dir, n) => void calls.push(`scroll ${dir} ${n}`),
    type: async (t) => void calls.push(`type ${t}`),
    keys: async (k) => void calls.push(`keys ${k.join('+')}`),
    windows: async () => ['终端', 'Editor'],
    focus: async (t) => t === 'Editor'
  }
  const deps: ComputerDeps = {
    capture: async () => ({ jpeg: Buffer.from('big'), thumb: Buffer.from('small'), width: 1280, height: 720 }),
    driver: async () => driver,
    openApp: async (n, a) => {
      calls.push(`open ${n} ${a.join(' ')}`)
      return `已启动 ${n}`
    },
    openUrl: async (u) => void calls.push(`url ${u}`),
    settleMs: 0
  }
  return { deps, calls }
}

describe('ComputerController', () => {
  it('scales screenshot coordinates to screen coordinates and clamps', async () => {
    const { deps, calls } = mockDeps()
    const c = new ComputerController(deps)
    const shot = await c.execute('computer_screenshot', {})
    expect(shot.text).toContain('1280x720')
    expect(shot.images?.[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(shot.thumb).toBe('data:image/jpeg;base64,' + Buffer.from('small').toString('base64'))
    const r = await c.execute('mouse_click', { x: 640, y: 360 })
    expect(calls).toEqual(['move 1280,720', 'click left'])
    expect(r.text).toContain('单击 (640, 360)')
    expect(r.images).toHaveLength(1) // 动作后自动截图
    expect(r.thumb).toBeTruthy()
    expect(await c.toScreen(5000, -10)).toEqual({ x: 2559, y: 0 })
  })

  it('supports all action kinds', async () => {
    const { deps, calls } = mockDeps()
    const c = new ComputerController(deps)
    await c.execute('mouse_double_click', { x: 10, y: 10 })
    await c.execute('mouse_right_click', { x: 10, y: 10 })
    await c.execute('mouse_drag', { x: 0, y: 0, to_x: 100, to_y: 50 })
    await c.execute('scroll', { direction: 'up', amount: 3 })
    await c.execute('type_text', { text: '你好 abc' })
    await c.execute('key_press', { keys: 'Ctrl + Shift+T' })
    await c.execute('open_app', { name: 'xterm', args: ['-e', 'top'] })
    await c.execute('open_url', { url: 'https://example.com' })
    expect(calls).toEqual([
      'move 20,20',
      'click left double',
      'move 20,20',
      'click right',
      'drag 0,0->200,100',
      'scroll up 3',
      'type 你好 abc',
      'keys ctrl+shift+t',
      'open xterm -e top',
      'url https://example.com'
    ])
    expect((await c.execute('list_windows', {})).text).toBe('1. 终端\n2. Editor')
    expect((await c.execute('focus_window', { title: 'Editor' })).text).toContain('已切换')
    await expect(c.execute('focus_window', { title: 'nope' })).rejects.toThrow('没有找到')
    await expect(c.execute('open_url', { url: 'file:///etc/passwd' })).rejects.toThrow('http')
    await expect(c.execute('mouse_click', { x: 'a', y: 1 })).rejects.toThrow('坐标无效')
  })

  it('parses key combos', () => {
    expect(parseKeyCombo('ctrl+c')).toEqual(['ctrl', 'c'])
    expect(parseKeyCombo(' Alt + F4 ')).toEqual(['alt', 'f4'])
  })
})

describe('computer use in the agent', () => {
  let dir: string
  let srv: MockServer | null = null
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-'))
  })
  afterEach(async () => {
    await srv?.close()
    srv = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function setup(handler: Parameters<typeof startServer>[0]) {
    return startServer(handler).then((s) => {
      srv = s
      const store = new Store(dir)
      store.updateSettings({ baseUrl: s.url, apiKey: 'k', model: 'm' })
      const { deps, calls } = mockDeps()
      const logs: ComputerLogEntry[] = []
      const events: AppEvent[] = []
      const sessions: boolean[] = []
      const host = new DefaultToolHost({ store, computer: new ComputerController(deps), onComputerLog: (e) => logs.push(e) })
      const agent = new Agent({ store, emit: (e) => events.push(e), tools: host, onComputerSession: (a) => sessions.push(a) })
      return { store, agent, host, calls, logs, events, sessions, aid: store.state.assistants[0].id }
    })
  }

  it('requires approval for actions unless trusted mode; screenshots auto-approved', async () => {
    const { store, host } = await setup(() => undefined)
    expect(host.defs({ isTask: false }).some((d) => d.function.name === 'mouse_click')).toBe(true)
    expect(host.needsApproval('computer_screenshot')).toBe(false)
    expect(host.needsApproval('mouse_click')).toBe(true)
    expect(host.needsApproval('type_text')).toBe(true)
    store.updateSettings({ trustedMode: true })
    expect(host.needsApproval('mouse_click')).toBe(false)
    expect(host.needsApproval('run_shell')).toBe(true) // 信任模式只影响电脑控制工具
    store.updateSettings({ computerEnabled: false })
    expect(host.defs({ isTask: false }).some((d) => d.function.name === 'mouse_click')).toBe(false)
  })

  it('runs a screenshot→click→type loop unattended, logs each step, fires session callbacks', async () => {
    const script = [
      { name: 'computer_screenshot', args: {} },
      { name: 'mouse_click', args: { x: 100, y: 50 } },
      { name: 'type_text', args: { text: 'hello' } }
    ]
    const ctx = await setup((body, _q, res) => {
      const toolMsgs = (body.messages as any[]).filter((m) => m.role === 'tool').length
      if (toolMsgs < script.length) {
        const s = script[toolMsgs]
        return sse(res, toolCallChunks([{ id: 'c' + toolMsgs, name: s.name, args: s.args }]))
      }
      // 最后一次请求中应包含截图（作为图片注入）
      const hasImage = (body.messages as any[]).some((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))
      return sse(res, textChunks(hasImage ? '完成，已看到截图' : '没有截图'))
    })
    const r = await ctx.agent.run(ctx.aid, { text: '帮我操作电脑', autoApproveAll: true })
    expect(r.text).toBe('完成，已看到截图')
    expect(ctx.calls).toEqual(['move 200,100', 'click left', 'type hello'])
    expect(ctx.logs.map((l) => l.tool)).toEqual(['computer_screenshot', 'mouse_click', 'type_text'])
    expect(ctx.logs.every((l) => l.ok && l.thumb)).toBe(true)
    expect(ctx.sessions).toEqual([true, false])
    expect(ctx.agent.computerActive).toBe(false)
  })

  it('emergency stop aborts an in-progress computer loop and marks the message', async () => {
    const ctx = await setup((body, _q, res) => {
      const n = (body.messages as any[]).filter((m) => m.role === 'tool').length
      return sse(res, toolCallChunks([{ id: 's' + n, name: 'scroll', args: { direction: 'down', amount: 1 } }]), 30)
    })
    ctx.store.updateSettings({ trustedMode: true, computerMaxSteps: 500, maxToolSteps: 500 })
    const p = ctx.agent.run(ctx.aid, { text: '一直滚动', autoApproveAll: true })
    await new Promise((r) => setTimeout(r, 400))
    expect(ctx.agent.computerActive).toBe(true)
    expect(ctx.agent.emergencyStop('已紧急停止')).toBe(1)
    await p
    expect(ctx.agent.computerActive).toBe(false)
    expect(ctx.sessions).toEqual([true, false])
    const last = [...ctx.store.getMessages(ctx.aid)].reverse().find((m) => m.role === 'assistant')!
    expect(last.stopped).toBe(true)
    expect(last.stopReason).toBe('已紧急停止')
    expect(ctx.calls.length).toBeGreaterThan(0)
    expect(ctx.calls.length).toBeLessThan(100)
  })

  it('raises the step limit once computer tools are used', async () => {
    const ctx = await setup((body, _q, res) => {
      const n = (body.messages as any[]).filter((m) => m.role === 'tool').length
      if (!body.tools) return sse(res, textChunks(`stopped at ${n}`))
      return sse(res, toolCallChunks([{ id: 'x' + n, name: 'computer_screenshot', args: {} }]))
    })
    ctx.store.updateSettings({ maxToolSteps: 3, computerMaxSteps: 7, planAutoConfirm: true })
    const r = await ctx.agent.run(ctx.aid, { text: 'go' })
    expect(r.text).toBe('stopped at 7')
  })
})

describe('CrashGuard', () => {
  it('relaunches with a rate limit and logs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'))
    let t = 1_000_000
    const relaunches: string[][] = []
    const g = () => new CrashGuard(dir, { relaunch: (a) => relaunches.push(a), argv: ['app', '--hidden'], enabled: true, now: () => t })
    for (let i = 0; i < 4; i++) {
      g().handleFatal(new Error('boom ' + i))
      t += 1000
    }
    expect(relaunches).toHaveLength(3)
    expect(relaunches[0]).toEqual(['app', '--hidden', '--crash-restarted'])
    const log = fs.readFileSync(path.join(dir, 'crash.log'), 'utf8')
    expect(log).toContain('boom 3')
    expect(log).toContain('不再重启')
    t += 11 * 60_000
    expect(g().handleFatal(new Error('later'))).toBe(true)
    const s = g()
    s.markStart()
    expect(fs.readFileSync(path.join(dir, 'startup.log'), 'utf8')).toContain(`"pid":${process.pid}`)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
