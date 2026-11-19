// 真实模型端到端测试（DeepSeek）。密钥只从环境变量 MODEL_API_KEY 读取并传给应用进程，不写入任何文件或输出。
// 用法：MODEL_API_KEY=... E2E_SCRIPT=run-real.mjs bash e2e/run.sh [截图目录]
import { _electron as electron, chromium } from 'playwright'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { startFakeServer } from './fake-openai.mjs'

const KEY = process.env.MODEL_API_KEY
if (!KEY) {
  console.log('未设置 MODEL_API_KEY，跳过真实模型测试')
  process.exit(2)
}
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shotDir = path.resolve(process.argv[2] || path.join(root, 'e2e-screenshots'))
fs.mkdirSync(shotDir, { recursive: true })
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-real-'))
const userData = path.join(tmp, 'userData')
const workDir = path.join(tmp, 'work')
const binDir = path.join(tmp, 'bin')
for (const d of [userData, workDir, binDir]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(workDir, 'readme.txt'), '这是测试目录')

// 本地测试页（网页抓取 / 电脑控制）由测试服务器提供；它不调用任何模型
const chromeProfile = path.join(tmp, 'chrome-profile')
const { server, log, url } = await startFakeServer({ chromium: chromium.executablePath(), chromeProfile })
// 电脑控制用的启动器：模型通过 open_app 打开「deskpage」
fs.writeFileSync(
  path.join(binDir, 'deskpage'),
  `#!/bin/sh\nexec "${chromium.executablePath()}" --app=${url}/desk-page --window-position=0,0 --window-size=900,620 --no-sandbox --disable-gpu --no-first-run --no-default-browser-check --user-data-dir=${chromeProfile} "$@"\n`,
  { mode: 0o755 }
)

const mk = (id, name, color) => ({ id, name, systemPrompt: '', color, memory: [], createdAt: Date.now() })
fs.writeFileSync(
  path.join(userData, 'state.json'),
  JSON.stringify({
    settings: { workDir, browserHeadless: true, closeToTray: true, temperature: 0.3 },
    assistants: [mk('a-main', '小助手', '#6366f1'), mk('w1', '写手01', '#ec4899'), mk('w2', '写手02', '#f59e0b'), mk('w3', '写手03', '#10b981')],
    routines: [{ id: 'r1', assistantId: 'a-main', name: '报时', cron: '0 9 * * *', prompt: '这是定时任务：请只回复一句「定时任务已执行」。', enabled: true, createdAt: Date.now() }]
  })
)

const env = { ...process.env, ASSISTANT_USER_DATA: userData, ASSISTANT_E2E: '1', XDG_CONFIG_HOME: path.join(tmp, 'xdg'), DEEPSEEK_API_KEY: KEY, PATH: `${binDir}:${process.env.PATH}` }
delete env.MODEL_API_KEY
delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.E2E_EXECUTABLE ? path.resolve(process.env.E2E_EXECUTABLE) : null
const app = await electron.launch({ executablePath: packaged || electronPath, args: [...(packaged ? [] : [root]), '--no-sandbox', '--disable-gpu'], env, timeout: 60000 })
const page = await app.firstWindow()
page.on('console', (m) => m.type() === 'error' && console.log('  [renderer error]', m.text().replaceAll(KEY, '***').slice(0, 300)))
const hook = (fn) => app.evaluate(fn)
const scrub = (s) => String(s).replaceAll(KEY, '***')

