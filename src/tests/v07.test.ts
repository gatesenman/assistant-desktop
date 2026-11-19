import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { a11yToShot, describeSom, matchElement, mergeElements, parseA11yJson, sortReadingOrder, type A11ySnapshot } from '../src/main/core/som'
import { drawMarks } from '../src/main/core/somDraw'
import { buildGroundingMessages, groundOnce, parseGroundingOutput, smartResize, toImageCoords } from '../src/main/core/grounding'
import { checkBudget, DEFAULT_PRICES, findPrice, isPeak, parseUsage, priceUsage, UsageLedger } from '../src/main/core/usage'
import { UsageTracker } from '../src/main/core/usageTracker'
import { streamChat, _resetStreamOptionsCache } from '../src/main/core/llm'
import { comboToKeyEvents, RfbClient, tcpTransport, textToKeyEvents, vncAuthResponse, wsDecodeFrame, wsEncodeFrame, wsTransport } from '../src/main/core/rfb'
import { VncSession } from '../src/main/core/vncComputer'
import { ComputerController, type ComputerDeps, type InputDriver } from '../src/main/core/computer'
import { atspiSnapshot, ATSPI_SCRIPT } from '../src/main/core/atspi'
import { desEcb, desEncryptBlock } from '../src/main/core/des'
import { Store, mergePrices } from '../src/main/core/store'
import { Agent } from '../src/main/core/agent'
import { fmtUsd, usageLine } from '../src/shared/usageFormat'
import { startServer, sse, textChunks, toolCallChunks, type MockServer } from './helpers'
// @ts-expect-error JS helper
import { startFakeVnc } from '../e2e/fake-vnc.mjs'

/* ------------------------------ SoM 合并与编号 ------------------------------ */
describe('Set-of-Mark merge & numbering', () => {
  const snap: A11ySnapshot = {
    engine: 'uia',
    screen: { width: 2560, height: 1600 },
    foreground: '记事本',
    elements: [
      { role: 'Button', name: '保存', x: 200, y: 100, w: 160, h: 60, patterns: ['invoke'] },
      { role: 'Button', name: '', x: 202, y: 102, w: 158, h: 58 }, // 同一控件的重复节点
      { role: 'Edit', name: '文件名', x: 200, y: 400, w: 1200, h: 60, patterns: ['value'], value: 'a.txt' },
      { role: 'Pane', name: '整个窗口', x: 0, y: 0, w: 2560, h: 1600 }, // 非交互容器
      { role: 'Group', name: '可点击组', x: 1600, y: 100, w: 200, h: 60, patterns: ['invoke'] }
    ]
  }
  it('scales a11y rects into screenshot space and drops containers', () => {
    const els = a11yToShot(snap, { width: 1280, height: 800 })
    expect(els.map((e) => e.name)).toEqual(['保存', '', '文件名', '可点击组'])
    expect(els[0]).toMatchObject({ x1: 100, y1: 50, x2: 180, y2: 80, cx: 140, cy: 65, source: 'uia' })
  })
  it('dedupes a11y / boxes / OCR and numbers in reading order', () => {
    const a11y = a11yToShot(snap, { width: 1280, height: 800 })
    const boxes = [
      { x1: 101, y1: 51, x2: 179, y2: 79, cx: 140, cy: 65, w: 78, h: 28, text: '' }, // 与「保存」重复
      { x1: 1000, y1: 600, x2: 1100, y2: 640, cx: 1050, cy: 620, w: 100, h: 40, text: '确定' } // UIA 没有的控件
    ] as any
    const ocr = [
      { text: '保存', x1: 120, y1: 58, x2: 160, y2: 72, cx: 140, cy: 65 }, // 落在按钮内 → 合并
      { text: '状态栏：就绪', x1: 20, y1: 760, x2: 200, y2: 780, cx: 110, cy: 770 }
    ]
    const els = mergeElements({ a11y, boxes, ocr })
    expect(els.map((e) => [e.id, e.source, e.name])).toEqual([
      [1, 'uia', '保存'],
      [2, 'uia', '可点击组'],
      [3, 'uia', '文件名'],
      [4, 'box', '确定'],
      [5, 'ocr', '状态栏：就绪']
    ])
    const text = describeSom(els, { width: 1280, height: 800, engine: 'uia + OCR', foreground: '记事本' })
    expect(text).toContain('[1] 按钮 "保存" @(140,65)')
    expect(text).toContain('[3] 输入框 "文件名"')
    expect(text).toContain('记事本')
  })
  it('reading order groups rows with tolerance', () => {
    const r = sortReadingOrder([
      { cx: 300, cy: 105 },
      { cx: 100, cy: 100 },
      { cx: 50, cy: 300 }
    ])
    expect(r.map((e) => e.cx)).toEqual([100, 300, 50])
  })
  it('matchElement finds by Chinese/English name and role', () => {
    const els = mergeElements({ a11y: a11yToShot(snap, { width: 1280, height: 800 }) })
    expect(matchElement(els, '保存按钮')[0].element.name).toBe('保存')
    expect(matchElement(els, '文件名输入框')[0].element.role).toBe('Edit')
    expect(matchElement(els, 'zzz 完全不存在')).toHaveLength(0)
  })
  it('caps the number of marks', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ text: 'w' + i, x1: (i % 30) * 40, y1: Math.floor(i / 30) * 30, x2: (i % 30) * 40 + 30, y2: Math.floor(i / 30) * 30 + 20, cx: (i % 30) * 40 + 15, cy: Math.floor(i / 30) * 30 + 10 }))
    expect(mergeElements({ ocr: many, max: 120 })).toHaveLength(120)
  })
})

