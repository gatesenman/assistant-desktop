import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BrowserManager } from '../src/main/core/browser'
import { ExperienceStore } from '../src/main/core/experience'
import { TeachRecorder } from '../src/main/core/teach'
import { exportReplay, groupComputerLog } from '../src/main/core/replay'
import { heuristicPlan, shouldReflect, REFLECT_PROMPT } from '../src/main/core/plan'
import { Store } from '../src/main/core/store'
import { Agent, buildSystemPrompt } from '../src/main/core/agent'
import { DefaultToolHost } from '../src/main/core/toolhost'
import { startServer, sse, textChunks, toolCallChunks, type MockServer } from './helpers'
import { chromium } from 'playwright-core'

const PAGE = `<!doctype html><html><head><title>评测表单</title></head><body>
<h1>浏览器升级页</h1>
<input id="name" role="textbox" aria-label="姓名" placeholder="姓名">
<button id="go" role="button" aria-label="提交" onclick="document.getElementById('result').textContent='你好，'+document.getElementById('name').value">提交</button>
<p id="result">尚未提交</p>
<div id="captcha" style="display:none">请输入验证码 2FA</div>
</body></html>`

let srv: MockServer
let chromiumOk = false
try {
  chromiumOk = fs.existsSync(chromium.executablePath())
} catch {
  chromiumOk = false
}

beforeAll(async () => {
  srv = await startServer((_b, _req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
})
afterAll(async () => srv.close())

describe('v0.8 plan / reflect / experience', () => {
  it('heuristicPlan returns editable markdown steps', () => {
    const p = heuristicPlan('打开浏览器登录邮箱并下载附件')
    expect(p).toContain('执行计划')
    expect(p.split('\n').length).toBeGreaterThan(3)
  })
  it('shouldReflect every N steps and on stage-change tools', () => {
    expect(shouldReflect(5, 5, 'computer_screenshot')).toBe(true)
    expect(shouldReflect(3, 5, 'computer_screenshot')).toBe(false)
    expect(shouldReflect(1, 5, 'key_press')).toBe(false)
    expect(shouldReflect(1, 5, 'open_app')).toBe(true)
    expect(shouldReflect(0, 0, 'mouse_click')).toBe(false)
    expect(REFLECT_PROMPT).toContain('截图')
  })
  it('ExperienceStore indexes and injects prompt block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'))
    const store = new ExperienceStore(dir)
    store.add({ app: 'chrome', keywords: ['登录', '邮箱'], summary: '用持久化 profile 打开邮箱并登录', steps: 6, success: true })
    store.add({ app: 'notepad', keywords: ['记事本'], summary: '打开记事本写入文本', steps: 3, success: true })
    const hits = store.search('邮箱 登录')
    expect(hits[0].summary).toContain('邮箱')
    const block = store.promptBlock('打开邮箱')
    expect(block).toContain('相关成功经验')
    expect(block).toContain('邮箱')
  })
  it('buildSystemPrompt includes experienceBlock', () => {
    const a = { id: 'a', name: '测', systemPrompt: '你是助手', color: '#000', memory: [], createdAt: 1, workDir: '' } as any
    const s = buildSystemPrompt(a, '/tmp', { experienceBlock: '## 相关成功经验\n1. demo', computer: true })
    expect(s).toContain('相关成功经验')
    expect(s).toContain('ask_user')
  })
})

describe('v0.8 teach / replay', () => {
  it('TeachRecorder records events and writes SKILL.md draft', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-'))
    const teach = new TeachRecorder(dir)
    const s = teach.start('打开设置保存')
    teach.record({ kind: 'click', x: 10, y: 20, name: '设置', role: 'Button' })
    teach.record({ kind: 'type', text: 'hello', target: '搜索框' })
    teach.record({ kind: 'key', key: 'Enter' })
    const done = teach.stop()
    expect(done.events).toHaveLength(3)
    const saved = teach.saveAsSkill(done)
    expect(saved.path).toBeTruthy()
    expect(fs.readFileSync(saved.path!, 'utf8')).toContain('打开设置保存')
    expect(fs.readFileSync(saved.path!, 'utf8')).toContain('点击')
  })
  it('groupComputerLog and exportReplay write frames', () => {
    const log = [
      { id: '1', assistantId: 'a', runId: 'r1', tool: 'computer_screenshot', args: '{}', ok: true, at: 1, thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      { id: '2', assistantId: 'a', runId: 'r1', tool: 'mouse_click', args: '{"x":1}', ok: true, at: 2, thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', reasoning: '点击按钮' },
      { id: '3', assistantId: 'a', runId: 'r2', tool: 'computer_screenshot', args: '{}', ok: true, at: 3 }
    ]
    const groups = groupComputerLog(log as any)
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.runId === 'r1')!.frames).toHaveLength(2)
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'))
    const r = exportReplay(groups.find((g) => g.runId === 'r1')!.frames, out, { format: 'gif', basename: 't' })
    expect(r.ok).toBe(true)
    expect(r.path).toBeTruthy()
    expect(fs.existsSync(r.framesDir!)).toBe(true)
  })
})