async function step(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`▶ ${name} … `)
  try {
    const d = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, detail: scrub(d || '') })
    console.log(`✅ (${((Date.now() - t0) / 1000).toFixed(1)}s)${d ? ' ' + scrub(d) : ''}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: scrub(String(e?.message || e).split('\n')[0]) })
    console.log(`❌ ${scrub(String(e?.message || e).split('\n').slice(0, 3).join(' | '))}`)
    await shot(`FAIL-R-${name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60)}`).catch(() => {})
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const shot = (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) })
async function send(text) {
  await page.getByTestId('send-btn').waitFor({ timeout: 180000 })
  const ta = page.getByTestId('composer')
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
  await sleep(500)
}
/** 等待当前助手回复结束，返回最后一条助手消息文本 */
async function waitDone(timeout = 180000) {
  await page.getByTestId('send-btn').waitFor({ timeout })
  await sleep(300)
  return (await page.locator('.msg.assistant').last().innerText()).trim()
}
const lastErr = async () => ((await page.getByTestId('msg-error').count()) ? await page.getByTestId('msg-error').last().innerText() : '')
async function approveAll(until, timeout = 180000) {
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < timeout) {
    const btn = page.getByTestId('approve-btn')
    if (await btn.count()) {
      await btn.first().click().catch(() => {})
      n++
      await sleep(300)
      continue
    }
    if (await until()) return n
    await sleep(400)
  }
  throw new Error('等待超时')
}
const isIdle = async () => (await page.getByTestId('send-btn').count()) > 0
async function openGlobal() {
  await page.getByTestId('global-settings-btn').click()
  await page.getByTestId('global-settings').waitFor()
}
const closeGlobal = () => page.getByTestId('global-settings').getByRole('button', { name: '返回' }).click()

await step('R01 首次启动向导：环境变量预填 DeepSeek → 连接并检测能力 → 进入应用', async () => {
  await page.getByTestId('setup-wizard').waitFor({ timeout: 30000 })
  await page.getByText('检测到环境变量 DEEPSEEK_API_KEY').waitFor()
  await page.getByTestId('setup-test').click()
  const r = page.getByTestId('setup-result')
  await r.waitFor({ timeout: 120000 })
  const ok = (await r.getAttribute('data-ok')) === '1'
  const text = await r.innerText()
  assert(ok, text)
  await shot('40-real-setup-deepseek')
  await page.getByTestId('setup-finish').click()
  await page.getByTestId('app-root').waitFor()
  const st = fs.readFileSync(path.join(userData, 'state.json'), 'utf8')
  assert(!st.includes(KEY), 'state.json 含明文 Key')
  return text.replace(/\s+/g, ' ').slice(0, 90)
})

await step('R02 流式对话', async () => {
  await send('用一句话介绍你自己，不超过30字。')
  await page.getByTestId('stop-btn').waitFor({ timeout: 20000 })
  const t = await waitDone()
  assert(t.length > 5 && !(await lastErr()), '回复异常：' + t + (await lastErr()))
  await shot('41-real-chat-stream')
  return t.slice(0, 50)
})

await step('R03 shell 工具（需审批）', async () => {
  await send('请用 run_shell 工具执行命令 echo real-e2e-42，然后告诉我输出。')
  await page.getByTestId('approval-card').waitFor({ timeout: 120000 })
  await shot('42-real-shell-approval')
  await approveAll(isIdle)
  const t = await waitDone()
  assert(t.includes('real-e2e-42'), '回复中没有命令输出：' + t.slice(0, 200))
})

await step('R04 写文件（审批）+ 读文件', async () => {
  await send('请用 write_file 在工作目录创建 note.txt，内容为 hello-deepseek；然后用 read_file 读出来，告诉我内容。')
  await approveAll(isIdle)
  const t = await waitDone()
  const f = path.join(workDir, 'note.txt')
  assert(fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('hello-deepseek'), '文件没有写入')
  assert((await page.locator('[data-tool="read_file"][data-status="done"]').count()) > 0, '没有调用 read_file')
  return t.slice(0, 60)
})

await step('R05 网页抓取 web_fetch', async () => {
  await send(`请用 web_fetch 抓取 ${url}/test-page ，告诉我页面的 h1 标题。`)
  await approveAll(isIdle)
  const t = await waitDone()
  assert(t.includes('浏览器自动化测试页'), t.slice(0, 200))
})

await step('R06 长期记忆 save_memory', async () => {
  await send('请记住：我最喜欢的颜色是青色。')
  await approveAll(isIdle)
  await waitDone()
  const st = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'))
  const mem = st.assistants.find((a) => a.id === 'a-main').memory.map((m) => m.text).join('；')
  assert(mem.includes('青色'), '记忆没有保存：' + mem)
  return mem
})

await step('R07 后台子任务 spawn_task', async () => {
  const before = (await hook(() => globalThis.__assistantE2E.tasks())).length
  await send('请用 spawn_task 启动一个后台子任务：用 list_dir 列出工作目录的文件并汇报。启动后直接回复「已启动」。')
  await approveAll(isIdle)
  await waitDone()
  let task
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    const ts = (await hook(() => globalThis.__assistantE2E.tasks())).filter((t) => !t.groupId)
    task = ts.slice(before)[0] || ts.at(-1)
    if (ts.length > before && ['done', 'error', 'cancelled'].includes(task.status)) break
    await sleep(1000)
  }
  assert(task && task.status === 'done', '子任务状态：' + task?.status)
  assert(/note\.txt|readme\.txt/.test(task.result || ''), '子任务结果不含文件：' + (task.result || '').slice(0, 120))
  await waitDone(120000)
  return `「${task.title}」完成`
})

await step('R08 多智能体：委派 3 个助手并行执行，汇总结果', async () => {
  await send('请用 delegate_to_agent 一次性把三个子任务同时委派出去：写手01 写苹果的广告语，写手02 写香蕉的广告语，写手03 写橙子的广告语（每条不超过15字）。完成后汇总三条。')
  await approveAll(isIdle, 300000)
  const t = await waitDone(300000)
  const ts = (await hook(() => globalThis.__assistantE2E.tasks())).filter((x) => x.groupId)
  const g = ts.at(-1)?.groupId
  const grp = ts.filter((x) => x.groupId === g)
  assert(grp.length === 3 && grp.every((x) => x.status === 'done'), '委派任务：' + JSON.stringify(grp.map((x) => [x.title, x.status])))
  const overlap = Math.max(...grp.map((x) => x.startedAt)) < Math.min(...grp.map((x) => x.finishedAt))
  assert(overlap, '三个任务没有并行')
  await page.getByTestId('parallel-panel-btn').click()
  await sleep(500)
  await shot('43-real-parallel-delegation')
  await page.getByTestId('parallel-panel-btn').click()
  return `并行：${grp.map((x) => ((x.finishedAt - x.startedAt) / 1000).toFixed(1) + 's').join(' / ')}；汇总 ${t.length} 字`
})

await step('R09 定时任务（立即运行）', async () => {
  await page.getByTestId('tab-routines').click()
  await page.getByRole('button', { name: '立即运行' }).first().click()
  await page.getByTestId('tab-chat').click()
  await page.locator('.routine-tag').last().waitFor({ timeout: 120000 })
  await sleep(1000)
  const t = await waitDone()
  assert(t.includes('定时任务'), t.slice(0, 100))
  return t.replace(/\s+/g, ' ').slice(0, 40)
})

await step('R10 电脑控制（纯文本模型 deepseek-v4-pro → 自动切换 OCR 文字模式）：打开测试页、输入、提交、确认', async () => {
  await openGlobal()
  await page.getByTestId('model').fill('deepseek-v4-pro')
  await page.getByTestId('settings-save').click()
  await sleep(300)
  await page.getByTestId('test-conn').click()
  await page.getByTestId('test-result').waitFor({ timeout: 180000 })
  const capText = await page.getByTestId('test-result').innerText()
  const vision = await page.getByTestId('cap-vision').getAttribute('data-value')
  if (!(await page.getByTestId('trusted-mode').isChecked())) await page.getByTestId('trusted-mode').click()
  await closeGlobal()
  await page.getByTestId('send-btn').waitFor()
  await send('请控制电脑完成：1) 用 open_app 打开应用 deskpage（会打开一个测试网页）；2) 在页面的输入框里输入 Hello 电脑；3) 点击「提交」按钮；4) 再看一次屏幕，确认页面显示「已提交」后告诉我结果。')
  const t0 = Date.now()
  while (Date.now() - t0 < 420000 && !(await isIdle())) await sleep(1000)
  const t = await waitDone(10000)
  await shot('44-real-computer-text-mode-chat')
  const toolTexts = await page.locator('[data-tool="computer_screenshot"], [data-tool="mouse_click"], [data-tool="type_text"]').count()
  assert(log.deskResult === 'Hello 电脑', `测试页收到：${log.deskResult ?? '（无）'}；模型回复：${t.slice(0, 120)}`)
  return `能力：${capText.replace(/\s+/g, ' ').slice(0, 60)}（vision=${vision}）；电脑工具调用 ${toolTexts} 次；页面收到「${log.deskResult}」`
})

try {
  execFileSync('pkill', ['-f', 'desk-page'])
} catch {}
// 导出日志并检查没有泄露密钥
await step('R11 导出诊断日志不含密钥', async () => {
  await openGlobal()
  await page.getByTestId('export-logs').click()
  await page.getByTestId('export-result').waitFor()
  const file = (await page.getByTestId('export-result').innerText()).replace(/^已导出到\s*/, '').trim()
  const all = [file, path.join(userData, 'state.json'), path.join(userData, 'logs', 'main.log')].filter((f) => fs.existsSync(f))
  for (const f of all) assert(!fs.readFileSync(f, 'utf8').includes(KEY), '密钥泄露到 ' + path.basename(f))
  return `已检查 ${all.length} 个文件`
})
await app.close().catch(() => {})
server.close()
const passed = results.filter((r) => r.ok).length
fs.writeFileSync(path.join(shotDir, 'e2e-real-deepseek-results.json'), JSON.stringify({ model: 'deepseek-chat / deepseek-v4-pro', passed, total: results.length, results, at: new Date().toISOString() }, null, 2))
console.log(`\n真实模型（DeepSeek）端到端测试：${passed}/${results.length} 通过`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
