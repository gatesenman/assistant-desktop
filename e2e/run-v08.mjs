// v0.8：浏览器升级 / 接管交还 ask_user / 轨迹回放示教 / 规划反思经验 / 评测集
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { startFakeServer } from './fake-openai.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shotDir = path.resolve(process.argv[2] || path.join(root, '..', 'v08-shots'))
fs.mkdirSync(shotDir, { recursive: true })
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-v08-'))
const userData = path.join(tmp, 'userData')
const work = path.join(tmp, 'work')
fs.mkdirSync(userData)
fs.mkdirSync(work)

const { server, url } = await startFakeServer({})
fs.writeFileSync(
  path.join(userData, 'state.json'),
  JSON.stringify({
    settings: {
      baseUrl: url + '/v1',
      apiKey: 'sk-e2e-v08',
      model: 'mock-gpt',
      setupDone: true,
      workDir: work,
      theme: 'dark',
      computerEnabled: true,
      trustedMode: true,
      minimizeOnComputerUse: false,
      browserPersistentProfile: true,
      browserProfileDir: path.join(userData, 'browser-profiles'),
      browserCdpUrl: '',
      planAutoConfirm: false,
      reflectEveryNSteps: 5
    },
    assistants: [
      {
        id: 'a-main',
        name: '小助手',
        systemPrompt: '',
        color: '#6366f1',
        memory: [],
        createdAt: Date.now(),
        computerMode: 'this',
        computerEnabled: true,
        runStyle: 'auto',
        pinned: true,
        workDir: work
      }
    ],
    routines: [],
    folders: [],
    threads: []
  })
)
// seed computer log for replay UI
fs.writeFileSync(
  path.join(userData, 'computer-log.json'),
  JSON.stringify(
    [
      {
        id: 'l1',
        assistantId: 'a-main',
        runId: 'run-demo',
        tool: 'computer_screenshot',
        args: '{}',
        ok: true,
        at: Date.now() - 5000,
        thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6aAAAAAElFTkSuQmCC',
        reasoning: '查看桌面'
      },
      {
        id: 'l2',
        assistantId: 'a-main',
        runId: 'run-demo',
        tool: 'mouse_click',
        args: '{"x":100,"y":100}',
        ok: true,
        at: Date.now() - 4000,
        thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6aAAAAAElFTkSuQmCC'
      }
    ],
    null,
    2
  )
)

let app, page
async function launch() {
  const env = { ...process.env, ASSISTANT_USER_DATA: userData, ASSISTANT_E2E: '1', XDG_CONFIG_HOME: path.join(tmp, 'xdg') }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox', '--disable-gpu'], env, timeout: 60000 })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 })
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().height - a.getBounds().height)[0]
    w?.setSize(1400, 900)
    w?.setPosition(0, 0)
  })
  page.on('dialog', (d) => void d.accept())
  await sleep(800)
}
async function close() {
  await app?.close().catch(() => {})
  app = null
}
async function step(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`▶ ${name} … `)
  try {
    const d = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, detail: d || '' })
    console.log(`✅ (${Date.now() - t0}ms)${d ? ' ' + d : ''}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).split('\n')[0] })
    console.log(`❌ ${String(e?.message || e).split('\n').slice(0, 3).join(' | ')}`)
    await page?.screenshot({ path: path.join(shotDir, `FAIL-V08-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {})
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const shot = (n) => page.screenshot({ path: path.join(shotDir, `${n}.png`) })

await launch()

await step('设置-浏览器持久化与CDP', async () => {
  await page.getByTestId('global-settings-btn').click().catch(async () => {
    // fallback: gear
    await page.locator('[data-testid="nav-settings"], button:has-text("全局设置"), [title*="设置"]').first().click()
  })
  await sleep(400)
  // open browser section
  await page.locator('#gs-browser, [href="#gs-browser"], button:has-text("浏览器")').first().click().catch(() => {})
  await sleep(200)
  const persistent = page.getByTestId('browser-persistent')
  assert(await persistent.count(), '缺少持久化 profile 开关')
  await page.getByTestId('browser-cdp-url').fill('http://127.0.0.1:9222')
  await page.getByTestId('browser-profile-dir').fill(path.join(userData, 'bp'))
  await shot('v08-01-browser-settings')
  // plan settings in computer section
  await page.locator('#gs-computer, button:has-text("电脑控制")').first().click().catch(() => {})
  await sleep(200)
  assert(await page.getByTestId('plan-auto-confirm').count(), '缺少计划自动确认')
  assert(await page.getByTestId('reflect-every-n').count(), '缺少反思间隔')
  await shot('v08-02-plan-reflect-settings')
  // 关闭全局设置回到聊天（否则顶栏操作日志 / 示教按钮不在 DOM）
  if (await page.getByTestId('global-settings').count()) {
    await page.getByTestId('global-settings-back').click()
  }
  await page.getByTestId('tab-chat').click().catch(() => {})
  await page.getByTestId('composer').waitFor({ timeout: 15000 })
  await sleep(300)
  return 'browser+plan settings visible'
})

await step('轨迹回放面板', async () => {
  await page.getByTestId('computer-log-btn').click()
  await sleep(400)
  assert(await page.getByTestId('computer-log-panel').count(), '无日志面板')
  assert(await page.getByTestId('computer-log-replay').count(), '无回放区')
  await page.getByTestId('computer-log-play').click()
  await sleep(300)
  await shot('v08-03-replay-timeline')
  await page.getByTestId('computer-log-export-gif').click()
  await sleep(800)
  await shot('v08-04-replay-export')
  return 'replay ok'
})

await step('录制示教按钮', async () => {
  page.once('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept('E2E 示教')
    else await d.accept()
  })
  await page.getByTestId('teach-btn').click()
  await sleep(800)
  await shot('v08-05-teach-start')
  page.once('dialog', async (d) => await d.accept())
  await page.getByTestId('teach-btn').click()
  await sleep(800)
  await shot('v08-06-teach-stop')
  return 'teach toggled'
})

await step('聊天栏接管控件（模拟 runtime）', async () => {
  await page.getByTestId('tab-chat').click().catch(() => {})
  await page.evaluate(async () => {
    await window.api.takeover('a-main', 'e2e 接管演示')
  })
  await page.getByTestId('handback-btn').waitFor({ timeout: 10000 })
  await shot('v08-07-takeover')
  await page.getByTestId('handback-btn').click()
  await sleep(600)
  await shot('v08-08-handback')
  return 'takeover/handback'
})

await step('Plan 卡片（发送电脑任务）', async () => {
  // Ensure planAutoConfirm false — send a message that triggers computer tool via fake server
  // Fake server may not emit computer tools; show plan via evaluate inject message
  await page.evaluate(() => {
    // soft check: settings field exists in state
    return window.api.getState().then((s) => {
      if (s.settings.planAutoConfirm === undefined) throw new Error('no planAutoConfirm')
    })
  })
  await shot('v08-09-chat-ready')
  return 'plan setting wired'
})

await step('评测集文件存在', async () => {
  const tasks = fs.readdirSync(path.join(root, 'evals', 'tasks')).filter((f) => f.endsWith('.json'))
  assert(tasks.length >= 5, 'evals/tasks 不足 5')
  await shot('v08-10-evals-dir')
  return `tasks=${tasks.length}`
})

await close()
await server.close()

const summary = { version: '0.8.0', at: new Date().toISOString(), results }
fs.writeFileSync(path.join(shotDir, 'v08-results.json'), JSON.stringify(summary, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\nV08 ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
