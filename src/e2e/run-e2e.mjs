// 端到端测试：通过 Playwright 的 Electron 支持驱动真实应用（需先 npm run build）
// 用法：xvfb-run -a node e2e/run-e2e.mjs [截图目录]
import { _electron as electron, chromium } from 'playwright'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { startFakeServer } from './fake-openai.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shotDir = path.resolve(process.argv[2] || path.join(root, 'e2e-screenshots'))
fs.mkdirSync(shotDir, { recursive: true })

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-e2e-'))
const userData = path.join(tmp, 'userData')
const workDir = path.join(tmp, 'work')
const xdgConfig = path.join(tmp, 'xdg')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(workDir, { recursive: true })
for (const f of ['a.txt', 'b.md', 'c.json']) fs.writeFileSync(path.join(workDir, f), f)
fs.mkdirSync(path.join(workDir, 'sub'))

const chromeProfile = path.join(tmp, 'chrome-profile')
const { server, log, url } = await startFakeServer({ chromium: chromium.executablePath(), chromeProfile })
const PLAIN_KEY = 'sk-e2e-plain-key-0001'
const UI_KEY = 'sk-e2e-ui-key-9999'

// 预置：明文 API Key（测试迁移到加密存储）
fs.writeFileSync(
  path.join(userData, 'state.json'),
  JSON.stringify({
    settings: { baseUrl: url + '/v1', apiKey: PLAIN_KEY, model: 'mock-gpt', workDir, browserHeadless: true, closeToTray: true },
    assistants: [{ id: 'a-main', name: '小助手', systemPrompt: '', color: '#6366f1', memory: [], createdAt: Date.now() }],
    routines: []
  })
)

const env = { ...process.env, ASSISTANT_USER_DATA: userData, ASSISTANT_E2E: '1', XDG_CONFIG_HOME: xdgConfig }
delete env.ELECTRON_RUN_AS_NODE

