import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = '/workspace/assistant-desktop'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-debug-'))
const userData = path.join(tmp, 'ud')
fs.mkdirSync(userData)
fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({
  settings: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', setupDone: true, workDir: tmp, theme: 'dark', computerEnabled: true, trustedMode: true },
  assistants: [{ id: 'a-main', name: '小助手', systemPrompt: '', color: '#6366f1', memory: [], createdAt: Date.now(), computerMode: 'this', computerEnabled: true, runStyle: 'auto', pinned: true, workDir: tmp }],
  routines: [], folders: [], threads: []
}))
const env = { ...process.env, ASSISTANT_USER_DATA: userData, ASSISTANT_E2E: '1', XDG_CONFIG_HOME: path.join(tmp, 'xdg') }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox', '--disable-gpu'], env, timeout: 60000 })
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()) })
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 })
await page.waitForTimeout(800)
console.log('btn count', await page.getByTestId('global-settings-btn').count())
await page.getByTestId('global-settings-btn').click()
await page.waitForTimeout(1500)
console.log('settings count', await page.getByTestId('global-settings').count())
console.log('body text', (await page.locator('body').innerText()).slice(0, 500))
await page.screenshot({ path: '/tmp/gs-debug.png' })
const html = await page.content()
fs.writeFileSync('/tmp/gs-debug.html', html)
await app.close()
console.log('done')