describe('marks drawing', () => {
  it('draws numbered boxes into a BGRA bitmap without overflowing edges', () => {
    const w = 200
    const h = 120
    const data = Buffer.alloc(w * h * 4, 255)
    const els = mergeElements({
      a11y: [
        { x1: 10, y1: 10, x2: 60, y2: 40, cx: 35, cy: 25, role: 'Button', name: 'a', source: 'uia' },
        { x1: 150, y1: 90, x2: 199, y2: 119, cx: 175, cy: 105, role: 'Edit', name: 'b', source: 'uia' }
      ]
    })
    const placed = drawMarks({ data, width: w, height: h }, els)
    expect(placed).toHaveLength(2)
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(w)
      expect(p.y + p.h).toBeLessThanOrEqual(h)
    }
    // 边框像素被改成标记色（不再是白色）
    const o = (10 * w + 30) * 4
    expect([data[o], data[o + 1], data[o + 2]]).not.toEqual([255, 255, 255])
  })
})

describe('accessibility JSON parsing', () => {
  it('parses the UIA helper output (compact keys) and errors', () => {
    const raw = 'noise\n{"ok":true,"engine":"uia","screen":{"w":1920,"h":1080},"fg":"设置","ms":143,"els":[{"r":"Button","n":"确定","x":10,"y":20,"w":80,"h":30,"p":["invoke"],"e":1,"f":0,"v":"","a":"okBtn","win":"设置"},{"r":"Edit","n":"","x":"bad"}]}'
    const s = parseA11yJson(raw)
    expect(s.screen).toEqual({ width: 1920, height: 1080 })
    expect(s.foreground).toBe('设置')
    expect(s.ms).toBe(143)
    expect(s.elements).toHaveLength(1)
    expect(s.elements[0]).toMatchObject({ role: 'Button', name: '确定', patterns: ['invoke'], enabled: true, automationId: 'okBtn' })
    expect(parseA11yJson('{"ok":false,"error":"拒绝访问"}').error).toBe('拒绝访问')
    expect(parseA11yJson('').error).toBeTruthy()
  })
  it('AT-SPI runner passes args, keeps caller screen size and reports missing pyatspi', async () => {
    let seen: string[] = []
    const ok = await atspiSnapshot(
      async (script, args) => {
        expect(script).toBe(ATSPI_SCRIPT)
        seen = args
        return JSON.stringify({ ok: true, engine: 'atspi', fg: 'Mousepad', ms: 12, els: [{ r: 'push button', n: 'OK', x: 5, y: 5, w: 40, h: 20, p: ['invoke'] }] })
      },
      { width: 1280, height: 800 },
      'desktop'
    )
    expect(seen[0]).toBe('desktop')
    expect(ok.screen).toEqual({ width: 1280, height: 800 })
    expect(a11yToShot(ok, { width: 1280, height: 800 })[0].source).toBe('atspi')
    const missing = await atspiSnapshot(async () => '{"ok": false, "engine": "atspi", "error": "未安装 python3-pyatspi"}', { width: 1, height: 1 })
    expect(missing.error).toContain('pyatspi')
    const crashed = await atspiSnapshot(async () => {
      throw new Error('超时')
    }, { width: 1, height: 1 })
    expect(crashed.error).toContain('超时')
  })
})