// E2E_EXECUTABLE=release/linux-unpacked/assistant-desktop 可直接测试打包后的应用
const packaged = process.env.E2E_EXECUTABLE ? path.resolve(process.env.E2E_EXECUTABLE) : null
const launchOpts = (extra = []) => ({
  executablePath: packaged || electronPath,
  args: [...(packaged ? [] : [root]), '--no-sandbox', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...extra],
  env,
  timeout: 60000
})
let app, page
async function launch() {
  app = await electron.launch(launchOpts())
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [renderer error]', m.text())
  })
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 })
}
async function shot(name) {
  const file = path.join(shotDir, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}
async function step(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`▶ ${name} … `)
  try {
    const detail = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail || '' })
    console.log(`✅ (${Date.now() - t0}ms)${detail ? ' ' + detail : ''}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).split('\n')[0] })
    console.log(`❌ ${String(e?.message || e).split('\n').slice(0, 3).join(' | ')}`)
    const at = String(e?.stack || '').split('\n').find((l) => l.includes('run-e2e.mjs'))
    if (at) console.log('   at', at.trim())
    try {
      await shot(`FAIL-${name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}`)
    } catch {}
  }
}
function assert(c, msg) {
  if (!c) throw new Error(msg)
}
async function send(text) {
  const ta = page.getByTestId('composer')
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
}
const body = () => page.locator('.messages')
async function waitText(text, timeout = 20000) {
  await body().getByText(text, { exact: false }).first().waitFor({ timeout })
}
/** 用应用自己的 desktopCapturer 截取整个虚拟桌面（包含悬浮条和其它应用窗口） */
async function desktopShot(name) {
  const b64 = await app.evaluate(async ({ desktopCapturer }) => {
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1400, height: 900 } })
    return src.thumbnail.toPNG().toString('base64')
  })
  const file = path.join(shotDir, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  return file
}
const hook = (fn) => app.evaluate(fn)
async function waitFor(cond, timeout = 20000, msg = '等待超时') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cond()) return
    await sleep(150)
  }
  throw new Error(msg)
}
function killDesk() {
  try {
    execFileSync('pkill', ['-f', 'desk-page'])
  } catch {}
}
const readState = () => fs.readFileSync(path.join(userData, 'state.json'), 'utf8')

await launch()

await step('01 启动 + 明文 API Key 迁移为加密存储', async () => {
  const raw = readState()
  assert(!raw.includes(PLAIN_KEY), 'state.json 仍包含明文 Key')
  assert(JSON.parse(raw).settings.apiKeyEnc, '缺少 apiKeyEnc')
  await page.getByTestId('onboarding').waitFor()
  await shot('01-onboarding-dark')
  const backend = await app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend?.() ?? 'n/a')
  return `safeStorage 后端=${backend}`
})

await step('02 发送消息 + 流式回复（Markdown/代码高亮/打字指示）', async () => {
  await send('E2E_STREAM 你好，请演示流式输出')
  await page.getByTestId('stop-btn').waitFor({ timeout: 5000 })
  await body().getByText('流式输出测试').waitFor()
  await sleep(400)
  await shot('02-streaming-in-progress')
  await waitText('流式回复完成 ✅')
  await page.getByTestId('send-btn').waitFor()
  assert(await page.locator('.markdown pre code.hljs').count() > 0, '没有代码高亮')
  assert(await page.locator('.markdown table').count() > 0, '没有渲染表格')
  assert(log.auth.at(-1) === `Bearer ${PLAIN_KEY}`, '鉴权头不是解密后的 Key: ' + log.auth.at(-1))
  await shot('02-streaming-done')
})

await step('03 审批执行 shell 命令', async () => {
  await send('E2E_SHELL_APPROVE 运行 echo')
  const card = page.getByTestId('approval-card')
  await card.waitFor()
  await sleep(450)
  await shot('03-shell-approval-card')
  await page.getByTestId('approve-btn').click()
  await waitText('命令输出是')
  const out = await page.locator('[data-tool="run_shell"][data-status="done"] [data-testid="tool-output"]').last().innerText()
  assert(out.includes('e2e-approved-42'), '命令输出不正确：' + out)
  await shot('03-shell-approved-output')
})

await step('04 拒绝执行 shell 命令', async () => {
  await send('E2E_SHELL_DENY 写个文件')
  await page.getByTestId('deny-btn').waitFor()
  await page.getByTestId('deny-btn').click()
  await waitText('已取消执行该命令')
  assert(!fs.existsSync(path.join(workDir, 'denied.txt')), '被拒绝的命令仍然执行了')
  assert((await page.locator('[data-tool="run_shell"][data-status="denied"]').count()) === 1, '没有显示已拒绝状态')
})

await step('05 工具卡片可折叠，显示输入/输出', async () => {
  const card = page.locator('[data-tool="run_shell"][data-status="done"]').last()
  await card.getByTestId('tool-card-toggle').click()
  assert((await card.locator('.tool-body').count()) === 0, '折叠失败')
  await card.getByTestId('tool-card-toggle').click()
  assert((await card.locator('[data-testid="tool-output"]').count()) === 1, '展开失败')
  const denied = page.locator('[data-tool="run_shell"][data-status="denied"]').last()
  const wasOpen = (await denied.locator('.tool-body').count()) === 1
  await denied.getByTestId('tool-card-toggle').click()
  assert(((await denied.locator('.tool-body').count()) === 1) === !wasOpen, '拒绝的卡片无法切换折叠状态')
  await denied.getByTestId('tool-card-toggle').click()
})

await step('06 后台子任务：启动、主对话保持响应、结果回传并总结', async () => {
  await send('E2E_SPAWN 请在后台统计文件')
  await waitText('已在后台启动任务')
  await page.getByTestId('task-panel-btn').click()
  const item = page.getByTestId('task-item').first()
  await item.waitFor()
  assert((await item.getAttribute('data-status')) === 'running', '任务不在运行中')
  await shot('06-task-running')
  // 任务运行期间主对话可继续
  await send('E2E_PING_DURING_TASK 你还在吗')
  await waitText('主对话没有被阻塞', 8000)
  const midStatus = await item.getAttribute('data-status')
  assert(midStatus === 'running', '期望子任务仍在运行，实际：' + midStatus)
  await waitText('总结：后台任务「统计文件」已完成', 30000)
  await page.locator('[data-testid="task-item"][data-status="done"]').first().waitFor()
  await page.getByTestId('task-result-card').first().waitFor()
  await item.locator('.task-item-head').click()
  await page.getByText('子任务完成：工作目录中共有 4 项').first().waitFor()
  await shot('06-task-done-summary')
  await page.getByTestId('task-panel-btn').click()
  return `子任务请求数=${log.subtaskRequests}`
})

await step('07 浏览器自动化：打开、输入(审批)、点击(审批)、读文本、截图进聊天并发送给视觉模型', async () => {
  await send('E2E_BROWSER 打开测试页面并提交表单')
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('approve-btn').waitFor({ timeout: 30000 })
    if (i === 0) {
      await sleep(450)
      await shot('07-browser-type-approval')
    }
    await page.getByTestId('approve-btn').click()
    await sleep(300)
  }
  await waitText('我看到了截图', 40000)
  const img = page.getByTestId('tool-image').last()
  await img.waitFor()
  const src = await img.getAttribute('src')
  assert(src.startsWith('data:image/jpeg;base64,') && src.length > 5000, '截图无效')
  assert(log.visionReceived, '截图没有发送给模型')
  await waitText('你好，小明！表单已提交')
  await img.scrollIntoViewIfNeeded()
  await shot('07-browser-screenshot-in-chat')
})

await step('08 MCP：添加 stdio 测试服务器、列出工具', async () => {
  await page.getByTestId('global-settings-btn').click()
  await page.getByTestId('mcp-add').click()
  await page.getByTestId('mcp-name').fill('demo')
  await page.getByTestId('mcp-command').fill('node')
  await page.getByTestId('mcp-args').fill(`"${path.join(root, 'scripts/test-mcp-server.mjs')}"`)
  await page.getByTestId('mcp-save').click()
  const srv = page.locator('[data-testid="mcp-server"][data-status="connected"]')
  await srv.waitFor({ timeout: 20000 })
  await page.getByText('mcp__demo__add').waitFor()
  await page.getByTestId('mcp-section').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await sleep(200)
  await shot('08-mcp-server-connected')
  const tools = await srv.locator('.mcp-tool code').allInnerTexts()
  return tools.join(', ')
})

await step('09 MCP：模型调用命名空间工具（经过审批）', async () => {
  await page.getByRole('button', { name: '返回' }).click()
  await send('E2E_MCP 用 MCP 算 20+22')
  await page.getByTestId('approve-btn').waitFor()
  assert((await page.locator('[data-tool="mcp__demo__add"][data-status="awaiting"]').count()) === 1, 'MCP 工具没有走审批')
  await page.getByTestId('approve-btn').click()
  await waitText('MCP 计算结果：42')
  await shot('09-mcp-tool-call')
})

await step('10 新助手引导页 + Ctrl+K 快速切换', async () => {
  await page.getByTitle('新建助手').click()
  await page.getByPlaceholder('助手名称，回车确认').fill('研究员')
  await page.getByPlaceholder('助手名称，回车确认').press('Enter')
  await page.getByTestId('onboarding').waitFor()
  assert((await page.getByTestId('assistant-title').innerText()) === '研究员', '新助手未选中')
  await page.getByRole('button', { name: '研究助手' }).click()
  await page.locator('.ob-step.done').nth(1).waitFor()
  await shot('10-new-assistant-onboarding')
  await page.keyboard.press('Control+K')
  await page.getByTestId('quick-switcher').waitFor()
  await page.keyboard.type('小助')
  await shot('10-quick-switcher')
  await page.keyboard.press('Enter')
  await page.getByTestId('quick-switcher').waitFor({ state: 'detached' })
  assert((await page.getByTestId('assistant-title').innerText()) === '小助手', 'Ctrl+K 切换失败')
  await page.keyboard.press('Control+K')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  assert((await page.getByTestId('assistant-title').innerText()) === '研究员', '方向键切换失败')
  await page.keyboard.press('Control+K')
  await page.keyboard.type('小助手')
  await page.keyboard.press('Enter')
})

await step('11 聊天搜索', async () => {
  await page.keyboard.press('Control+F')
  await page.getByTestId('search-input').fill('42')
  const count = await page.getByTestId('search-count').innerText()
  assert(/\d+ 条匹配/.test(count) && !count.startsWith('0'), '搜索无结果：' + count)
  assert((await page.locator('mark').count()) > 0, '没有高亮')
  await shot('11-chat-search')
  await page.getByTestId('search-input').press('Escape')
  return count
})

await step('12 定时任务：关闭窗口后在托盘中继续触发，重新打开可见结果', async () => {
  await page.getByTestId('tab-routines').click()
  await page.getByTestId('routine-new').click()
  await page.getByTestId('routine-name').fill('心跳')
  await page.getByTestId('routine-cron').fill('*/5 * * * * *')
  await page.getByTestId('routine-prompt').fill('E2E_ROUTINE_PING 汇报状态')
  await page.getByTestId('routine-save').click()
  await page.getByText('*/5 * * * * *').waitFor()
  await shot('12-routine-created')
  await page.getByTestId('tab-chat').click()
  const metric = () => page.locator('.messages').evaluate((el) => ({ sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight, vis: document.visibilityState }))
  const mBefore = await metric()
  const before = log.routinePings
  // 模拟用户点击窗口关闭按钮
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await sleep(500)
  const visible = await app.evaluate(() => globalThis.__assistantE2E.isWindowVisible())
  const hasTray = await app.evaluate(() => globalThis.__assistantE2E.hasTray())
  assert(!visible, '窗口关闭后仍可见')
  assert(hasTray, '没有托盘图标')
  const start = Date.now()
  while (log.routinePings <= before && Date.now() - start < 15000) await sleep(250)
  assert(log.routinePings > before, '窗口关闭后定时任务没有触发')
  let notes = []
  while (Date.now() - start < 20000) {
    notes = await app.evaluate(() => globalThis.__assistantE2E.notifications)
    if (notes.some((n) => n.title.includes('心跳'))) break
    await sleep(250)
  }
  assert(notes.some((n) => n.title.includes('心跳')), '没有发出桌面通知')
  const mHidden = await metric()
  const trayMenu = await app.evaluate(() => globalThis.__assistantE2E.trayMenu)
  // 通过托盘菜单「打开小助手」重新打开
  await app.evaluate(() => globalThis.__assistantE2E.showWindow())
  await sleep(500)
  assert(await app.evaluate(() => globalThis.__assistantE2E.isWindowVisible()), '无法重新打开窗口')
  await waitText('定时任务结果：pong', 10000)
  await sleep(400)
  const m = await page.locator('.messages').evaluate((el) => ({ sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight, vis: document.visibilityState }))
  assert(m.sh - m.st - m.ch < 40, '重新打开后聊天没有滚动到最新消息 ' + JSON.stringify({ mBefore, mHidden, m }))
  await shot('12-routine-result-after-reopen')
  // 托盘菜单：暂停定时任务
  await app.evaluate(() => globalThis.__assistantE2E.togglePauseRoutines())
  const menu2 = await app.evaluate(() => globalThis.__assistantE2E.trayMenu)
  assert(menu2.some((m) => m.includes('暂停定时任务 [✓]')), '暂停菜单未勾选')
  const p0 = log.routinePings
  await sleep(6000)
  assert(log.routinePings === p0, '暂停后定时任务仍在触发')
  return `托盘菜单=${trayMenu.join(' / ')}；关闭期间触发 ${log.routinePings - before} 次；通知「${notes.find((n) => n.title.includes('心跳')).body.slice(0, 30)}」`
})

await step('13 电脑控制：截屏 → 打开应用 → 点击 → 输入中英文 → 点击提交 → 截图确认（逐步审批 + 信任模式）', async () => {
  await page.getByTestId('tab-chat').click()
  await page.evaluate(() => window.api.saveSettings({ trustedMode: false, minimizeOnComputerUse: true }))
  log.deskResult = null
  await send('E2E_COMPUTER_DESK 帮我在测试页里输入文字并提交')
  // 截屏无需审批；open_app 需要审批
  const openCard = page.locator('[data-tool="open_app"][data-status="awaiting"]')
  await openCard.waitFor({ timeout: 20000 })
  await sleep(450)
  await shot('13a-computer-approval-card')
  const during = { overlay: await hook(() => globalThis.__assistantE2E.overlayVisible()), hotkey: await hook(() => globalThis.__assistantE2E.stopShortcutRegistered()), power: await hook(() => globalThis.__assistantE2E.powerBlocker()) }
  assert(during.overlay, '控制电脑时没有显示悬浮条')
  assert(during.hotkey, '急停快捷键未注册')
  assert(during.power.kind === 'prevent-display-sleep' && during.power.active, '控制电脑时未阻止休眠：' + JSON.stringify(during.power))
  await openCard.getByTestId('approve-btn').click()
  // 下一步（点击输入框）出现审批时开启信任模式，之后全部自动执行
  const clickCard = page.locator('[data-tool="mouse_click"][data-status="awaiting"]')
  await clickCard.waitFor({ timeout: 30000 })
  await page.getByTestId('trust-btn').click()
  await waitFor(() => log.deskResult !== null, 40000, '测试页没有收到提交（点击/输入未生效）')
  await waitFor(async () => !!(await page.locator('.messages').getByText('电脑操作完成').count()), 30000, '没有最终回复')
  const state = JSON.parse(readState())
  assert(state.settings.trustedMode === true, '信任模式未保存')
  assert(log.deskResult === 'Hello 电脑', '提交内容不正确：' + log.deskResult)
  await waitFor(async () => !(await hook(() => globalThis.__assistantE2E.overlayVisible())), 5000, '结束后悬浮条未隐藏')
  assert(!(await hook(() => globalThis.__assistantE2E.stopShortcutRegistered())), '结束后急停快捷键未注销')
  assert(log.visionReceived, '截图未发送给视觉模型')
  // 整个桌面截图（真实操作后的测试页）
  await desktopShot('13b-desktop-after-computer-use')
  const clog = await page.evaluate(() => window.api.getComputerLog())
  const tools = clog.map((e) => e.tool)
  assert(['computer_screenshot', 'open_app', 'mouse_click', 'type_text'].every((t) => tools.includes(t)), '操作日志不完整：' + tools.join(','))
  assert(clog.every((e) => e.ok && e.thumb?.startsWith('data:image/jpeg')), '操作日志缺少缩略图')
  assert(fs.existsSync(path.join(userData, 'computer-log.json')), '操作日志未持久化')
  await page.getByTestId('computer-log-btn').click()
  await page.getByTestId('computer-log-item').first().waitFor()
  await sleep(400)
  await shot('13c-computer-action-log')
  await page.getByTestId('computer-log-btn').click()
  await page.locator('.messages').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await sleep(300)
  await shot('13d-dark-ui-computer-chat')
  killDesk()
  return `提交内容「${log.deskResult}」；日志 ${clog.length} 步：${tools.join(' → ')}；控制期间：悬浮条✓ 急停热键✓ 阻止休眠=${during.power.kind}`
})

await step('14 紧急停止：全局快捷键 Ctrl+Alt+Esc（xdotool 发送真实按键）', async () => {
  const before = log.computerLoopSteps
  await send('E2E_COMPUTER_LOOP 一直移动鼠标')
  await waitFor(() => log.computerLoopSteps - before >= 3, 20000, '循环没有开始')
  assert(await hook(() => globalThis.__assistantE2E.stopShortcutRegistered()), '快捷键未注册')
  await page.getByTestId('computer-banner').waitFor({ timeout: 5000 })
  await desktopShot('14a-desktop-overlay-while-controlling')
  execFileSync('xdotool', ['key', 'ctrl+alt+Escape'])
  await page.getByTestId('stop-reason').last().waitFor({ timeout: 10000 })
  const reason = await page.getByTestId('stop-reason').last().innerText()
  assert(reason.includes('Ctrl+Alt+Esc'), '停止原因不正确：' + reason)
  const n = log.computerLoopSteps
  await sleep(1500)
  assert(log.computerLoopSteps === n, '急停后仍在继续请求模型')
  assert(!(await hook(() => globalThis.__assistantE2E.overlayVisible())), '急停后悬浮条未隐藏')
  assert(!(await page.getByTestId('computer-banner').count()), '急停后聊天中的提示条未消失')
  await shot('14b-emergency-stopped')
  return `${n - before} 步后被急停：「${reason}」`
})

await step('15 紧急停止：悬浮条上的「停止」按钮', async () => {
  const before = log.computerLoopSteps
  await send('E2E_COMPUTER_LOOP 再来一次')
  await waitFor(() => log.computerLoopSteps - before >= 2, 20000, '循环没有开始')
  await waitFor(async () => app.windows().some((w) => w.url().includes('overlay.html')), 5000, '找不到悬浮条窗口')
  const ov = app.windows().find((w) => w.url().includes('overlay.html'))
  const bounds = await hook(() => globalThis.__assistantE2E.overlayBounds())
  await ov.click('#stop')
  await waitFor(async () => (await page.getByTestId('stop-reason').count()) >= 2, 10000, '点击停止后没有停止')
  const n = log.computerLoopSteps
  await sleep(1200)
  assert(log.computerLoopSteps === n, '停止后仍在继续')
  return `悬浮条位置 ${JSON.stringify(bounds)}；${n - before} 步后停止`
})

await step('16 无人值守定时任务：关闭窗口、关闭信任模式，定时任务在后台自主控制电脑', async () => {
  // 第 12 步的心跳任务停用，并取消托盘中的「暂停定时任务」
  const st0 = JSON.parse(readState())
  for (const r of st0.routines) await page.evaluate((id) => window.api.updateRoutine(id, { enabled: false }), r.id)
  await page.evaluate(() => window.api.saveSettings({ trustedMode: false, routinesPaused: false }))
  await page.getByTestId('tab-routines').click()
  await page.getByTestId('routine-new').click()
  await page.getByTestId('routine-name').fill('无人值守巡检')
  await page.getByTestId('routine-cron').fill('*/5 * * * * *')
  await page.getByTestId('routine-prompt').fill('E2E_ROUTINE_COMPUTER 截屏并检查电脑状态')
  await page.getByTestId('routine-unattended').check()
  await page.getByTestId('routine-save').click()
  await page.getByText('无人值守', { exact: true }).first().waitFor()
  await sleep(300)
  await shot('16a-unattended-routine')
  await waitFor(async () => (await hook(() => globalThis.__assistantE2E.powerBlocker())).kind === 'prevent-app-suspension', 6000, '启用定时任务后未阻止系统挂起')
  const power = await hook(() => globalThis.__assistantE2E.powerBlocker())
  await page.getByTestId('tab-chat').click()
  const logBefore = (await page.evaluate(() => window.api.getComputerLog())).length
  await hook(() => globalThis.__assistantE2E.closeWindow())
  await waitFor(async () => !(await hook(() => globalThis.__assistantE2E.isWindowVisible())), 5000, '窗口没有隐藏')
  await waitFor(() => log.routineComputer >= 1, 30000, '无人值守任务没有完成')
  const notes = await hook(() => globalThis.__assistantE2E.notifications)
  // 停用定时任务
  const st = JSON.parse(readState())
  const r = st.routines.find((x) => x.name === '无人值守巡检')
  assert(r.unattended === true, 'unattended 未保存')
  await page.evaluate((id) => window.api.updateRoutine(id, { enabled: false }), r.id)
  await sleep(6500)
  await hook(() => globalThis.__assistantE2E.showWindow())
  await waitText('无人值守电脑任务完成', 10000)
  const clog = await page.evaluate(() => window.api.getComputerLog())
  const added = clog.slice(logBefore).map((e) => e.tool)
  assert(added.includes('mouse_move') && added.includes('key_press'), '操作日志中没有无人值守操作：' + added.join(','))
  assert(!(await page.locator('[data-status="awaiting"]').count()), '无人值守任务出现了审批卡片')
  assert(notes.some((n) => n.title.includes('无人值守巡检')), '没有通知')
  await page.locator('.messages').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await sleep(300)
  await shot('16b-unattended-result')
  return `启用定时任务时阻止休眠=${power.kind}；后台完成 ${log.routineComputer} 次；新增日志 ${added.join(' → ')}`
})

const WORKERS = Array.from({ length: 3 }, (_, i) => `写手${String(i + 1).padStart(2, '0')}`)
await step('17 多智能体：协调者把 3 个子任务委派给 3 个助手同时并行执行（默认并发上限 10），结果汇总', async () => {
  const st0 = await page.evaluate(() => window.api.getState())
  assert(st0.settings.maxConcurrentAgents === 10, '默认并发上限不是 10：' + st0.settings.maxConcurrentAgents)
  for (const n of WORKERS) await page.evaluate((name) => window.api.createAssistant(name), n)
  await page.locator('[data-testid="bot-item"]', { hasText: '小助手' }).first().click()
  await page.getByTestId('tab-chat').click()
  await send('E2E_DELEGATE 帮我做一份新产品的市场报告')
  await page.getByTestId('parallel-panel-btn').click()
  await waitFor(async () => (await page.locator('[data-testid="agent-row"][data-kind="task"][data-status="running"]').count()) === 3, 15000, '没有 3 个并行运行的智能体')
  await waitFor(() => log.workers.filter((w) => !w.end).length === 3, 5000, '模型服务器没有同时收到 3 个智能体的请求')
  const busy = await page.locator('[data-testid="bot-item"][data-busy="1"]').allInnerTexts()
  assert(WORKERS.every((n) => busy.some((b) => b.includes(n))), '侧边栏没有显示 3 个忙碌的助手：' + busy.length)
  await sleep(600)
  await shot('17a-parallel-panel-running')
  await waitText('汇总完成', 20000)
  const ws = log.workers.slice(-3)
  assert(ws.length === 3 && new Set(ws.map((w) => w.name)).size === 3, '工作者数量不对')
  const maxStart = Math.max(...ws.map((w) => w.start))
  const minEnd = Math.min(...ws.map((w) => w.end))
  assert(maxStart < minEnd, `时间段没有重叠：maxStart=${maxStart} minEnd=${minEnd}`)
  const ts = (await hook(() => globalThis.__assistantE2E.tasks())).filter((t) => t.groupId).slice(-3)
  assert(ts.length === 3, '委派任务数不对')
  assert(ts.every((t) => t.status === 'done'), '委派任务未全部完成')
  assert(Math.max(...ts.map((t) => t.startedAt)) < Math.min(...ts.map((t) => t.finishedAt)), '任务记录时间不重叠')
  for (const n of WORKERS) await waitText(`「${n}」完成`, 3000)
  await sleep(400)
  await shot('17b-parallel-timeline-aggregated')
  const span = Math.max(...ws.map((w) => w.end)) - Math.min(...ws.map((w) => w.start))
  return `3 个智能体同时运行：共同重叠区间 ${minEnd - maxStart}ms，总跨度 ${span}ms（串行需 ≥7500ms）；开始时间差 ${maxStart - Math.min(...ws.map((w) => w.start))}ms`
})

await step('18 屏幕锁：两个智能体同时要控制电脑，自动排队互斥', async () => {
  await page.evaluate(() => window.api.saveSettings({ trustedMode: true }))
  const st = await page.evaluate(() => window.api.getState())
  const idB = st.assistants.find((a) => a.name === '写手02').id
  const idA = st.assistants.find((a) => a.name === '小助手').id
  const h0 = (await hook(() => globalThis.__assistantE2E.screenLockHistory())).length
  await page.getByTestId('composer').fill('E2E_SCREEN_A 操作电脑')
  await page.getByTestId('composer').press('Enter')
  await page.evaluate((id) => window.api.sendMessage(id, 'E2E_SCREEN_B 也要操作电脑', []), idB)
  await waitFor(async () => (await hook(() => globalThis.__assistantE2E.runningAssistants())).length === 2, 5000, '两个智能体没有同时运行')
  await page.getByTestId('screen-queue').waitFor({ timeout: 10000 })
  await sleep(300)
  await shot('18a-screen-lock-queue')
  await waitFor(() => log.screenDone.length >= 2, 30000, '屏幕任务没有全部完成')
  await sleep(500)
  const hs = (await hook(() => globalThis.__assistantE2E.screenLockHistory())).slice(h0)
  assert(hs.length === 2, '屏幕锁记录数不对：' + hs.length)
  assert(new Set(hs.map((h) => h.owner)).size === 2 && hs.every((h) => [idA, idB].includes(h.owner)), '屏幕锁持有者不对')
  const [a, b] = hs.sort((x, y) => x.acquiredAt - y.acquiredAt)
  assert(b.acquiredAt >= a.releasedAt, '屏幕锁区间重叠')
  const waited = b.acquiredAt - b.requestedAt
  assert(waited > 300, '第二个智能体没有排队等待')
  return `先 ${a.owner === idA ? '小助手' : '写手02'} 持有 ${a.releasedAt - a.acquiredAt}ms，另一个排队 ${waited}ms 后获得；两者的模型请求/非 GUI 步骤并行进行`
})

await step('19 渲染进程崩溃后自动恢复', async () => {
  await hook(() => globalThis.__assistantE2E.crashRenderer())
  await waitFor(async () => (await hook(() => globalThis.__assistantE2E.rendererReloads())) >= 1, 10000, '没有检测到渲染进程崩溃')
  let p = null
  await waitFor(async () => {
    for (const w of app.windows()) {
      if (w.url().includes('overlay.html')) continue
      try {
        if (await w.locator('[data-testid="app-root"]').count()) {
          p = w
          return true
        }
      } catch {}
    }
    return false
  }, 20000, '窗口没有恢复')
  page = p
  await waitText('无人值守电脑任务完成', 10000)
  const log2 = fs.readFileSync(path.join(userData, 'crash.log'), 'utf8')
  assert(log2.includes('渲染进程退出'), 'crash.log 没有记录')
  return '已自动重新加载并恢复聊天记录'
})

await step('20 语音输入（假麦克风 → /audio/transcriptions）', async () => {
  await page.getByTestId('mic-btn').click()
  await page.locator('[data-testid="mic-btn"][data-state="rec"]').waitFor({ timeout: 5000 })
  await sleep(1200)
  await page.getByTestId('mic-btn').click()
  await waitFor(async () => (await page.getByTestId('composer').inputValue()).includes('语音转写测试成功'), 10000, '转写文本没有填入输入框')
  await shot('20-voice-input')
  await page.getByTestId('composer').fill('')
  return `转写请求 ${log.transcriptions} 次`
})

await step('21 浅色主题（保留为可选项）', async () => {
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '默认不是深色')
  await page.getByTestId('theme-toggle').click()
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', '未切换到浅色')
  await page.locator('.messages').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await sleep(300)
  await shot('21-light-theme-chat')
  await page.getByTestId('theme-toggle').click()
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '未切回深色')
})

await step('22 设置中修改 API Key（加密保存）+ 开机自启', async () => {
  await page.getByTestId('global-settings-btn').click()
  await page.getByTestId('api-key').fill(UI_KEY)
  await page.getByTestId('settings-save').first().click()
  await page.getByText('已保存', { exact: true }).first().waitFor()
  const raw = readState()
  assert(!raw.includes(UI_KEY) && !raw.includes(PLAIN_KEY), 'state.json 中出现明文 Key')
  const sec = await page.getByTestId('key-security').innerText()
  await page.getByTestId('launch-at-login').check()
  await sleep(300)
  const desktop = path.join(xdgConfig, 'autostart', 'assistant-desktop.desktop')
  assert(fs.existsSync(desktop), '没有生成 autostart 文件')
  assert(fs.readFileSync(desktop, 'utf8').includes('--hidden'), 'autostart 缺少 --hidden')
  await shot('22-global-settings-dark')
  await page.getByTestId('computer-section').scrollIntoViewIfNeeded()
  await sleep(200)
  await shot('22b-computer-settings')
  await page.getByRole('button', { name: '返回' }).click()
  await send('E2E_KEY_CHECK')
  await waitText('鉴权头')
  assert(log.auth.at(-1) === `Bearer ${UI_KEY}`, '新 Key 未生效')
  return sec
})

await step('23 退出并重新启动：数据持久化、密钥解密、MCP 自动重连、--hidden 托盘启动', async () => {
  await app.evaluate(() => globalThis.__assistantE2E.quit())
  await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
  await launch()
  await waitText('MCP 计算结果：42')
  await waitText('总结：后台任务「统计文件」已完成')
  await page.getByTestId('global-settings-btn').click()
  await page.locator('[data-testid="mcp-server"][data-status="connected"]').waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: '返回' }).click()
  await send('E2E_KEY_CHECK 重启后')
  await waitText('重启后')
  await sleep(1500)
  assert(log.auth.at(-1) === `Bearer ${UI_KEY}`, '重启后 Key 解密失败')
  await app.evaluate(() => globalThis.__assistantE2E.quit())
  await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
  // 以 --hidden 启动（开机自启场景）：窗口不显示，托盘存在
  const app2 = await electron.launch(launchOpts(['--hidden']))
  await sleep(2500)
  const vis = await app2.evaluate(() => globalThis.__assistantE2E.isWindowVisible())
  const tray = await app2.evaluate(() => globalThis.__assistantE2E.hasTray())
  await app2.evaluate(() => globalThis.__assistantE2E.quit())
  assert(!vis && tray, `--hidden 启动：visible=${vis} tray=${tray}`)
})

await step('24 主进程崩溃后自动重启（带频率限制）', async () => {
  await launch()
  const startLog = path.join(userData, 'startup.log')
  const n0 = fs.readFileSync(startLog, 'utf8').trim().split('\n').length
  const pid0 = await app.evaluate(() => process.pid)
  await hook(() => globalThis.__assistantE2E.crashMain())
  await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
  let entry = null
  await waitFor(() => {
    const lines = fs.readFileSync(startLog, 'utf8').trim().split('\n')
    if (lines.length <= n0) return false
    entry = JSON.parse(lines.at(-1))
    return true
  }, 20000, '没有自动重启')
  assert(entry.restarted && entry.pid !== pid0, '重启记录不正确：' + JSON.stringify(entry))
  await sleep(3000)
  let alive = true
  try {
    process.kill(entry.pid, 0)
  } catch {
    alive = false
  }
  try {
    process.kill(entry.pid, 'SIGTERM')
  } catch {}
  const crashLog = fs.readFileSync(path.join(userData, 'crash.log'), 'utf8')
  assert(crashLog.includes('E2E 模拟主进程崩溃') && crashLog.includes('正在自动重启'), 'crash.log 没有记录')
  assert(alive, '重启后的进程没有存活')
  return `pid ${pid0} 崩溃 → 新进程 pid ${entry.pid} 已启动`
})

killDesk()
server.close()
const passed = results.filter((r) => r.ok).length
fs.writeFileSync(path.join(shotDir, 'e2e-results.json'), JSON.stringify({ passed, total: results.length, results, at: new Date().toISOString() }, null, 2))
console.log(`\n端到端测试${packaged ? '（打包应用 ' + packaged + '）' : ''}：${passed}/${results.length} 通过；截图目录 ${shotDir}`)
process.exit(passed === results.length ? 0 : 1)
