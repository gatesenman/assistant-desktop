// v0.4 功能端到端：连接器 UI、技能、编排、机器、通道（微信桥）
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { startFakeServer } from './fake-openai.mjs'
import http from 'http'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shotDir = path.resolve(process.argv[2] || path.join(root, 'e2e-screenshots'))
fs.mkdirSync(shotDir, { recursive: true })
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-v04-'))
const userData = path.join(tmp, 'userData')
fs.mkdirSync(userData)
const { server, url } = await startFakeServer({})
const KEY = 'sk-e2e-v04'
fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({
  settings: { baseUrl: url + '/v1', apiKey: KEY, model: 'mock-gpt', setupDone: true, workDir: tmp },
  assistants: [{ id: 'a-main', name: '小助手', systemPrompt: '', color: '#6366f1', memory: [], createdAt: Date.now() }],
  routines: []
}))
const env = { ...process.env, ASSISTANT_USER_DATA: userData, ASSISTANT_E2E: '1', XDG_CONFIG_HOME: path.join(tmp, 'xdg') }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox', '--disable-gpu'], env, timeout: 60000 })
const page = await app.firstWindow()
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 })
async function step(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`▶ ${name} … `)
  try {
    const d = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, detail: d || '' })
    console.log(`✅ (${Date.now() - t0}ms)${d ? ' ' + d : ''}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).split('\n')[0] })
    console.log(`❌ ${String(e?.message || e).split('\n').slice(0, 2).join(' | ')}`)
    await page.screenshot({ path: path.join(shotDir, `FAIL-V04-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {})
  }
}
const assert = (c, m) => { if (!c) throw new Error(m) }
const shot = (n) => page.screenshot({ path: path.join(shotDir, `${n}.png`) })

await step('V01 连接器面板：添加 Telegram 连接器（假 token，测试接口可失败但 UI 保存）', async () => {
  await page.getByTestId('tab-connectors').click()
  await page.getByTestId('connectors-view').waitFor()
  await page.getByTestId('pack-telegram').click()
  await page.getByTestId('conn-field-botToken').fill('123456:TESTTOKEN')
  await page.getByTestId('connector-save').click()
  await sleep(800)
  assert((await page.locator('[data-testid^="connector-row-"]').count()) >= 1, '没有连接器行')
  await shot('50-connectors')
})

await step('V02 技能：打开内置邮件分拣并看到 SKILL 内容', async () => {
  await page.getByTestId('tab-skills').click()
  await page.getByTestId('skills-view').waitFor()
  await page.getByTestId('skill-builtin/email-triage').click()
  await page.getByTestId('skill-body').waitFor()
  const t = await page.getByTestId('skill-body').inputValue()
  assert(t.includes('邮件分拣'), t.slice(0, 80))
  await page.getByTestId('workflow-new').click()
  await sleep(400)
  assert((await page.locator('[data-testid^="workflow-"]').count()) >= 1, '无工作流')
  await shot('50-skills-workflows')
})

await step('V03 任务编排：拆分目标并显示时间线', async () => {
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('orch-panel-btn').click()
  await page.getByTestId('orchestrator-panel').waitFor()
  await page.getByTestId('orch-goal').fill('先列目录；然后读 readme；最后总结')
  await page.getByTestId('orch-create').click()
  await page.locator('[data-testid^="orch-job-"]').first().waitFor({ timeout: 10000 })
  await page.locator('[data-testid="orch-timeline"]').first().waitFor()
  assert((await page.locator('.timeline-row').count()) >= 2, '编排步骤不足')
  await shot('50-orchestrator')
  const id = await page.locator('[data-testid^="orch-job-"]').first().getAttribute('data-testid')
  const jobId = id.replace('orch-job-','')
})

await step('V04 电脑/远程面板：本机目标 + 开启伴侣监听', async () => {
  await page.getByTestId('tab-machines').click()
  await page.getByTestId('machines-view').waitFor()
  await page.getByTestId('machine-local').waitFor()
  await page.getByTestId('remote-start').click()
  await sleep(1500)
  await shot('50-machines-remote')
})

await step('V05 消息通道：微信桥健康检查', async () => {
  await page.getByTestId('tab-channels').click()
  await page.getByTestId('channels-view').waitFor()
  await page.getByTestId('channel-kind-wechat_bridge').click()
  await page.getByTestId('channel-save').click()
  await sleep(600)
  // 直接测桥端口（主进程 ensureBridge 默认 8791）
  let ok = false
  for (const port of [8791, 8792, 8793]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      if (r.ok) { ok = true; break }
    } catch {}
  }
  assert(ok || (await page.locator('[data-testid^="channel-row-"]').count()) >= 1, '微信桥未启动且无通道行')
  await shot('50-channels')
})

await app.close().catch(() => {})
server.close()
const passed = results.filter((r) => r.ok).length
fs.writeFileSync(path.join(shotDir, 'e2e-v04-results.json'), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.log(`\nv0.4 端到端：${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)