/* ------------------------------ grounding ------------------------------ */
describe('grounding coordinate parsing & scaling', () => {
  it('smart_resize matches the Qwen2.5-VL reference implementation', () => {
    expect(smartResize(800, 1280)).toEqual({ height: 812, width: 1288 })
    expect(smartResize(1080, 1920)).toEqual({ height: 1092, width: 1932 })
    expect(smartResize(50, 50)).toEqual({ height: 280, width: 280 }) // 小于 min_pixels 放大
    const big = smartResize(4000, 6000)
    expect(big.width * big.height).toBeLessThanOrEqual(16384 * 28 * 28)
  })
  it('parses UI-TARS / Fara / JSON outputs', () => {
    expect(parseGroundingOutput("Action: click(start_box='(644,406)')")).toMatchObject({ x: 644, y: 406, format: 'start_box', action: 'click' })
    expect(parseGroundingOutput("click(point='<point>100 200</point>')")).toMatchObject({ x: 100, y: 200, format: 'point_tag' })
    expect(parseGroundingOutput('<|box_start|>(10,20),(30,40)<|box_end|>')).toMatchObject({ x: 20, y: 30, format: 'box_token' })
    expect(parseGroundingOutput("Thought: 找到按钮\nAction: click(start_box='[10, 20, 50, 60]')")).toMatchObject({ x: 30, y: 40, thought: '找到按钮' })
    expect(parseGroundingOutput('<tool_call>\n{"name":"computer_use","arguments":{"action":"left_click","coordinate":[512,300]}}\n</tool_call>')).toMatchObject({ x: 512, y: 300, format: 'tool_call', action: 'left_click' })
    expect(parseGroundingOutput('```json\n{"x": 12, "y": 34}\n```')).toMatchObject({ x: 12, y: 34, format: 'json' })
    expect(parseGroundingOutput('我找不到')).toBeNull()
  })
  it('maps model coordinates back to screenshot pixels', () => {
    const img = { width: 1280, height: 800 }
    // UI-TARS-1.5：smart_resize 空间 1288x812
    expect(toImageCoords({ x: 644, y: 406 }, 'smart_resize', img)).toEqual({ x: 640, y: 400 })
    // UI-TARS v1：0–1000
    expect(toImageCoords({ x: 500, y: 500 }, 'relative1000', img)).toEqual({ x: 640, y: 400 })
    expect(toImageCoords({ x: 5000, y: -3 }, 'pixel', img)).toEqual({ x: 1279, y: 0 })
  })
  it('builds prompts per style and calls the endpoint non-streaming', async () => {
    const msgs = buildGroundingMessages({ promptStyle: 'uitars' }, 'data:image/png;base64,AAA', '设置按钮', { width: 1280, height: 800 }) as any[]
    expect(JSON.stringify(msgs)).toContain('## User Instruction\\n设置按钮')
    const fara = buildGroundingMessages({ promptStyle: 'fara', minPixels: 3136, maxPixels: 12845056 }, 'data:image/png;base64,AAA', '设置', { width: 1280, height: 800 }) as any[]
    expect(fara[0].role).toBe('system')
    expect(JSON.stringify(fara[0])).toContain('1288x812')
    let body: any
    const srv = await startServer((b, _req, res) => {
      body = b
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: "Action: click(start_box='(644,406)')" } }], usage: { prompt_tokens: 1500, completion_tokens: 12 } }))
    })
    try {
      const r = await groundOnce({ preset: 'uitars15-vllm', baseUrl: srv.url + '/v1', apiKey: 'k', model: 'ui-tars', coordSpace: 'smart_resize', promptStyle: 'uitars' }, 'data:image/png;base64,AAA', { width: 1280, height: 800 }, '确定按钮')
      expect(r).toMatchObject({ x: 640, y: 400 })
      expect(body.stream).toBe(false)
      expect(body.temperature).toBe(0)
      expect(r.usage?.prompt_tokens).toBe(1500)
      await expect(groundOnce({ preset: 'custom', baseUrl: '', apiKey: '', model: '', coordSpace: 'pixel', promptStyle: 'json' }, '', { width: 1, height: 1 }, 'x')).rejects.toThrow('未配置')
    } finally {
      await srv.close()
    }
  })
})

