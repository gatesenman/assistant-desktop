// v0.6 多系统本地虚拟电脑：OS 选择卡片 / 每卡选中 / 预检（真实 + 模拟宿主）/ Linux 实际流程 / 诊断导出
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { startFakeServer } from './fake-openai.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shotDir = path.resolve(process.argv[2] || path.join(root, 'e2e-screenshots'))
fs.mkdirSync(shotDir, { recursive: true })
const results = []
const notes = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-v06-'))
const userData = path.join(tmp, 'userData')
fs.mkdirSync(userData)
const { server, url } = await startFakeServer({})
fs.writeFileSync(
  path.join(userData, 'state.json'),
  JSON.stringify({
    settings: { baseUrl: url + '/v1', apiKey: 'sk-e2e-v06', model: 'mock-gpt', setupDone: true, workDir: tmp, theme: 'dark', computerEnabled: true, trustedMode: false },
    assistants: [
      { id: 'a-main', name: '小助手', systemPrompt: '', color: '#6366f1', memory: [], createdAt: Date.now(), computerMode: 'this', computerEnabled: true, runStyle: 'ask', pinned: true, workDir: tmp }
    ],
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
    w?.setSize(1480, 1120)
    w?.center()
  })
  page.on('dialog', (d) => void d.accept())
  await sleep(500)
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
    console.log(`❌ ${String(e?.message || e).split('\n').slice(0, 2).join(' | ')}`)
    await page?.screenshot({ path: path.join(shotDir, `FAIL-V06-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {})
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const shot = (n) => page.screenshot({ path: path.join(shotDir, `${n}.png`) })
async function openVirtual() {
  const panel = page.getByTestId('computer-panel')
  if (!(await panel.count())) await page.getByTestId('computer-panel-btn').click()
  await panel.waitFor()
  await page.getByTestId('computer-target-virtual').click()
  await page.getByTestId('vm-picker').waitFor()
  await sleep(400)
}
async function pick(os) {
  await page.getByTestId(`vm-os-card-${os}`).click()
  await sleep(300)
  assert((await page.getByTestId(`vm-os-card-${os}`).getAttribute('aria-pressed')) === 'true', `${os} 卡片未选中`)
}
async function preflight(os) {
  await pick(os)
  await page.getByTestId('vm-preflight').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="vm-hint"]')?.textContent?.includes('预检') && !document.querySelector('[data-testid="vm-hint"]')?.textContent?.includes('正在预检'), null, { timeout: 150000 })
  const box = page.getByTestId('vm-preflight-result')
  await box.waitFor()
  await box.scrollIntoViewIfNeeded()
  return (await box.textContent()) || ''
}
const badge = async (os) => ((await page.getByTestId(`vm-badge-${os}`).textContent()) || '').trim()

/* ============ A：真实环境 ============ */
await launch()

await step('V01 选择系统：三张 OS 卡片', async () => {
  await openVirtual()
  for (const os of ['linux', 'windows', 'macos']) await page.getByTestId(`vm-os-card-${os}`).waitFor()
  const txt = (await page.getByTestId('vm-os-cards').textContent()) || ''
  assert(txt.includes('Linux 桌面') && txt.includes('Windows 桌面') && txt.includes('macOS 桌面'), '卡片标题缺失')
  assert(txt.includes('需要 KVM'), '资源要求缺失')
  await shot('v06-01-os-picker')
})

await step('V02a 选中 Linux 卡片', async () => {
  await pick('linux')
  await shot('v06-02-card-linux')
})
await step('V02b 选中 Windows 卡片 + 版本 / 资源设置', async () => {
  await pick('windows')
  const opts = await page.getByTestId('vm-version').locator('option').allTextContents()
  assert(opts.some((o) => o.includes('Windows 11')) && opts.some((o) => o.includes('Windows 10')) && opts.some((o) => o.includes('Server')), '版本列表不全：' + opts.join(','))
  await page.getByTestId('vm-adv-toggle').click()
  await page.getByTestId('vm-resources').waitFor()
  const vals = await page.getByTestId('vm-resources').locator('input').evaluateAll((els) => els.map((e) => e.value))
  assert(vals.join(',') === '4,2,64', '默认资源应为 4G/2核/64G，实际 ' + vals.join(','))
  await shot('v06-02-card-windows')
  return opts.length + ' 个版本'
})
await step('V02c 选中 macOS 卡片 + 许可提示', async () => {
  await pick('macos')
  const lic = (await page.getByTestId('vm-license-macos').textContent()) || ''
  assert(lic.includes('Apple 硬件'), '缺少 Apple 许可提示')
  const opts = await page.getByTestId('vm-version').locator('option').allTextContents()
  assert(opts.some((o) => o.includes('Sequoia')) && opts.some((o) => o.includes('Sonoma')) && opts.some((o) => o.includes('Ventura')), 'macOS 版本缺失')
  await shot('v06-02-card-macos')
})

await step('V03 记住上次选择（重启后仍为 macOS）', async () => {
  await close()
  await launch()
  await openVirtual()
  assert((await page.getByTestId('vm-os-card-macos').getAttribute('aria-pressed')) === 'true', '重启后未记住 macOS')
})

await step('V04 Windows 预检（真实环境）', async () => {
  const t = await preflight('windows')
  await shot('v06-04-preflight-windows-real')
  notes.push('Windows 真实预检：' + t.replace(/\s+/g, ' ').slice(0, 400))
  assert(t.includes('Docker') && t.includes('磁盘') && t.includes('KVM'), '预检项不全')
  return t.includes('KVM 硬件虚拟化：已检测到') ? 'KVM ✓' : 'KVM ✗/⚠'
})
await step('V05 macOS 预检（真实环境）', async () => {
  const t = await preflight('macos')
  await shot('v06-05-preflight-macos-real')
  notes.push('macOS 真实预检：' + t.replace(/\s+/g, ' ').slice(0, 400))
  assert(t.includes('KVM'), '缺少 KVM 项')
})

await step('V06 Linux 预检', async () => {
  const t = await preflight('linux')
  await shot('v06-06-preflight-linux')
  notes.push('Linux 预检：' + t.replace(/\s+/g, ' ').slice(0, 300))
  assert(!t.includes('KVM'), 'Linux 不应检查 KVM')
})

if (dockerOk) {
  await step('V07 Linux 虚拟电脑：创建并启动 → 运行中', async () => {
    await pick('linux')
    await page.getByTestId('vm-start').click()
    await page.waitForFunction(() => (document.querySelector('[data-testid="vm-badge-linux"]')?.textContent || '').includes('运行中'), null, { timeout: 900000, polling: 2000 })
    await page.getByTestId('vm-row-linux').waitFor()
    await page.getByTestId('vm-row-linux').scrollIntoViewIfNeeded()
    await shot('v06-07-linux-running')
    const st = await page.evaluate(() => window.api.getState())
    assert(st.settings.activeMachineId === 'vm-local', '控制目标未切到 Linux VM：' + st.settings.activeMachineId)
  })
  await step('V08 内嵌桌面（iframe noVNC）', async () => {
    await page.getByTestId('vm-open-linux').click()
    await page.getByTestId('vm-viewer').waitFor()
    const src = await page.getByTestId('vm-viewer-frame').getAttribute('src')
    assert(/127\.0\.0\.1:\d+\/vnc\.html/.test(src || ''), 'iframe src 异常：' + src)
    await sleep(6000)
    await shot('v06-08-linux-embedded-desktop')
    await page.getByTestId('vm-viewer-close').click()
    return src
  })
  await step('V09 电脑预览来自 Linux VM（computer:preview）', async () => {
    const r = await page.evaluate(() => window.api.captureComputerPreview())
    assert(r && r.thumb && r.thumb.startsWith('data:image/jpeg'), '无 VM 截图')
  })
  await step('V10 休眠（pause）→ 唤醒 → 停止 → 启动', async () => {
    await page.getByTestId('vm-sleep-linux').click()
    await page.waitForFunction(() => (document.querySelector('[data-testid="vm-badge-linux"]')?.textContent || '').includes('已休眠'), null, { timeout: 60000 })
    const paused = execSync('docker inspect -f "{{.State.Paused}}" assistant-desktop-vm').toString().trim()
    assert(paused === 'true', 'docker 未暂停')
    await shot('v06-10-linux-sleeping')
    await page.getByTestId('vm-resume-linux').click()
    await page.waitForFunction(() => (document.querySelector('[data-testid="vm-badge-linux"]')?.textContent || '').includes('运行中'), null, { timeout: 120000 })
    await page.getByTestId('vm-stop-linux').click()
    await page.waitForFunction(() => (document.querySelector('[data-testid="vm-badge-linux"]')?.textContent || '').includes('已停止'), null, { timeout: 120000 })
    await page.getByTestId('vm-resume-linux').click()
    await page.waitForFunction(() => (document.querySelector('[data-testid="vm-badge-linux"]')?.textContent || '').includes('运行中'), null, { timeout: 120000 })
  })
}

await step('V11 助手设置：显示当前控制目标与虚拟电脑系统', async () => {
  await page.evaluate(() => window.api.updateAssistant('a-main', { computerMode: 'virtual' }))
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('bot-active-target').waitFor()
  await page.getByTestId('bot-vm-os').waitFor()
  const t = (await page.getByTestId('bot-active-target').textContent()) || ''
  await page.getByTestId('bot-active-target').scrollIntoViewIfNeeded()
  await shot('v06-11-agent-settings-target')
  await page.getByTestId('tab-chat').click()
  return t.trim()
})

await step('V12 诊断导出列出所有 VM', async () => {
  const r = await page.evaluate(() => window.api.exportLogs())
  assert(r.ok, r.message)
  const text = fs.readFileSync(r.path, 'utf8')
  for (const k of ['"vms"', 'assistant-desktop-vm', 'assistant-desktop-win', 'assistant-desktop-mac', '"windows"', '"macos"']) assert(text.includes(k), '诊断缺少 ' + k)
})

if (dockerOk) {
  await step('V13 删除 Linux 虚拟电脑容器', async () => {
    await openVirtual()
    await page.getByTestId('vm-delete-linux').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="vm-row-linux"]'), null, { timeout: 60000 })
    let exists = true
    try {
      execSync('docker inspect assistant-desktop-vm', { stdio: 'pipe' })
    } catch {
      exists = false
    }
    assert(!exists, '容器仍存在')
  })
}
await close()

/* ============ B：模拟 Windows 11 宿主缺 KVM ============ */
await launch({ ASSISTANT_E2E_KVM_PROBE: JSON.stringify({ host: 'win32', state: 'missing', windowsBuild: 22631, detail: 'docker run --device /dev/kvm 失败' }) })
await step('V14 [模拟 Windows 宿主] Windows 预检：KVM 缺失友好提示', async () => {
  await openVirtual()
  const t = await preflight('windows')
  assert(t.includes('WSL2 嵌套虚拟化') && t.includes('nestedVirtualization=true'), '缺少修复步骤')
  await shot('v06-14-preflight-windows-kvm-missing-simulated-winhost')
})
await step('V15 [模拟 Windows 宿主] macOS 预检 + 点启动 → 需要 KVM（不出现晦涩错误）', async () => {
  const t = await preflight('macos')
  assert(t.includes('KVM') && t.includes('BIOS'), '缺少 KVM 文案')
  await page.getByTestId('vm-start').click()
  await page.waitForFunction(() => /需要 KVM|需要 Docker/.test(document.querySelector('[data-testid="vm-badge-macos"]')?.textContent || ''), null, { timeout: 150000 })
  await page.getByTestId('vm-preflight-result').scrollIntoViewIfNeeded()
  await shot('v06-15-preflight-macos-kvm-missing-simulated-winhost')
  return await badge('macos')
})
await close()

await launch({ ASSISTANT_E2E_KVM_PROBE: JSON.stringify({ host: 'win32', state: 'missing', windowsBuild: 19045 }) })
await step('V16 [模拟 Windows 10 宿主] 说明需要 Windows 11', async () => {
  await openVirtual()
  const t = await preflight('windows')
  assert(t.includes('Windows 10') && t.includes('Windows 11'), '未提示 Windows 10 不支持')
  await shot('v06-16-preflight-windows-win10-host-simulated')
})
await close()

await launch({ ASSISTANT_E2E_KVM_PROBE: JSON.stringify({ host: 'darwin', state: 'unsupported_host' }) })
await step('V17 [模拟 Mac 宿主] macOS 预检：Docker Desktop 不提供 KVM', async () => {
  await openVirtual()
  const t = await preflight('macos')
  assert(t.includes('不向容器提供 KVM'), '缺少 Mac 宿主说明')
  await shot('v06-17-preflight-macos-mac-host-simulated')
})
await close()

/* ============ D：可选，Windows 真实容器启动（仅到下载/安装阶段） ============ */
if (dockerOk && process.env.E2E_WIN_PARTIAL === '1') {
  await launch({ ASSISTANT_E2E_DISK_FREE_GB: '200' })
  await step('V18 Windows 真实容器：创建 → Web 查看器 → 下载/安装进度', async () => {
    await openVirtual()
    await pick('windows')
    await page.getByTestId('vm-start').click()
    await page.waitForFunction(() => /安装中|运行中|出错|需要/.test(document.querySelector('[data-testid="vm-badge-windows"]')?.textContent || ''), null, { timeout: 900000, polling: 2000 })
    const b = await badge('windows')
    assert(!/出错|需要/.test(b), 'Windows 启动失败：' + b + ' ' + ((await page.getByTestId('vm-hint').textContent()) || ''))
    await sleep(45000)
    await page.getByTestId('vm-row-windows').scrollIntoViewIfNeeded()
    await shot('v06-18-windows-container-installing')
    await page.getByTestId('vm-open-windows').click()
    await page.getByTestId('vm-viewer').waitFor()
    await sleep(8000)
    await shot('v06-19-windows-embedded-viewer-installing')
    await page.getByTestId('vm-viewer-close').click()
    const logs = await page.evaluate(() => window.api.vmLogs('windows'))
    notes.push('Windows 容器日志尾部：' + logs.slice(-600).replace(/\s+/g, ' '))
    // 清理：删除容器与磁盘卷（避免撑满测试机磁盘）
    await page.evaluate(() => window.api.vmDelete('windows', true))
    return b
  })
  await close()
}

const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join(shotDir, 'v06-results.json'), JSON.stringify({ results, notes }, null, 2))
console.log('\nNOTES:\n' + notes.join('\n'))
console.log(`\n${results.length - failed.length}/${results.length} passed`)
server.close()
process.exit(failed.length ? 1 : 0)