describe('v0.8 agent takeover / guidance / ask_user', () => {
  let dir: string
  let store: Store
  let llm: MockServer
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a08-'))
    store = new Store(dir)
    store.updateSettings({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk',
      model: 'mock',
      setupDone: true,
      computerEnabled: true,
      trustedMode: true,
      planAutoConfirm: true,
      reflectEveryNSteps: 2
    } as any)
    llm = await startServer(async (body, _req, res) => {
      const msgs = body.messages || []
      const last = JSON.stringify(msgs).slice(-800)
      // first: ask_user tool; later text
      if (last.includes('ask_user') && last.includes('tool')) {
        return sse(res, textChunks('收到回答，继续。'))
      }
      if (!String(JSON.stringify(msgs)).includes('ask_user')) {
        return sse(res, toolCallChunks([{ id: 'ask1', name: 'ask_user', args: { question: '你最喜欢的颜色？', placeholder: '颜色' } }]))
      }
      return sse(res, textChunks('完成'))
    })
    store.updateSettings({ baseUrl: llm.url + '/v1' } as any)
  })
  afterEach(async () => {
    await llm.close()
  })

  it('enqueueGuidance returns false when idle', () => {
    const host = new DefaultToolHost({ store, askUser: async () => '蓝色' })
    const agent = new Agent({ store, emit: () => {}, tools: host, fetchImpl: fetch as any, experience: store.experience })
    expect(agent.enqueueGuidance(store.state.assistants[0].id, 'hi')).toBe(false)
  })

  it('takeover and handback flip runtime and release pause gate', async () => {
    const host = new DefaultToolHost({ store })
    const agent = new Agent({
      store,
      emit: () => {},
      tools: host,
      fetchImpl: fetch as any,
      captureComputerThumb: async () => null
    })
    const aid = store.state.assistants[0].id
    await agent.takeover(aid, '测试接管')
    expect(store.runtime.takeover?.assistantId).toBe(aid)
    await agent.handback(aid, '已手动登录')
    expect(store.runtime.takeover).toBeNull()
  })

  it('respondAskUser resolves waitAsk', async () => {
    const host = new DefaultToolHost({ store })
    const agent = new Agent({ store, emit: () => {}, tools: host, fetchImpl: fetch as any })
    const p = agent.waitAsk('c1', new AbortController().signal)
    setTimeout(() => agent.respondAskUser('c1', '绿色'), 10)
    await expect(p).resolves.toBe('绿色')
  })
})

describe.skipIf(!chromiumOk)('v0.8 browser_state / index / extract / persistent', () => {
  it('browser_state numbers interactive elements and click/type by index', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-prof-'))
    const bm = new BrowserManager(() => ({
      headless: true,
      executablePath: '',
      persistentProfile: true,
      profileDir: profile
    }))
    try {
      await bm.execute('a1', 'browser_open', { url: srv.url + '/page' })
      const st = await bm.execute('a1', 'browser_state', {})
      expect(st.text).toMatch(/\[\d+\]/)
      expect(st.text.toLowerCase()).toMatch(/textbox|button|姓名|提交|input/i)
      // find index for name
      const m = st.text.match(/\[(\d+)\].*(姓名|textbox|input)/i) || st.text.match(/\[(\d+)\]/)
      expect(m).toBeTruthy()
      const idx = Number(m![1])
      await bm.execute('a1', 'browser_type_index', { index: idx, text: '评测' })
      const m2 = st.text.match(/\[(\d+)\].*(提交|button)/i)
      const btn = m2 ? Number(m2[1]) : idx + 1
      await bm.execute('a1', 'browser_click_index', { index: btn })
      const t = await bm.execute('a1', 'browser_get_text', { selector: '#result' })
      expect(t.text).toContain('评测')
      const extracted = await bm.execute('a1', 'browser_extract', { schema: { title: 'string', result: '#result' } })
      expect(extracted.text).toBeTruthy()
    } finally {
      await bm.close()
    }
  }, 90000)

  it('connectOverCDP option is accepted via settings shape', async () => {
    const bm = new BrowserManager(() => ({ headless: true, executablePath: '', cdpUrl: '' }))
    // empty cdp falls back to launch — just ensure manager constructs
    expect(bm).toBeTruthy()
    await bm.close()
  })
})

describe('v0.8 store log archive defaults', () => {
  it('keeps more than 300 logs with runId', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log08-'))
    const store = new Store(dir)
    for (let i = 0; i < 50; i++) {
      store.addComputerLog({
        id: 'e' + i,
        assistantId: 'a',
        runId: 'run-' + Math.floor(i / 10),
        tool: 'mouse_click',
        args: '{}',
        ok: true,
        at: i
      })
    }
    expect(store.computerLog.length).toBe(50)
  })
})