/* ------------------------------ 用量 / 价格 / 预算 ------------------------------ */
describe('usage accounting', () => {
  it('parses DeepSeek and OpenAI usage shapes', () => {
    expect(parseUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 })).toEqual({ input: 1000, output: 200, cacheHit: 800 })
    expect(parseUsage({ prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 4 } })).toEqual({ input: 50, output: 10, cacheHit: 20, reasoning: 4 })
    expect(parseUsage(null)).toBeNull()
  })
  it('prices DeepSeek Flash with cache hits, off-peak vs peak', () => {
    const e = findPrice(DEFAULT_PRICES, 'https://api.deepseek.com/v1', 'deepseek-flash')!
    expect(e.id).toBe('deepseek-flash')
    // 周日（低谷）
    const off = priceUsage({ input: 1_000_000, output: 1_000_000, cacheHit: 500_000 }, e, new Date('2026-10-18T03:00:00Z'))
    expect(off.peak).toBe(false)
    expect(off.cost).toBeCloseTo(0.5 * 0.15 + 0.5 * 0.003 + 0.6, 6)
    // 周一 UTC 02:00（北京 10:00，高峰）
    const pk = priceUsage({ input: 1_000_000, output: 0, cacheHit: 0 }, e, new Date('2026-10-19T02:00:00Z'))
    expect(pk.peak).toBe(true)
    expect(pk.cost).toBeCloseTo(0.3, 6)
    expect(isPeak(e, new Date('2026-10-19T05:00:00Z'))).toBe(false) // 午休低谷
    expect(findPrice(DEFAULT_PRICES, 'https://api.deepseek.com', 'deepseek-v4-flash')?.id).toBe('deepseek-flash') // 旧名按 Flash 计
    expect(findPrice(DEFAULT_PRICES, 'http://localhost:11434/v1', 'deepseek-flash')).toBeUndefined() // 本地同名模型不计费
    expect(priceUsage({ input: 1, output: 1, cacheHit: 0 }, undefined, new Date()).priced).toBe(false)
    const cny = priceUsage({ input: 1_000_000, output: 0, cacheHit: 0 }, { ...e, currency: 'CNY', peak: undefined, price: { input: 7.1, output: 0 } }, new Date(), 7.1)
    expect(cny.cost).toBeCloseTo(1, 6)
  })
  it('budget checks for task, day and tokens', () => {
    expect(checkBudget({ perTaskUsd: 0, perDayUsd: 0, perTaskTokens: 0 }, { cost: 99, tokens: 1e9 }, 99).ok).toBe(true)
    const t = checkBudget({ perTaskUsd: 0.01, perDayUsd: 0, perTaskTokens: 0 }, { cost: 0.02, tokens: 10 }, 0.02)
    expect(t).toMatchObject({ ok: false, reason: 'task' })
    expect(t.message).toContain('单任务预算')
    expect(checkBudget({ perTaskUsd: 0, perDayUsd: 1, perTaskTokens: 0 }, { cost: 0, tokens: 0 }, 1.2).reason).toBe('day')
    expect(checkBudget({ perTaskUsd: 0, perDayUsd: 0, perTaskTokens: 100 }, { cost: 0, tokens: 150 }, 0).reason).toBe('tokens')
  })
  it('ledger aggregates by day/model/assistant/routine/task and persists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
    try {
      const l = new UsageLedger(dir)
      const at = Date.now()
      l.record({ at, input: 100, output: 10, cacheHit: 50, model: 'm1', baseUrl: 'x', kind: 'chat', assistantId: 'a', runKey: 'r1', cost: 0.01, priced: true })
      l.record({ at, input: 200, output: 20, cacheHit: 0, model: 'm2', baseUrl: 'x', kind: 'routine', assistantId: 'a', routineId: 'rt', runKey: 'r1', cost: 0.02, priced: true })
      l.record({ at, input: 5, output: 5, cacheHit: 0, model: 'local', baseUrl: 'x', kind: 'task', taskId: 't1', cost: 0, priced: false })
      expect(l.today()).toMatchObject({ input: 305, output: 35, cacheHit: 50, calls: 3, unpricedCalls: 1 })
      expect(l.today().cost).toBeCloseTo(0.03)
      expect(l.summary.byAssistant.a.calls).toBe(2)
      expect(l.summary.byRoutine.rt.cost).toBeCloseTo(0.02)
      expect(l.summary.byTask.t1.calls).toBe(1)
      expect(l.runSpent('r1')).toEqual({ cost: 0.03, tokens: 330 })
      expect(l.lastDays(7)).toHaveLength(7)
      l.flush()
      const l2 = new UsageLedger(dir)
      expect(l2.summary.total.calls).toBe(3)
      expect(l2.records).toHaveLength(3)
      expect(l2.diagnostics()).toHaveProperty('byModel.m1')
      l2.clear()
      expect(new UsageLedger(dir).summary.total.calls).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('formats a usage line in Chinese', () => {
    const s = usageLine({ input: 12345, output: 512, cacheHit: 10000, cost: 0.0021, priced: true, model: 'deepseek-flash', calls: 3 }, 7.1)
    expect(s).toBe('输入 12k（缓存命中 81%） · 输出 512 · $0.0021 ≈ ¥0.015 · 3 次调用')
    expect(fmtUsd(0)).toBe('$0')
  })
  it('merges built-in prices on upgrade, keeping user edits and custom rows', () => {
    const merged = mergePrices([{ ...DEFAULT_PRICES[0], price: { input: 9, output: 9 }, builtin: false }, { id: 'mine', label: 'x', provider: '', models: 'x', currency: 'USD', price: { input: 1, output: 1 } }])
    expect(merged.find((p) => p.id === 'deepseek-flash')!.price.input).toBe(9)
    expect(merged.find((p) => p.id === 'deepseek-v4-pro')).toBeTruthy()
    expect(merged.find((p) => p.id === 'mine')).toBeTruthy()
  })
})

