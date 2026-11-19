import { app, type BrowserWindow } from 'electron'
import type { Store } from './core/store'
import type { Scheduler } from './core/scheduler'

/**
 * 无界面冒烟测试：ASSISTANT_SMOKE=1 时启用。
 * 检查渲染进程是否正常渲染；若提供了 ASSISTANT_SMOKE_BASEURL（模拟接口），
 * 还会通过 UI 发送一条消息并等待流式回复出现在页面中。
 */
export function runSmokeTest(win: BrowserWindow, ctx: { store: Store; scheduler: Scheduler }): void {
  const log = (...a: unknown[]): void => console.log('[SMOKE]', ...a)
  const fail = (msg: string): void => {
    console.log('[SMOKE] FAIL', msg)
    app.exit(1)
  }
  const timer = setTimeout(() => fail('超时'), 60000)
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log('renderer console:', message)
  })
  win.webContents.on('render-process-gone', (_e, d) => fail('渲染进程崩溃 ' + d.reason))

  win.webContents.once('did-finish-load', async () => {
    try {
      const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code, true)
      const waitFor = async (code: string, ms = 15000): Promise<any> => {
        const start = Date.now()
        while (Date.now() - start < ms) {
          const v = await js(code)
          if (v) return v
          await new Promise((r) => setTimeout(r, 200))
        }
        throw new Error('等待条件超时: ' + code)
      }
      await waitFor(`!!document.querySelector('[data-testid="app-root"]')`)
      const text: string = await js('document.body.innerText')
      for (const word of ['聊天', '定时任务', '设置']) if (!text.includes(word)) throw new Error('缺少界面文字：' + word)
      log('UI 渲染正常，助手数量', ctx.store.state.assistants.length, '已调度任务', ctx.scheduler.scheduledCount)

      // 主题切换
      await js(`document.querySelector('[data-testid="theme-toggle"]').click()`)
      const theme = await waitFor(`document.documentElement.dataset.theme`)
      log('主题切换后 data-theme =', theme)

      if (process.env.ASSISTANT_SMOKE_BASEURL) {
        await js(`(() => {
          const ta = document.querySelector('[data-testid="composer"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '你好，冒烟测试');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        })()`)
        await waitFor(`document.body.innerText.includes('你好，冒烟测试')`)
        log('用户消息已显示')
        await waitFor(`document.body.innerText.includes('冒烟测试回复完成')`, 20000)
        const hasCode = await js(`!!document.querySelector('.markdown pre code.hljs, .markdown pre code[class*="language-"]')`)
        log('流式回复已渲染，代码高亮:', hasCode)
        // 工具调用审批卡片
        await waitFor(`!!document.querySelector('[data-testid="approve-btn"]')`, 20000)
        log('出现审批卡片')
        await js(`document.querySelector('[data-testid="approve-btn"]').click()`)
        await waitFor(`document.body.innerText.includes('工具执行完毕')`, 20000)
        log('审批后工具执行并得到最终回复')
        const mem = ctx.store.state.assistants[0].memory.length
        log('记忆条数', mem)
      }
      const shotDir = process.env.ASSISTANT_SMOKE_SCREENSHOT
      if (shotDir) {
        const fs = await import('fs')
        const path = await import('path')
        await new Promise((r) => setTimeout(r, 500))
        fs.writeFileSync(path.join(shotDir, 'chat-dark.png'), (await win.webContents.capturePage()).toPNG())
        await js(`document.querySelector('[data-testid="theme-toggle"]').click()`)
        await new Promise((r) => setTimeout(r, 400))
        fs.writeFileSync(path.join(shotDir, 'chat-light.png'), (await win.webContents.capturePage()).toPNG())
        await js(`[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('定时任务')).click()`)
        await new Promise((r) => setTimeout(r, 300))
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('新建任务')).click()`)
        await new Promise((r) => setTimeout(r, 300))
        fs.writeFileSync(path.join(shotDir, 'routines.png'), (await win.webContents.capturePage()).toPNG())
        await js(`[...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === '设置').click()`)
        await new Promise((r) => setTimeout(r, 300))
        fs.writeFileSync(path.join(shotDir, 'assistant-settings.png'), (await win.webContents.capturePage()).toPNG())
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('全局设置')).click()`)
        await new Promise((r) => setTimeout(r, 300))
        fs.writeFileSync(path.join(shotDir, 'global-settings.png'), (await win.webContents.capturePage()).toPNG())
        log('截图已保存到', shotDir)
      }
      clearTimeout(timer)
      log('PASS')
      app.exit(0)
    } catch (e: any) {
      fail(e?.message || String(e))
    }
  })
}
