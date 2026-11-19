// v0.7：Set-of-Mark 编号控件 / AT-SPI / grounding 定位模型 / 用量与费用 / 预算暂停 / VNC 控制虚拟机
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, execFileSync } from 'child_process'
import { createRequire } from 'module'
import { startFakeServer } from './fake-openai.mjs'
import { startFakeVnc } from './fake-vnc.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const { PNG } = require('pngjs')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shotDir = path.resolve(process.argv[2] || path.join(root, 'e2e-screenshots'))
fs.mkdirSync(shotDir, { recursive: true })
const results = []
const notes = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-v07-'))
const userData = path.join(tmp, 'userData')
const work = path.join(tmp, 'work')
fs.mkdirSync(userData)
fs.mkdirSync(work)
fs.writeFileSync(path.join(work, '资料.txt'), '测试资料\n'.repeat(20))
const VNC_BTN = { name: 'OK', x1: 560, y1: 430, x2: 700, y2: 480 }
const { server, url, log } = await startFakeServer({ vncButton: VNC_BTN })
const SKIP_VM = process.env.E2E_SKIP_VM === '1'
fs.writeFileSync(
  path.join(userData, 'state.json'),
  JSON.stringify({
    settings: { baseUrl: url + '/v1', apiKey: 'sk-e2e-v07', model: 'mock-gpt', setupDone: true, workDir: work, theme: 'dark', computerEnabled: true, trustedMode: true, minimizeOnComputerUse: false },
    assistants: [{ id: 'a-main', name: '小助手', systemPrompt: '', color: '#6366f1', memory: [], createdAt: Date.now(), computerMode: 'this', computerEnabled: true, runStyle: 'auto', pinned: true, workDir: work }],
    routines: [],
    folders: [],
    threads: []
  })
)
const dockerOk = (() => {
  try {
    execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'pipe', timeout: 15000 })
    return true
  } catch {
    return false
  }
})()
notes.push(`docker 可用：${dockerOk}`)