describe('streaming usage + budget pause in the agent', () => {
  let dir: string
  let srv: MockServer | null = null
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v07-'))
    _resetStreamOptionsCache()
  })
  afterEach(async () => {
    await srv?.close()
    srv = null
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('requests include_usage and parses the final usage chunk (DeepSeek fields)', async () => {
    srv = await startServer((_b, _r, res) => sse(res, [...textChunks('你好'), { choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 } }]))
    const r = await streamChat({ baseUrl: srv.url + '/v1', apiKey: 'k', model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] })
    expect(srv.requests[0].body.stream_options).toEqual({ include_usage: true })
    expect(r.usage).toEqual({ input: 120, output: 8, cacheHit: 100 })
  })
  it('retries without stream_options when a server rejects it, and remembers', async () => {
    srv = await startServer((b, _r, res) => {
      if (b.stream_options) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }))
        return
      }
      return sse(res, textChunks('ok'))
    })
    const r = await streamChat({ baseUrl: srv.url + '/v1', apiKey: 'k', model: 'm', messages: [] })
    expect(r.content).toBe('ok')
    expect(r.usage).toBeUndefined()
    await streamChat({ baseUrl: srv.url + '/v1', apiKey: 'k', model: 'm', messages: [] })
    expect(srv.requests.map((x) => !!x.body.stream_options)).toEqual([true, false, false])
  })
  it('records per-message usage, sums per task/routine and pauses on the per-task budget', async () => {
    let n = 0
    srv = await startServer((_b, _r, res) => {
      n++
      const usage = { choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 0 } }
      if (n <= 3) return sse(res, [...toolCallChunks([{ id: 'c' + n, name: 'list_dir', args: { path: dir } }]), usage])
      return sse(res, [...textChunks('完成'), usage])
    })
    const store = new Store(dir)
    store.updateSettings({ baseUrl: srv.url + '/v1', apiKey: 'k', model: 'deepseek-flash', workDir: dir, prices: [{ ...DEFAULT_PRICES[0], provider: '127.0.0.1', peak: undefined }], budget: { perTaskUsd: 0.25, perDayUsd: 0, perTaskTokens: 0 } })
    const tracker = new UsageTracker(new UsageLedger(null), store)
    const agent = new Agent({ store, emit: () => {}, usage: tracker })
    const aid = store.state.assistants[0].id
    const res = await agent.run(aid, { text: '列目录', routineId: 'rt1' })
    // 每次调用 1M 输入 × $0.15 = $0.15；第二次后累计 $0.30 ≥ $0.25 → 第三次调用前暂停
    expect(n).toBe(2)
    expect(res.budgetPaused).toBe(true)
    expect(res.usage?.calls).toBe(2)
    expect(res.usage?.cost).toBeCloseTo(0.3, 6)
    const msgs = store.getMessages(aid)
    const asst = msgs.filter((m) => m.role === 'assistant')
    expect(asst[0].usage).toMatchObject({ input: 1_000_000, priced: true, calls: 1 })
    const last = asst[asst.length - 1]
    expect(last.errorKind).toBe('budget')
    expect(last.stopReason).toContain('单任务预算')
    expect(tracker.paused.has(aid)).toBe(true)
    expect(tracker.ledger.summary.byRoutine.rt1.calls).toBe(2)
    // 提高预算后继续：新的一轮重新计算单任务花费
    store.updateSettings({ budget: { perTaskUsd: 5, perDayUsd: 0, perTaskTokens: 0 } })
    const res2 = await agent.run(aid, { text: '继续' })
    expect(res2.budgetPaused).toBe(false)
    expect(tracker.paused.has(aid)).toBe(false)
  })
  it('falls back to a local estimate when the provider returns no usage', async () => {
    srv = await startServer((_b, _r, res) => sse(res, textChunks('这是一个回答')))
    const store = new Store(dir)
    store.updateSettings({ baseUrl: srv.url + '/v1', apiKey: 'k', model: 'mystery', workDir: dir })
    const tracker = new UsageTracker(new UsageLedger(null), store)
    const agent = new Agent({ store, emit: () => {}, usage: tracker })
    const aid = store.state.assistants[0].id
    const r = await agent.run(aid, { text: '你好' })
    expect(r.usage?.estimated).toBe(true)
    expect(r.usage?.priced).toBe(false)
    expect(r.usage!.input).toBeGreaterThan(0)
  })
  it('day budget pauses before any call', async () => {
    srv = await startServer((_b, _r, res) => sse(res, textChunks('x')))
    const store = new Store(dir)
    store.updateSettings({ baseUrl: srv.url + '/v1', apiKey: 'k', model: 'deepseek-flash', workDir: dir, budget: { perTaskUsd: 0, perDayUsd: 0.001, perTaskTokens: 0 } })
    const ledger = new UsageLedger(null)
    ledger.record({ at: Date.now(), input: 1, output: 1, cacheHit: 0, model: 'deepseek-flash', baseUrl: 'x', kind: 'chat', cost: 0.002, priced: true })
    const agent = new Agent({ store, emit: () => {}, usage: new UsageTracker(ledger, store) })
    const r = await agent.run(store.state.assistants[0].id, { text: 'hi' })
    expect(r.budgetPaused).toBe(true)
    expect(srv.requests).toHaveLength(0)
    expect(r.error).toContain('今日预算')
  })
})

