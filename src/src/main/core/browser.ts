import fs from 'fs'
import path from 'path'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { ToolDef } from './llm'
import { truncate } from './util'

export interface ToolResult {
  text: string
  images?: string[]
  /** 检测到验证码 / 2FA，建议触发人工接管 */
  needsTakeover?: boolean
  takeoverReason?: string
}

export const BROWSER_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: '在自动化浏览器中打开一个网址（每个助手有独立的标签页），返回页面标题和部分文本。',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s) 或 file 地址' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面元素。提供 CSS 选择器 selector，或提供元素上的可见文字 text。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string', description: '按可见文字查找元素' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '在输入框中输入文字（会先清空）。submit=true 时输入后按回车提交。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '输入框的 CSS 选择器' },
          text: { type: 'string' },
          submit: { type: 'boolean' }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '对当前页面截图。截图会显示给用户，并在模型支持视觉时提供给你查看。',
      parameters: { type: 'object', properties: { full_page: { type: 'boolean' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: '获取当前页面（或指定选择器元素）的可见文本。',
      parameters: { type: 'object', properties: { selector: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_state',
      description:
        '获取当前页面可交互元素的编号快照（role / name / a11y），用于后续 browser_click_index / browser_type_index。优先于纯视觉点击。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click_index',
      description: '按 browser_state 返回的元素编号点击。',
      parameters: { type: 'object', properties: { index: { type: 'number', description: '元素编号（从 1 起）' } }, required: ['index'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type_index',
      description: '按 browser_state 返回的元素编号向输入框填入文字；submit=true 时回车提交。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          text: { type: 'string' },
          submit: { type: 'boolean' }
        },
        required: ['index', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description: '按 JSON Schema 从当前页面抽取结构化数据（字段名与类型）。返回符合 schema 的 JSON。',
      parameters: {
        type: 'object',
        properties: {
          schema: {
            type: 'object',
            description: '简易 schema：{ type:"object", properties:{ field:{type,description,selector?} }, required?:string[] }'
          },
          instruction: { type: 'string', description: '可选抽取说明' }
        },
        required: ['schema']
      }
    }
  }
]

export interface BrowserOptions {
  headless: boolean
  executablePath: string
  proxy?: { server: string; bypass?: string }
  /** 使用持久化用户目录（登录态可复用） */
  persistentProfile?: boolean
  /** 持久化 profile 根目录；每助手可再分子目录 */
  profileDir?: string
  /** 连接已打开的 Chrome：http://127.0.0.1:9222 */
  cdpUrl?: string
  /** 是否按助手隔离 profile 子目录 */
  profilePerAssistant?: boolean
}

export interface InteractiveElement {
  index: number
  tag: string
  role: string
  name: string
  type?: string
  href?: string
  value?: string
  placeholder?: string
  bbox?: { x: number; y: number; w: number; h: number }
}

type Chromium = typeof import('playwright-core').chromium

const CAPTCHA_HINT =
  /验证码|captcha|recaptcha|hcaptcha|cloudflare|人机验证|两步验证|双重验证|2fa|two[- ]?factor|one[- ]?time|otp|安全验证|请完成验证/i

/** 基于 playwright-core 的浏览器自动化（懒加载；支持普通启动 / 持久化 profile / CDP） */
export class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private pages = new Map<string, Page>()
  private launching: Promise<BrowserContext> | null = null
  private mode: 'launch' | 'persistent' | 'cdp' | null = null
  private lastState = new Map<string, InteractiveElement[]>()
  private ownedBrowser = true

  constructor(
    private getOptions: () => BrowserOptions,
    private loadChromium: () => Promise<Chromium> = async () => (await import('playwright-core')).chromium
  ) {}

  private async launch(key: string): Promise<BrowserContext> {
    const chromium = await this.loadChromium()
    const opts = this.getOptions()
    const cdp = (opts.cdpUrl || '').trim()
    if (cdp) {
      try {
        this.browser = await chromium.connectOverCDP(cdp)
        this.ownedBrowser = false
        this.mode = 'cdp'
        this.browser.on('disconnected', () => this.reset())
        const ctxs = this.browser.contexts()
        this.context = ctxs[0] || (await this.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' }))
        return this.context
      } catch (e: any) {
        throw new Error(`无法通过 CDP 连接浏览器（${cdp}）：${String(e?.message || e).split('\n')[0]}。请用 --remote-debugging-port 启动 Chrome。`)
      }
    }

    const proxy = opts.proxy ? { proxy: opts.proxy } : {}
    const common = { viewport: { width: 1280, height: 800 }, locale: 'zh-CN' as const }

    if (opts.persistentProfile && opts.profileDir) {
      const userDataDir = opts.profilePerAssistant === false ? opts.profileDir : path.join(opts.profileDir, key.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default')
      fs.mkdirSync(userDataDir, { recursive: true })
      const attempts: { label: string; o: Record<string, unknown> }[] = []
      if (opts.executablePath) attempts.push({ label: opts.executablePath, o: { executablePath: opts.executablePath } })
      attempts.push({ label: 'Playwright Chromium', o: {} })
      attempts.push({ label: 'Google Chrome', o: { channel: 'chrome' } })
      attempts.push({ label: 'Microsoft Edge', o: { channel: 'msedge' } })
      const errors: string[] = []
      for (const a of attempts) {
        try {
          this.context = await chromium.launchPersistentContext(userDataDir, {
            headless: opts.headless,
            ...proxy,
            ...common,
            ...a.o
          })
          this.browser = this.context.browser()
          this.ownedBrowser = true
          this.mode = 'persistent'
          this.context.on('close', () => this.reset())
          return this.context
        } catch (e: any) {
          errors.push(`${a.label}: ${String(e?.message || e).split('\n')[0]}`)
        }
      }
      throw new Error('无法启动持久化浏览器。请在「全局设置 → 浏览器自动化」中安装 Chromium 或填写本机 Chrome 路径。\n' + errors.join('\n'))
    }

    const attempts: { label: string; o: Record<string, unknown> }[] = []
    if (opts.executablePath) attempts.push({ label: opts.executablePath, o: { executablePath: opts.executablePath } })
    attempts.push({ label: 'Playwright Chromium', o: {} })
    attempts.push({ label: 'Google Chrome', o: { channel: 'chrome' } })
    attempts.push({ label: 'Microsoft Edge', o: { channel: 'msedge' } })
    const errors: string[] = []
    for (const a of attempts) {
      try {
        this.browser = await chromium.launch({ headless: opts.headless, ...proxy, ...a.o })
        this.ownedBrowser = true
        this.mode = 'launch'
        this.browser.on('disconnected', () => this.reset())
        this.context = await this.browser.newContext(common)
        return this.context
      } catch (e: any) {
        errors.push(`${a.label}: ${String(e?.message || e).split('\n')[0]}`)
      }
    }
    throw new Error('无法启动浏览器。请在「全局设置 → 浏览器自动化」中点击「安装 Chromium」，或填写本机 Chrome 路径。\n' + errors.join('\n'))
  }

  private reset(): void {
    this.browser = null
    this.context = null
    this.pages.clear()
    this.mode = null
  }

  private async page(key: string, create = true): Promise<Page> {
    let p = this.pages.get(key)
    if (p && !p.isClosed()) return p
    if (!create) throw new Error('浏览器尚未打开页面，请先调用 browser_open')
    if (!this.context) {
      this.launching ??= this.launch(key).finally(() => (this.launching = null))
      await this.launching
    }
    // CDP 模式下优先复用已有页面
    if (this.mode === 'cdp' && this.context!.pages().length) {
      p = this.context!.pages()[0]
    } else {
      p = await this.context!.newPage()
    }
    p.setDefaultTimeout(15000)
    this.pages.set(key, p)
    return p
  }

  private async summary(p: Page): Promise<string> {
    let title = ''
    try {
      title = await p.title()
    } catch {
      /* ignore */
    }
    return `当前页面：${title || '(无标题)'} — ${p.url()}`
  }

  private async settle(p: Page): Promise<void> {
    try {
      await p.waitForLoadState('domcontentloaded', { timeout: 5000 })
      await p.waitForLoadState('networkidle', { timeout: 2500 })
    } catch {
      /* 页面持续有请求时忽略 */
    }
  }

  private async detectTakeover(p: Page): Promise<{ needs: boolean; reason?: string }> {
    try {
      const text = ((await p.innerText('body').catch(() => '')) + ' ' + (await p.title().catch(() => ''))).slice(0, 8000)
      if (CAPTCHA_HINT.test(text)) return { needs: true, reason: '页面疑似出现验证码或两步验证，建议用户接管完成后再交还。' }
      const frames = p.frames()
      for (const f of frames) {
        const u = f.url()
        if (/recaptcha|hcaptcha|challenges\.cloudflare/i.test(u)) return { needs: true, reason: '检测到验证码 iframe，建议用户接管。' }
      }
    } catch {
      /* ignore */
    }
    return { needs: false }
  }

  private withTakeover(base: ToolResult, flag: { needs: boolean; reason?: string }): ToolResult {
    if (!flag.needs) return base
    return { ...base, needsTakeover: true, takeoverReason: flag.reason, text: `${base.text}\n\n⚠ ${flag.reason}` }
  }

  /** 收集可交互元素并编号 */
  async collectState(p: Page): Promise<InteractiveElement[]> {
    const raw = await p.evaluate(() => {
      const sel =
        'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="tab"],[contenteditable="true"]'
      const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[]
      const out: any[] = []
      let i = 0
      for (const el of nodes) {
        if (i >= 120) break
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue
        const tag = el.tagName.toLowerCase()
        const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag)
        const name =
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).placeholder ||
          el.getAttribute('title') ||
          (el as HTMLInputElement).value ||
          (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) ||
          el.getAttribute('name') ||
          ''
        i++
        out.push({
          index: i,
          tag,
          role,
          name,
          type: (el as HTMLInputElement).type || undefined,
          href: (el as HTMLAnchorElement).href || undefined,
          value: (el as HTMLInputElement).value?.slice?.(0, 60),
          placeholder: (el as HTMLInputElement).placeholder || undefined,
          bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        })
        ;(el as any).__adIndex = i
      }
      return out
    })
    return raw as InteractiveElement[]
  }

  private formatState(els: InteractiveElement[], summary: string): string {
    const lines = els.map((e) => {
      const bits = [`[${e.index}]`, e.role || e.tag]
      if (e.name) bits.push(`"${e.name}"`)
      if (e.type) bits.push(`type=${e.type}`)
      if (e.href) bits.push(e.href.slice(0, 60))
      if (e.bbox) bits.push(`@(${e.bbox.x},${e.bbox.y})`)
      return bits.join(' ')
    })
    return `${summary}\n共 ${els.length} 个可交互元素：\n${lines.join('\n')}`
  }

  private async clickByIndex(p: Page, index: number): Promise<void> {
    const ok = await p.evaluate((idx) => {
      const el = Array.from(document.querySelectorAll('*')).find((n: any) => n.__adIndex === idx) as HTMLElement | undefined
      if (!el) return false
      el.scrollIntoView({ block: 'center', inline: 'center' })
      el.click()
      return true
    }, index)
    if (!ok) throw new Error(`找不到编号 ${index} 的元素，请先调用 browser_state`)
  }

  private async typeByIndex(p: Page, index: number, text: string, submit?: boolean): Promise<void> {
    const ok = await p.evaluate(
      ({ idx, text: t, submit: s }) => {
        const el = Array.from(document.querySelectorAll('*')).find((n: any) => n.__adIndex === idx) as HTMLElement | undefined
        if (!el) return false
        el.scrollIntoView({ block: 'center', inline: 'center' })
        el.focus()
        if ('value' in el) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          setter?.call(el, t)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          el.textContent = t
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        if (s) {
          const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
          el.dispatchEvent(e)
          ;(el as HTMLFormElement).form?.requestSubmit?.()
        }
        return true
      },
      { idx: index, text, submit: !!submit }
    )
    if (!ok) throw new Error(`找不到编号 ${index} 的元素，请先调用 browser_state`)
  }

  private async extractBySchema(p: Page, schema: any, instruction?: string): Promise<string> {
    const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
    const keys = Object.keys(props)
    const data: Record<string, unknown> = await p.evaluate(
      ({ keys: ks, props: pr }) => {
        const out: Record<string, unknown> = {}
        const text = (document.body?.innerText || '').slice(0, 50000)
        for (const k of ks) {
          const def = pr[k] || {}
          const sel = def.selector as string | undefined
          if (sel) {
            const el = document.querySelector(sel)
            out[k] = el ? ((el as HTMLInputElement).value || el.textContent || '').trim() : null
            continue
          }
          // 启发式：按字段名在 label/附近找
          const re = new RegExp(String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:：]?\\s*([^\\n]{1,120})', 'i')
          const m = text.match(re)
          out[k] = m ? m[1].trim() : null
        }
        out._pageTextSample = text.slice(0, 500)
        return out
      },
      { keys, props }
    )
    const sample = data._pageTextSample
    delete data._pageTextSample
    for (const k of keys) {
      const t = props[k]?.type
      if (t === 'number' && data[k] != null) {
        const n = Number(String(data[k]).replace(/[^\d.-]/g, ''))
        data[k] = Number.isFinite(n) ? n : null
      }
      if (t === 'boolean' && data[k] != null) data[k] = /^(true|yes|是|1)$/i.test(String(data[k]))
    }
    const note = instruction ? `\n说明：${instruction}` : ''
    return JSON.stringify({ data, sample, note: note || undefined }, null, 2)
  }

  async execute(key: string, name: string, args: Record<string, any>): Promise<ToolResult> {
    switch (name) {
      case 'browser_open': {
        const url = String(args.url || '')
        if (!/^(https?|file):\/\//i.test(url)) throw new Error('仅支持 http(s):// 或 file:// 地址')
        const p = await this.page(key)
        const res = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await this.settle(p)
        const text = await p.innerText('body').catch(() => '')
        const flag = await this.detectTakeover(p)
        return this.withTakeover({ text: `${await this.summary(p)}\nHTTP ${res?.status() ?? '-'}\n\n${truncate(text, 3000)}` }, flag)
      }
      case 'browser_click': {
        const p = await this.page(key, false)
        if (args.selector) await p.locator(String(args.selector)).first().click()
        else if (args.text) await p.getByText(String(args.text), { exact: false }).first().click()
        else throw new Error('需要提供 selector 或 text')
        await this.settle(p)
        const flag = await this.detectTakeover(p)
        return this.withTakeover({ text: `已点击 ${args.selector || `「${args.text}」`}。${await this.summary(p)}` }, flag)
      }
      case 'browser_type': {
        const p = await this.page(key, false)
        const loc = p.locator(String(args.selector)).first()
        await loc.fill(String(args.text ?? ''))
        if (args.submit) {
          await loc.press('Enter')
          await this.settle(p)
        }
        return { text: `已在 ${args.selector} 输入 ${String(args.text ?? '').length} 个字符${args.submit ? '并提交' : ''}。${await this.summary(p)}` }
      }
      case 'browser_screenshot': {
        const p = await this.page(key, false)
        const buf = await p.screenshot({ type: 'jpeg', quality: 70, fullPage: !!args.full_page })
        const flag = await this.detectTakeover(p)
        return this.withTakeover(
          { text: `已截图。${await this.summary(p)}`, images: [`data:image/jpeg;base64,${buf.toString('base64')}`] },
          flag
        )
      }
      case 'browser_get_text': {
        const p = await this.page(key, false)
        const text = args.selector ? await p.locator(String(args.selector)).first().innerText() : await p.innerText('body')
        return { text: `${await this.summary(p)}\n\n${truncate(text, 20000)}` }
      }
      case 'browser_state': {
        const p = await this.page(key, false)
        const els = await this.collectState(p)
        this.lastState.set(key, els)
        const flag = await this.detectTakeover(p)
        return this.withTakeover({ text: this.formatState(els, await this.summary(p)) }, flag)
      }
      case 'browser_click_index': {
        const p = await this.page(key, false)
        const index = Number(args.index)
        if (!Number.isFinite(index) || index < 1) throw new Error('index 须为正整数')
        // 若缓存失效则刷新
        if (!this.lastState.get(key)?.some((e) => e.index === index)) await this.collectState(p).then((els) => this.lastState.set(key, els))
        await this.clickByIndex(p, index)
        await this.settle(p)
        const flag = await this.detectTakeover(p)
        return this.withTakeover({ text: `已点击编号 [${index}]。${await this.summary(p)}` }, flag)
      }
      case 'browser_type_index': {
        const p = await this.page(key, false)
        const index = Number(args.index)
        if (!Number.isFinite(index) || index < 1) throw new Error('index 须为正整数')
        if (!this.lastState.get(key)?.some((e) => e.index === index)) await this.collectState(p).then((els) => this.lastState.set(key, els))
        await this.typeByIndex(p, index, String(args.text ?? ''), !!args.submit)
        if (args.submit) await this.settle(p)
        return {
          text: `已在编号 [${index}] 输入 ${String(args.text ?? '').length} 个字符${args.submit ? '并提交' : ''}。${await this.summary(p)}`
        }
      }
      case 'browser_extract': {
        const p = await this.page(key, false)
        const schema = args.schema
        if (!schema || typeof schema !== 'object') throw new Error('需要提供 schema 对象')
        const json = await this.extractBySchema(p, schema, args.instruction ? String(args.instruction) : undefined)
        return { text: `${await this.summary(p)}\n\n${json}` }
      }
      default:
        throw new Error(`未知浏览器工具：${name}`)
    }
  }

  async close(): Promise<void> {
    const ctx = this.context
    const b = this.browser
    const owned = this.ownedBrowser
    const mode = this.mode
    this.reset()
    this.lastState.clear()
    if (mode === 'persistent') {
      await ctx?.close().catch(() => {})
    } else if (owned && b) {
      await b.close().catch(() => {})
    } else if (!owned && b) {
      // CDP：断开连接；不强制关闭用户已打开的 Chrome
      await b.close().catch(() => {})
    }
  }
}
