import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import fs from 'fs'
import { BrowserManager } from '../src/main/core/browser'
import { startServer, type MockServer } from './helpers'

const PAGE = `<!doctype html><html><head><title>测试表单</title></head><body>
<h1>浏览器测试页</h1><input id="name" placeholder="姓名"><button id="go" onclick="document.getElementById('result').textContent='你好，'+document.getElementById('name').value">提交</button>
<p id="result">尚未提交</p></body></html>`

let srv: MockServer
let available = false
try {
  available = fs.existsSync(chromium.executablePath())
} catch {
  available = false
}

beforeAll(async () => {
  srv = await startServer((_b, _req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
})
afterAll(async () => srv.close())

describe.skipIf(!available)('browser automation (real chromium)', () => {
  it('opens, types, clicks, reads text and screenshots', async () => {
    const bm = new BrowserManager(() => ({ headless: true, executablePath: '' }))
    try {
      const open = await bm.execute('a1', 'browser_open', { url: srv.url + '/page' })
      expect(open.text).toContain('测试表单')
      expect(open.text).toContain('浏览器测试页')
      await bm.execute('a1', 'browser_type', { selector: '#name', text: '小明' })
      const click = await bm.execute('a1', 'browser_click', { text: '提交' })
      expect(click.text).toContain('已点击')
      const t = await bm.execute('a1', 'browser_get_text', { selector: '#result' })
      expect(t.text).toContain('你好，小明')
      const shot = await bm.execute('a1', 'browser_screenshot', {})
      expect(shot.images![0]).toMatch(/^data:image\/jpeg;base64,/)
      expect(shot.images![0].length).toBeGreaterThan(2000)
      await expect(bm.execute('other', 'browser_click', { text: 'x' })).rejects.toThrow(/browser_open/)
      await expect(bm.execute('a1', 'browser_open', { url: 'javascript:alert(1)' })).rejects.toThrow()
    } finally {
      await bm.close()
    }
  }, 60000)
})

describe('browser manager errors', () => {
  it('gives a helpful error when no browser can be launched', async () => {
    const bm = new BrowserManager(
      () => ({ headless: true, executablePath: '' }),
      async () => ({ launch: async () => Promise.reject(new Error('not installed')) }) as any
    )
    await expect(bm.execute('a', 'browser_open', { url: 'http://x' })).rejects.toThrow(/安装 Chromium/)
  })
})