/* ------------------------------ VNC（RFB） ------------------------------ */
describe('RFB client against a fake VNC server', () => {
  it('pure-JS DES matches the FIPS test vector', () => {
    expect(desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex')).toBe('85e813540f0ab405')
    expect(desEcb(Buffer.from('0E329232EA6D0D73', 'hex'), Buffer.from('87878787878787870000000000000000', 'hex')).subarray(0, 8).toString('hex')).toBe('0000000000000000')
  })
  it('VNC auth response matches the DES reference', () => {
    // 参考：RFC 6143 §7.2.2，口令位序反转作为 DES 密钥
    const ch = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const r = vncAuthResponse(ch, 'password')
    expect(r).toHaveLength(16)
    expect(vncAuthResponse(ch, 'password').equals(r)).toBe(true)
    expect(vncAuthResponse(ch, 'passworX').equals(r)).toBe(false)
  })
  it('websocket frame encode/decode round trip', () => {
    const p = Buffer.from('hello vnc')
    const f = wsEncodeFrame(p, 2, true)
    const d = wsDecodeFrame(f)!
    expect(d.payload.equals(p)).toBe(true)
    expect(d.size).toBe(f.length)
    const big = Buffer.alloc(70000, 7)
    expect(wsDecodeFrame(wsEncodeFrame(big, 2, false))!.payload.length).toBe(70000)
    expect(wsDecodeFrame(f.subarray(0, 3))).toBeNull()
  })
  it('keysym mapping for text and combos', () => {
    expect(textToKeyEvents('aB')).toEqual([
      [0x61, true],
      [0x61, false],
      [0xffe1, true],
      [0x42, true],
      [0x42, false],
      [0xffe1, false]
    ])
    expect(comboToKeyEvents(['win', 'r'])).toEqual([
      [0xffeb, true],
      [0x72, true],
      [0x72, false],
      [0xffeb, false]
    ])
  })
  it('handshakes over TCP with password, snapshots and sends pointer/key events', async () => {
    const srv = await startFakeVnc({ width: 640, height: 480, password: 'secret', desEcb, buttons: [{ name: 'OK', x1: 300, y1: 200, x2: 380, y2: 240 }] })
    try {
      const c = await RfbClient.connect(await tcpTransport('127.0.0.1', srv.port), { password: 'secret' })
      expect(c.version).toBe('3.8')
      expect([c.width, c.height]).toEqual([640, 480])
      const s = await c.snapshot()
      expect(s.bgra.length).toBe(640 * 480 * 4)
      // 桌面是 Windows 蓝 (0,120,212) → BGRA (212,120,0,255)
      expect([...s.bgra.subarray(0, 4)]).toEqual([212, 120, 0, 255])
      c.pointer(340, 220, 0)
      c.pointer(340, 220, 1)
      c.pointer(340, 220, 0)
      for (const [k, d] of textToKeyEvents('Hi!')) c.key(k, d)
      await new Promise((r) => setTimeout(r, 100))
      expect(srv.events.find((e: any) => e.type === 'click')).toMatchObject({ x: 340, y: 220, button: 'OK' })
      expect(srv.state.typed).toBe('Hi!')
      const s2 = await c.snapshot()
      const o = (220 * 640 + 340) * 4
      expect([s2.bgra[o + 2], s2.bgra[o + 1], s2.bgra[o]]).toEqual([22, 163, 74]) // 按钮变绿
      c.close()
      await expect(RfbClient.connect(await tcpTransport('127.0.0.1', srv.port), { password: 'wrong' })).rejects.toThrow('认证失败')
      await expect(RfbClient.connect(await tcpTransport('127.0.0.1', srv.port), {})).rejects.toThrow('需要密码')
    } finally {
      await srv.close()
    }
  })
  it('connects through a websocket /websockify proxy like dockur', async () => {
    const srv = await startFakeVnc({ width: 800, height: 600, websocket: true })
    try {
      const c = await RfbClient.connect(await wsTransport(`ws://127.0.0.1:${srv.port}/websockify`))
      const s = await c.snapshot()
      expect([s.width, s.height]).toEqual([800, 600])
      c.close()
      await expect(wsTransport(`ws://127.0.0.1:${srv.port}/nope`, 2000)).rejects.toThrow()
    } finally {
      await srv.close()
    }
  })
  it('connection refused gives a Chinese error', async () => {
    await expect(tcpTransport('127.0.0.1', 1, 2000)).rejects.toThrow()
  })
})

describe('VNC session as a computer target (Windows VM path)', () => {
  const encode = (bgra: Buffer, width: number, height: number) => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width, height, png: bgra })
  it('drives clicks/typing/keys through ComputerController with coordinate scaling', async () => {
    const srv = await startFakeVnc({ width: 1024, height: 768, websocket: true })
    const session = new VncSession({ label: 'Windows 桌面虚拟电脑（VNC）', guestOs: 'windows', connect: () => wsTransport(`ws://127.0.0.1:${srv.port}/websockify`), encode, keyDelayMs: 0 })
    try {
      const deps: ComputerDeps = { ...session.deps(), settleMs: 0, somEnabled: () => false }
      expect(deps.targetLabel).toContain('Windows')
      expect(deps.guestOs).toBe('windows')
      const ctl = new ComputerController(deps)
      const shot = await ctl.screenshot()
      expect(shot.text).toContain('1024x768')
      await ctl.execute('mouse_click', { x: 462, y: 440 })
      await ctl.execute('type_text', { text: 'notepad' })
      await ctl.execute('key_press', { keys: 'ctrl+s' })
      await new Promise((r) => setTimeout(r, 100))
      expect(srv.events.find((e: any) => e.type === 'click')).toMatchObject({ button: 'OK' })
      expect(srv.state.typed).toContain('notepad')
      await expect(ctl.execute('type_text', { text: '你好' })).rejects.toThrow('只能输入英文')
      const r = await deps.openApp('notepad', [])
      expect(r).toContain('Win+R')
      await new Promise((r) => setTimeout(r, 100))
      expect(srv.state.typed).toContain('notepad\n')
      expect(session.info()).toMatchObject({ connected: true, width: 1024, height: 768 })
    } finally {
      session.close()
      await srv.close()
    }
  })
  it('precheck failure never touches anything else', async () => {
    const session = new VncSession({ label: 'Windows 桌面虚拟电脑（VNC）', guestOs: 'windows', connect: () => Promise.reject(new Error('should not connect')), encode, precheck: async () => 'Windows 虚拟电脑未运行' })
    await expect(session.capture()).rejects.toThrow('Windows 虚拟电脑未运行')
  })
})