let app, page
async function launch(extraEnv = {}) {
  const env = { ...process.env, ASSISTANT_USER_DATA: userData, ASSISTANT_E2E: '1', XDG_CONFIG_HOME: path.join(tmp, 'xdg'), ...extraEnv }
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
  await sleep(600)
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
    await page?.screenshot({ path: path.join(shotDir, `FAIL-V07-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {})
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const shot = (n) => page.screenshot({ path: path.join(shotDir, `${n}.png`) })
const saveDataUrl = (dataUrl, name) => {
  const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl || '')
  if (!m) throw new Error('不是图片 data URL')
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  fs.writeFileSync(path.join(shotDir, `${name}.${ext}`), Buffer.from(m[2], 'base64'))
  return `${name}.${ext}`
}
async function send(text) {
  const ta = page.getByTestId('composer')
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
}
const body = () => page.locator('.messages')
async function waitText(text, timeout = 30000) {
  await body().getByText(text, { exact: false }).last().waitFor({ timeout })
}
async function waitIdle(timeout = 120000) {
  await page.waitForFunction(() => !document.querySelector('[data-testid="stop-btn"]'), null, { timeout })
}
async function openGlobal(sectionId) {
  // 从用量等页回到可点侧栏「设置」的状态
  if (await page.getByTestId('tab-chat').count()) await page.getByTestId('tab-chat').click().catch(() => {})
  await sleep(200)
  if (!(await page.getByTestId('global-settings').count())) {
    const btn = page.getByTestId('global-settings-btn')
    await btn.waitFor({ state: 'visible', timeout: 15000 })
    await btn.click()
  }
  await page.getByTestId('global-settings').waitFor({ state: 'visible', timeout: 30000 })
  if (sectionId) {
    await page.locator('#' + sectionId).scrollIntoViewIfNeeded()
    await sleep(300)
  }
}
async function backToChat() {
  if (await page.getByTestId('global-settings').count()) await page.getByTestId('global-settings-back').click()
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('composer').waitFor()
}
async function newThread() {
  const b = page.getByTestId('new-thread')
  if (await b.count()) await b.first().click()
  await sleep(300)
}
function vmExec(cmd) {
  return execFileSync('docker', ['exec', '-u', 'desk', 'assistant-desktop-vm', 'bash', '-lc', `. /tmp/desk-session.env; ${cmd}`], { encoding: 'utf8', timeout: 30000 }).trim()
}

/* ======================= A：用量 / 价格 / 预算 / grounding ======================= */
await launch()

await step('U01 回复下方显示本轮用量（include_usage + DeepSeek 缓存字段）', async () => {
  await backToChat()
  await send('E2E_USAGE 你好，介绍一下你自己')
  await waitText('收到：E2E_USAGE')
  await waitIdle()
  const line = page.getByTestId('usage-line').last()
  await line.waitFor({ timeout: 10000 })
  const t = ((await line.textContent()) || '').trim()
  assert(log.includeUsage > 0 && log.usageChunks > 0, '请求未带 include_usage 或服务器未返回 usage')
  await send('E2E_USAGE 再来一句')
  await waitText('收到：E2E_USAGE 再来一句')
  await waitIdle()
  const t2 = ((await page.getByTestId('usage-line').last().textContent()) || '').trim()
  assert(/命中/.test(t2), '第二轮应显示缓存命中：' + t2)
  await shot('v07-01-usage-line')
  return t2
})

await step('U02 价格表：添加自定义价格（mock-gpt）并保存', async () => {
  await page.getByTestId('tab-usage').click()
  await page.getByTestId('usage-page').waitFor()
  const editor = page.getByTestId('price-editor')
  await editor.scrollIntoViewIfNeeded()
  const before = await page.getByTestId('price-row').count()
  assert(before >= 2, '默认价格表缺少 DeepSeek 条目')
  const txt = (await editor.textContent()) || ''
  await page.getByTestId('price-add').click()
  const row = page.getByTestId('price-row').last()
  const inputs = row.locator('input')
  await inputs.nth(0).fill('Mock GPT（测试价格）')
  await inputs.nth(2).fill('mock-gpt')
  await inputs.nth(3).fill('2')
  await inputs.nth(4).fill('0.2')
  await inputs.nth(5).fill('8')
  await page.getByTestId('price-save').click()
  await sleep(500)
  const st = await page.evaluate(() => window.api.getState())
  assert(st.settings.prices.some((p) => p.models === 'mock-gpt' && p.price.input === 2), '价格未保存')
  await row.scrollIntoViewIfNeeded()
  await shot('v07-02-price-editor')
  return `默认条目 ${before} 个：${txt.includes('deepseek-v4-pro') ? '含 deepseek-v4-pro' : ''}`
})

await step('U03 预算：单任务 $0.30 → 超出后暂停并给出中文提示 → 继续', async () => {
  const sec = page.getByTestId('budget-section')
  await sec.scrollIntoViewIfNeeded()
  await page.getByTestId('budget-task').fill('0.30')
  await page.getByTestId('budget-day').fill('0')
  await page.getByTestId('budget-save').click()
  await sleep(400)
  await backToChat()
  await newThread()
  log.budgetCalls = 0
  await send('E2E_BUDGET 请反复阅读工作目录里的资料并总结')
  await page.getByTestId('budget-pause').last().waitFor({ timeout: 60000 })
  await waitIdle()
  const t = ((await page.getByTestId('budget-pause').last().textContent()) || '').trim()
  assert(/预算/.test(t), '暂停提示不含「预算」：' + t)
  assert(log.budgetCalls <= 3, '预算超出后仍在调用模型：' + log.budgetCalls)
  const calls = log.budgetCalls
  await sleep(1500)
  assert(log.budgetCalls === calls, '暂停后模型仍被调用')
  await page.getByTestId('budget-pause').last().scrollIntoViewIfNeeded()
  await shot('v07-03-budget-pause')
  // 提高预算后继续
  await page.evaluate(() => window.api.saveBudget({ perTaskUsd: 0, perDayUsd: 0, perTaskTokens: 0 }))
  await page.getByTestId('budget-resume').last().click()
  await waitText('收到：（已调整预算）')
  await waitIdle()
  await shot('v07-04-budget-resumed')
  return `暂停前调用模型 ${calls} 次；提示：${t.slice(0, 80)}`
})

await step('U04 定时任务显示上次运行的用量', async () => {
  await page.evaluate(() => window.api.createRoutine({ assistantId: 'a-main', name: '每日简报', cron: '0 9 * * *', prompt: 'E2E_ROUTINE_PING 生成每日简报', enabled: true }))
  const st = await page.evaluate(() => window.api.getState())
  const id = st.routines.find((r) => r.name === '每日简报').id
  await page.evaluate((id) => window.api.runRoutineNow(id), id)
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    const s = await page.evaluate(() => window.api.getState())
    if (s.routines.find((r) => r.id === id)?.lastUsage) break
    await sleep(300)
  }
  await page.getByTestId('tab-routines').click()
  const u = page.getByTestId('routine-usage').first()
  await u.waitFor({ timeout: 10000 })
  await shot('v07-05-routine-usage')
  return ((await u.textContent()) || '').trim()
})

await step('U05 并行面板：今日用量卡片', async () => {
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('parallel-panel-btn').click()
  const c = page.getByTestId('parallel-usage')
  await c.waitFor({ timeout: 10000 })
  await shot('v07-06-parallel-usage')
  const t = ((await c.textContent()) || '').trim()
  await page.getByTestId('parallel-panel-btn').click()
  return t.slice(0, 80)
})

await step('U06 用量页：今日统计 + 每日图表 + 按模型/助手/定时任务', async () => {
  await page.getByTestId('tab-usage').click()
  await page.getByTestId('usage-chart').waitFor()
  const today = ((await page.getByTestId('usage-today').textContent()) || '').trim()
  assert(!(await page.getByTestId('usage-empty').count()), '用量页显示为空')
  await page.getByTestId('usage-page').evaluate((el) => el.scrollTo?.(0, 0))
  await shot('v07-07-usage-page')
  const v = await page.evaluate(() => window.api.getUsage())
  assert(v.today.calls >= 4 && v.today.cost > 0, '今日用量不正确：' + JSON.stringify(v.today))
  assert(Object.keys(v.summary.byRoutine).length >= 1, '缺少定时任务维度')
  assert(fs.existsSync(path.join(userData, 'usage.json')), '用量未持久化')
  return `今日 ${v.today.calls} 次调用，输入 ${v.today.input}，命中 ${v.today.cacheHit}，输出 ${v.today.output}，$${v.today.cost.toFixed(4)}`
})

await step('G01 定位模型设置：UI-TARS-1.5 预设 + 测试按钮（smart_resize 坐标）', async () => {
  await openGlobal('gs-grounding')
  const sec = page.getByTestId('grounding-section')
  await sec.scrollIntoViewIfNeeded()
  await page.getByTestId('grounding-preset-uitars15-vllm').click()
  if (!(await page.getByTestId('grounding-enabled').isChecked())) await page.getByTestId('grounding-enabled').check()
  await page.getByTestId('grounding-baseurl').fill(url + '/v1')
  await page.getByTestId('grounding-model').fill('ui-tars-1.5-7b')
  await page.getByTestId('grounding-test').click()
  const r = page.getByTestId('grounding-result')
  await r.waitFor({ timeout: 60000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="grounding-result"]')?.getAttribute('data-ok') !== null, null, { timeout: 60000 })
  const ok = await r.getAttribute('data-ok')
  const t = ((await r.textContent()) || '').trim()
  assert(ok === '1', '测试未命中：' + t)
  const g = log.grounding.at(-1)
  assert(g.content.includes('start_box') && g.width === 1280, 'grounding 请求异常：' + JSON.stringify(g).slice(0, 200))
  await page.getByTestId('grounding-save').click()
  await sleep(400)
  await sec.scrollIntoViewIfNeeded()
  await shot('v07-08-grounding-settings-test')
  const st = await page.evaluate(() => window.api.getState())
  assert(st.settings.grounding.enabled && st.settings.grounding.coordSpace === 'smart_resize', 'grounding 设置未保存：' + JSON.stringify(st.settings.grounding))
  return t.slice(0, 120)
})

await step('G02 其它预设：UI-TARS v1（0–1000）/ Fara-7B（tool_call）也能正确解析', async () => {
  const v1 = await page.evaluate((u) => window.api.testGrounding({ preset: 'uitars-v1', baseUrl: u, model: 'ui-tars-v1-7b-sft', coordSpace: 'relative1000', promptStyle: 'uitars' }), url + '/v1')
  const fara = await page.evaluate((u) => window.api.testGrounding({ preset: 'fara7b', baseUrl: u, model: 'microsoft/Fara-7B', coordSpace: 'smart_resize', promptStyle: 'fara' }), url + '/v1')
  assert(v1.ok, 'UI-TARS v1 未命中：' + v1.message)
  assert(fara.ok, 'Fara 未命中：' + fara.message)
  const v = await page.evaluate(() => window.api.getUsage())
  return `v1：${v1.message.slice(0, 50)}；Fara：${fara.message.slice(0, 50)}；grounding 用量已计入（${Object.keys(v.summary.byModel).join(', ')}）`
})

await step('D01 诊断导出包含用量 + UIA/AT-SPI + grounding 状态（不含密钥）', async () => {
  const r = await page.evaluate(() => window.api.exportLogs())
  assert(r.ok, r.message)
  const text = fs.readFileSync(r.path, 'utf8')
  for (const k of ['v07:', '"用量"', '"grounding"', '"编号标注"', '"感知"', '"价格表"']) assert(text.includes(k), '诊断缺少 ' + k)
  assert(!text.includes('sk-e2e-v07'), '诊断包含 API Key')
  const status = await page.evaluate(() => window.api.computerSenseStatus())
  notes.push('本机电脑感知状态：' + JSON.stringify(status).slice(0, 300))
  return `本机感知引擎：${status.engine}（${status.available ? '可用' : '不可用'}）`
})

/* ======================= B：Linux 虚拟电脑（真实 docker 容器 + AT-SPI） ======================= */
if (dockerOk && !SKIP_VM) {
  await step('L01 启动 Linux 虚拟电脑（含 AT-SPI 无障碍总线）', async () => {
    await backToChat()
    const panel = page.getByTestId('computer-panel')
    if (!(await panel.count())) await page.getByTestId('computer-panel-btn').click()
    await panel.waitFor()
    await page.getByTestId('computer-target-virtual').click()
    await page.getByTestId('vm-picker').waitFor()
    await page.getByTestId('vm-os-card-linux').click()
    await page.getByTestId('vm-start').click()
    await page.waitForFunction(() => (document.querySelector('[data-testid="vm-badge-linux"]')?.textContent || '').includes('运行中'), null, { timeout: 900000, polling: 2000 })
    const st = await page.evaluate(() => window.api.getState())
    assert(st.settings.activeMachineId === 'vm-local', '控制目标未切到 Linux VM：' + st.settings.activeMachineId)
    await page.evaluate(() => window.api.updateAssistant('a-main', { computerMode: 'virtual' }))
    await page.getByTestId('computer-panel-btn').click()
    return 'vm-local 运行中'
  })

  await step('L02 编号控件：get_ui_elements（AT-SPI）→ type_into_element → click_element（真实 Linux VM）', async () => {
    await newThread()
    await send('E2E_SOM_VM 打开记事本，在编辑区输入一句话，然后打开 Help 菜单')
    await waitText('编号控件操作完成', 120000)
    await waitIdle()
    const list = log.somLists?.at(-1) || ''
    assert(/来源：[^\n]*AT-SPI|atspi/i.test(list), '元素列表不是来自 AT-SPI：' + list.slice(0, 200))
    assert(/\[\d+\] 菜单 "File"/.test(list), '列表缺少 File 菜单')
    // 真实核对：通过 AT-SPI 读取记事本编辑区的文本
    const text = vmExec(`python3 - <<'PY'
import pyatspi
d=pyatspi.Registry.getDesktop(0)
def walk(o,depth=0):
    if depth>14: return
    try:
        if o.getRoleName()=='text':
            t=o.queryText(); print(t.getText(0,-1))
    except Exception: pass
    for i in range(o.childCount):
        try: walk(o.getChildAtIndex(i),depth+1)
        except Exception: pass
for a in d:
    if a and 'ousepad' in (a.name or ''): walk(a)
PY`)
    assert(text.includes('Hello SoM v0.7'), '记事本中没有输入的文字：' + text.slice(0, 100))
    notes.push('记事本内容（AT-SPI 读取）：' + text.slice(0, 80))
    notes.push('Help 菜单行：' + log.somHelpLine)
    await page.locator('[data-tool="click_element"]').last().scrollIntoViewIfNeeded().catch(() => {})
    await shot('v07-09-click-element-vm-chat')
    fs.writeFileSync(path.join(shotDir, 'v07-element-list-vm.txt'), list)
    return `编辑区文本「${text.slice(0, 30)}」；${log.somHelpLine}`
  })

  await step('L03 设置页：电脑感知状态（AT-SPI）+ 编号预览（标注截图 + 元素列表）', async () => {
    await openGlobal('gs-computer')
    const sec = page.getByTestId('som-section')
    await sec.scrollIntoViewIfNeeded()
    await page.getByTestId('sense-status').waitFor()
    await page.getByTestId('som-preview').click()
    await page.getByTestId('som-preview-img').waitFor({ timeout: 60000 })
    const toggle = page.getByTestId('som-preview-result').getByText('元素列表', { exact: false }).first()
    if (!(await page.getByTestId('som-preview-list').count()) && (await toggle.count())) await toggle.click()
    await sleep(400)
    await page.getByTestId('som-preview-result').scrollIntoViewIfNeeded()
    await shot('v07-10-som-preview-settings')
    const p = await page.evaluate(() => window.api.previewMarks())
    assert(p.ok && p.count > 3, '预览失败：' + p.message)
    const f = saveDataUrl(p.image, 'v07-11-marks-overlay-vm')
    fs.writeFileSync(path.join(shotDir, 'v07-11-marks-overlay-vm-list.txt'), p.list || '')
    const engine = await page.getByTestId('sense-status').getAttribute('data-engine')
    return `${p.message}；状态引擎=${engine}；${f}`
  })

  await step('L04 Linux VM 改用 VNC 控制 + click_target（grounding 模型定位红色窗口）', async () => {
    await page.getByTestId('linux-vm-control-vnc').click()
    await sleep(800)
    await backToChat()
    await newThread()
    const n0 = log.grounding.length
    await send('E2E_GROUND_VM 打开一个红色窗口，然后让定位模型点中它')
    await waitText('grounding 点击完成', 120000)
    await waitIdle()
    assert(log.grounding.length > n0, 'click_target 未调用 grounding 模型')
    const active = vmExec('xdotool getactivewindow getwindowname')
    const mouse = vmExec('xdotool getmouselocation')
    assert(active === 'RedTarget', '点击后的活动窗口不是红色窗口：' + active)
    // 指针确实被 VNC 移到了红色窗口内部
    const geo = vmExec('xdotool search --name RedTarget getwindowgeometry --shell | head -5')
    const g = Object.fromEntries(geo.split('\n').map((l) => l.split('=')).filter((a) => a.length === 2).map(([k, v]) => [k, Number(v)]))
    const mx = Number(/x:(\d+)/.exec(mouse)?.[1])
    const my = Number(/y:(\d+)/.exec(mouse)?.[1])
    assert(mx >= g.X && mx <= g.X + g.WIDTH && my >= g.Y && my <= g.Y + g.HEIGHT, `指针 (${mx},${my}) 不在红色窗口 ${JSON.stringify(g)} 内`)
    await shot('v07-12-click-target-vnc-chat')
    const p = await page.evaluate(() => window.api.previewMarks())
    if (p.ok) saveDataUrl(p.image, 'v07-13-linux-vm-after-click-target')
    await page.evaluate(() => window.api.saveSettings({ linuxVmControl: 'docker' }))
    return `活动窗口=${active}；鼠标 ${mouse}；${log.grounding.at(-1).content.split('\n').pop()}`
  })
}
await close()

/* ======================= C：Windows 虚拟机（真实 qemux/qemu 容器的 WebSocket VNC） ======================= */
let qemuRunning = false
try {
  qemuRunning = execSync('docker inspect -f "{{.State.Running}}" assistant-desktop-win', { stdio: 'pipe' }).toString().trim() === 'true'
} catch {}
if (dockerOk && qemuRunning) {
  const img = execSync('docker inspect -f "{{.Config.Image}}" assistant-desktop-win').toString().trim()
  notes.push('assistant-desktop-win 容器镜像：' + img + '（dockur/windows 的基础镜像，同样的 nginx /websockify → QEMU VNC 通道）')
  // 等 Alpine 启动到登录提示（串口上也会打印 login:）
  for (let i = 0; i < 90; i++) {
    if (/Welcome to Alpine/.test(execSync('docker logs --tail 8 assistant-desktop-win 2>&1').toString())) break
    await sleep(2000)
  }
  await sleep(10000)
  await launch()
  await step('W01 选中 Windows 虚拟机 → 智能体通过 dockur 的 /websockify（QEMU VNC）截图、键入命令', async () => {
    await page.evaluate(() => window.api.setActiveMachine('vm-windows'))
    await page.evaluate(() => window.api.updateAssistant('a-main', { computerMode: 'virtual' }))
    await backToChat()
    await newThread()
    await send('E2E_VNC_QEMU 登录虚拟机并执行一条命令')
    await waitText('虚拟机里的命令已执行', 120000)
    await waitIdle()
    await sleep(800)
    const logs = execSync('docker logs --tail 30 assistant-desktop-win 2>&1').toString()
    assert(logs.includes('VNC-OK-42'), '串口没有收到命令输出（键入未生效）：' + logs.slice(-200))
    await shot('v07-14-vm-vnc-control-chat')
    const p = await page.evaluate(() => window.api.previewMarks())
    if (p.ok) saveDataUrl(p.image, 'v07-15-qemu-vm-vnc-screen')
    const prev = await page.evaluate(() => window.api.captureComputerPreview())
    assert(prev?.thumb, '没有 VNC 预览')
    const clog = await page.evaluate(() => window.api.getComputerLog())
    return `串口输出含 VNC-OK-42；操作日志 ${clog.length} 条；${p.message || ''}`
  })
  await close()
} else notes.push('未运行 qemux/qemu 容器，跳过真实 WebSocket VNC 步骤')

/* ======================= D：模拟 Windows 桌面（假 VNC 服务器，验证点击落点） ======================= */
const fake = await startFakeVnc({ width: 1280, height: 800, websocket: true, buttons: [VNC_BTN, { name: 'Cancel', x1: 740, y1: 430, x2: 880, y2: 480 }] })
await launch({ ASSISTANT_VNC_URL_OVERRIDE: `ws://127.0.0.1:${fake.port}/websockify` })
await step('W02 [模拟 Windows 桌面] VNC：截图 → 编号列表（矩形控件检测）→ click_element → 键入', async () => {
  await page.evaluate(() => window.api.setActiveMachine('vm-windows'))
  await page.evaluate(() => window.api.updateAssistant('a-main', { computerMode: 'virtual' }))
  await backToChat()
  await newThread()
  await send('E2E_VNC_WIN 点一下确定按钮，然后输入 hello vnc')
  await waitText('Windows 虚拟机操作完成', 90000)
  await waitIdle()
  assert(fake.pressed.has('OK'), '「OK」按钮没有被点中：' + JSON.stringify(fake.state.clicks))
  assert(fake.state.typed.includes('hello vnc'), '没有收到键入：' + JSON.stringify(fake.state.typed))
  const usedElement = (log.vncList || '').length > 0
  await shot('v07-16-fake-windows-vnc-chat')
  const png = new PNG({ width: fake.width, height: fake.height })
  fake.rgba().copy(png.data)
  fs.writeFileSync(path.join(shotDir, 'v07-17-fake-windows-after-click.png'), PNG.sync.write(png))
  fs.writeFileSync(path.join(shotDir, 'v07-element-list-fake-windows.txt'), log.vncList || '')
  return `点击 ${JSON.stringify(fake.state.clicks.at(-1))}；键入「${fake.state.typed.trim()}」；${usedElement ? '模型使用了编号列表' : ''}`
})
await close()
await fake.close()

const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join(shotDir, 'v07-results.json'), JSON.stringify({ results, notes, grounding: log.grounding?.map((g) => ({ model: g.model, red: g.red, content: g.content })) }, null, 2))
console.log('\nNOTES:\n' + notes.join('\n'))
console.log(`\n${results.length - failed.length}/${results.length} passed`)
server.close()
process.exit(failed.length ? 1 : 0)