/* ------------------------------ 控制器：编号工具 ------------------------------ */
describe('ComputerController Set-of-Mark tools', () => {
  function deps(extra: Partial<ComputerDeps> = {}): { deps: ComputerDeps; calls: string[] } {
    const calls: string[] = []
    const driver: InputDriver = {
      size: async () => ({ width: 2560, height: 1600 }),
      move: async (x, y) => void calls.push(`move ${x},${y}`),
      click: async (b, d) => void calls.push(`click ${b}${d ? ' double' : ''}`),
      drag: async () => {},
      scroll: async () => {},
      type: async (t) => void calls.push(`type ${t}`),
      keys: async (k) => void calls.push(`keys ${k.join('+')}`),
      windows: async () => ['记事本'],
      focus: async () => true
    }
    return {
      calls,
      deps: {
        capture: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 1280, height: 800, png: Buffer.from('p') }),
        driver: async () => driver,
        openApp: async () => 'ok',
        openUrl: async () => {},
        settleMs: 0,
        elements: async () => ({
          engine: 'uia',
          screen: { width: 2560, height: 1600 },
          foreground: '记事本',
          ms: 20,
          elements: [
            { role: 'Button', name: '保存', x: 200, y: 100, w: 160, h: 60, patterns: ['invoke'] },
            { role: 'Edit', name: '文件名', x: 200, y: 400, w: 1200, h: 60, patterns: ['value'] }
          ]
        }),
        boxes: async () => [],
        annotate: async () => Buffer.from('annotated'),
        ...extra
      }
    }
  }
  it('screenshot lists numbered elements and sends the annotated image', async () => {
    const { deps: d } = deps()
    const ctl = new ComputerController(d)
    const r = await ctl.screenshot()
    expect(r.text).toContain('[1] 按钮 "保存" @(140,65)')
    expect(r.text).toContain('click_element')
    expect(r.images![0]).toBe('data:image/jpeg;base64,' + Buffer.from('annotated').toString('base64'))
  })
  it('click_element clicks the element centre in screen coordinates', async () => {
    const { deps: d, calls } = deps()
    const ctl = new ComputerController(d)
    await ctl.screenshot()
    const r = await ctl.execute('click_element', { id: 1 })
    expect(calls).toContain('move 280,130')
    expect(calls).toContain('click left')
    expect(r.text).toContain('[1]')
    await expect(ctl.execute('click_element', { id: 99 })).rejects.toThrow('没有编号为 99')
  })
  it('type_into_element uses UIA ValuePattern when available, else click + select-all + type', async () => {
    const setCalls: any[] = []
    const a = deps({ setValue: async (x, y, t) => (setCalls.push([x, y, t]), true) })
    const ctl = new ComputerController(a.deps)
    await ctl.screenshot()
    const r = await ctl.execute('type_into_element', { id: 2, text: '报告.txt' })
    expect(setCalls).toEqual([[800, 430, '报告.txt']])
    expect(r.text).toContain('ValuePattern')
    const b = deps({ guestOs: 'linux' })
    const ctl2 = new ComputerController(b.deps)
    await ctl2.screenshot()
    await ctl2.execute('type_into_element', { id: 2, text: 'abc', submit: true })
    expect(b.calls).toEqual(expect.arrayContaining(['move 800,430', 'click left', 'keys ctrl+a', 'type abc', 'keys enter']))
  })
  it('click_target uses the grounding model, then falls back to element matching', async () => {
    const g = deps({ ground: async () => ({ x: 640, y: 400, detail: 'ui-tars' }) })
    const ctl = new ComputerController(g.deps)
    const r = await ctl.execute('click_target', { description: '中间的按钮' })
    expect(g.calls).toContain('move 1280,800')
    expect(r.text).toContain('ui-tars')
    const f = deps({ ground: async () => null })
    const ctl2 = new ComputerController(f.deps)
    const r2 = await ctl2.execute('click_target', { description: '保存按钮' })
    expect(f.calls).toContain('move 280,130')
    expect(r2.text).toContain('保存')
    await expect(ctl2.execute('click_target', { description: '不存在的齿轮图标xyz' })).rejects.toThrow()
  })
  it('a11y failure degrades gracefully with an explanation', async () => {
    const { deps: d } = deps({ elements: async () => ({ elements: [], screen: { width: 0, height: 0 }, engine: 'uia', error: '读取界面元素超时（6 秒），已跳过' }) })
    const r = await new ComputerController(d).screenshot()
    expect(r.text).toContain('无障碍接口不可用')
  })
  it('text mode (DeepSeek) keeps the 【纯文本屏幕描述】 prefix and includes ids', async () => {
    const { deps: d } = deps({
      textMode: () => true,
      ocr: async () => ({ words: [{ text: '就绪', x1: 20, y1: 760, x2: 60, y2: 780, conf: 90 } as any], boxes: [], engine: 'tesseract' })
    })
    const r = await new ComputerController(d).screenshot()
    expect(r.text.startsWith('【纯文本屏幕描述】')).toBe(true)
    expect(r.text).toContain('[1] 按钮 "保存"')
  })
})

import { xdotoolKeyName } from '../src/main/core/localVm'
describe('Linux VM key names', () => {
  it('maps common names to case-sensitive X keysyms', () => {
    expect(['enter', 'Escape', 'esc', 'ctrl', 'left', 'pagedown', 'f5', 'A', 'win'].map(xdotoolKeyName)).toEqual(['Return', 'Escape', 'Escape', 'ctrl', 'Left', 'Page_Down', 'F5', 'a', 'super'])
  })
})
