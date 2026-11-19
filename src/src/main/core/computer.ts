import type { ToolDef } from './llm'
import type { ToolResult } from './browser'
import { describeScreen, findElements, groupElements, type OcrWord, type ScreenElement, type UiBox } from './ocr'
import { a11yToShot, describeSom, elementAt, matchElement, mergeElements, roleLabel, type A11ySnapshot, type SomElement } from './som'

/** 电脑控制（computer use）工具定义 */
export const COMPUTER_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'computer_screenshot',
      description:
        '截取整个屏幕。返回的截图已缩放（宽度约 1280px），之后所有鼠标坐标都以这张截图的像素坐标为准。截图上会用编号框标出可交互元素（Set-of-Mark），并附带元素列表，优先用 click_element(编号) 操作。每次操作后也会自动附带新的截图。如果你不能看图，会改为返回元素列表和 OCR 文字（纯文本模式），可据此按编号或坐标操作。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mouse_move',
      description: '把鼠标移动到截图坐标 (x, y)。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mouse_click',
      description: '在截图坐标 (x, y) 处单击。button 可选 left（默认）/ right / middle。',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] } },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mouse_double_click',
      description: '在截图坐标 (x, y) 处双击左键。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mouse_right_click',
      description: '在截图坐标 (x, y) 处单击右键。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mouse_drag',
      description: '从 (x, y) 按住左键拖动到 (to_x, to_y)。',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
        required: ['x', 'y', 'to_x', 'to_y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: '在 (x, y)（可选）处滚动。direction: up/down/left/right，amount 为滚动格数（默认 5）。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: '在当前焦点处输入文字（支持中文）。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'key_press',
      description: '按下按键或组合键，例如 "enter"、"ctrl+c"、"ctrl+shift+t"、"alt+tab"、"cmd+space"。',
      parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: '启动一个应用程序。name 为应用名或可执行文件路径，args 为可选参数数组。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '用系统默认浏览器打开网址。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: { name: 'list_windows', description: '列出当前打开的窗口标题。', parameters: { type: 'object', properties: {} } }
  },
  {
    type: 'function',
    function: {
      name: 'focus_window',
      description: '把标题包含 title 的窗口切换到前台。',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
    }
  }
]

COMPUTER_TOOL_DEFS.push({
  type: 'function',
  function: {
    name: 'find_text_on_screen',
    description: '在屏幕上查找包含指定文字的元素（按钮、链接、输入框提示文字等），返回其中心坐标，便于随后点击。适用于不能看图的纯文本模式。',
    parameters: { type: 'object', properties: { text: { type: 'string', description: '要查找的文字' } }, required: ['text'] }
  }
})

COMPUTER_TOOL_DEFS.push(
  {
    type: 'function',
    function: {
      name: 'get_ui_elements',
      description:
        '获取当前屏幕上可交互元素的编号列表（来自 Windows UI Automation / Linux AT-SPI 无障碍树，并与 OCR 文字、矩形控件检测合并），同时返回标注了编号的截图。scope=foreground（默认，只看前台窗口）或 desktop（整个桌面，较慢）。',
      parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['foreground', 'desktop'] } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: '点击最近一次截图/元素列表中编号为 id 的元素（点击其中心）。比按坐标点击更准确。button 可选 left/right，double=true 为双击。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: '元素编号' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_into_element',
      description: '在编号为 id 的输入框中输入文字：先点击聚焦，默认清空原有内容（clear=false 则追加），submit=true 时输入后按回车。Windows 上对支持 ValuePattern 的输入框会直接设置值（中文也可靠）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' }, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } },
        required: ['id', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click_target',
      description:
        '用自然语言描述要点击的目标（如「右上角的设置齿轮图标」「提交按钮」），由专门的 grounding 模型（如 UI-TARS）在截图上定位后点击；未配置 grounding 模型时按元素列表的名称匹配。适合元素列表里找不到、或没有编号的图标。',
      parameters: {
        type: 'object',
        properties: { description: { type: 'string', description: '目标元素的描述，越具体越好' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } },
        required: ['description']
      }
    }
  }
)

export const COMPUTER_TOOLS = new Set(COMPUTER_TOOL_DEFS.map((d) => d.function.name))
export const isComputerTool = (name: string): boolean => COMPUTER_TOOLS.has(name)

export interface Capture {
  /** 已缩放的截图（JPEG） */
  jpeg: Buffer
  /** 缩略图（JPEG，约 320px 宽），用于操作日志 */
  thumb: Buffer
  width: number
  height: number
  /** 与截图同尺寸的 PNG（用于 OCR） */
  png?: Buffer
}

export interface InputDriver {
  /** 输入驱动使用的屏幕坐标空间尺寸 */
  size(): Promise<{ width: number; height: number }>
  move(x: number, y: number): Promise<void>
  click(button: 'left' | 'right' | 'middle', double?: boolean): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>
  type(text: string): Promise<void>
  keys(combo: string[]): Promise<void>
  windows(): Promise<string[]>
  focus(title: string): Promise<boolean>
}

export type { ComputerLogEntry } from '../../shared/types'

export interface ComputerDeps {
  capture(): Promise<Capture>
  driver(): Promise<InputDriver>
  openApp(name: string, args: string[]): Promise<string>
  openUrl(url: string): Promise<void>
  /** 操作之后等待界面刷新的时间 */
  settleMs?: number
  /** OCR：识别截图中的文字（纯文本模式使用） */
  ocr?(png: Buffer): Promise<{ words: OcrWord[]; boxes?: UiBox[]; engine: string }>
  /** 当前是否使用纯文本模式（模型不能看图时） */
  textMode?(): boolean
  /** v0.7：无障碍树元素（Windows UIA / Linux AT-SPI），坐标为输入驱动的屏幕坐标 */
  elements?(scope: 'foreground' | 'desktop'): Promise<A11ySnapshot | null>
  /** v0.7：只做矩形控件检测（不做 OCR，视觉模式下用于补充编号） */
  boxes?(png: Buffer): Promise<UiBox[]>
  /** v0.7：在截图上绘制编号框，返回 JPEG */
  annotate?(c: Capture, els: SomElement[]): Promise<Buffer>
  /** v0.7：Windows UIA ValuePattern 直接设置输入框的值（屏幕坐标），不支持返回 false */
  setValue?(x: number, y: number, text: string): Promise<boolean>
  /** v0.7：是否启用 Set-of-Mark 编号（默认启用） */
  somEnabled?(): boolean
  /** v0.7：grounding 模型定位；返回截图坐标，未配置返回 null */
  ground?(c: Capture, description: string): Promise<{ x: number; y: number; detail: string } | null>
  /** 目标名称（用于结果说明，如「Windows 虚拟电脑（VNC）」） */
  targetLabel?: string
  /** 目标系统（决定全选等快捷键用 Ctrl 还是 ⌘）；缺省为宿主系统 */
  guestOs?: 'windows' | 'macos' | 'linux'
}

export function parseKeyCombo(keys: string): string[] {
  return keys
    .split(/\s*\+\s*/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
}

const toDataUrl = (b: Buffer): string => `data:image/jpeg;base64,${b.toString('base64')}`

/** 电脑控制器：坐标缩放（截图坐标 → 屏幕坐标）、执行动作、动作后自动截图 */
export class ComputerController {
  private shot: { width: number; height: number } | null = null
  private screen: { width: number; height: number } | null = null

  constructor(private deps: ComputerDeps) {}

  setDeps(deps: ComputerDeps): void {
    this.deps = deps
    this.shot = null
    this.screen = null
    this.som = []
    this.somAt = 0
  }

  private async ensureScale(): Promise<{ sx: number; sy: number }> {
    const drv = await this.deps.driver()
    this.screen = await drv.size()
    if (!this.shot) {
      const c = await this.deps.capture()
      this.shot = { width: c.width, height: c.height }
    }
    return { sx: this.screen.width / this.shot.width, sy: this.screen.height / this.shot.height }
  }

  /** 把截图坐标转换为输入驱动坐标 */
  async toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('坐标无效')
    const { sx, sy } = await this.ensureScale()
    const sw = this.screen!.width
    const sh = this.screen!.height
    return { x: Math.max(0, Math.min(sw - 1, Math.round(x * sx))), y: Math.max(0, Math.min(sh - 1, Math.round(y * sy))) }
  }

  private lastElements: ScreenElement[] = []
  /** v0.7：最近一次截图的编号元素 */
  som: SomElement[] = []
  somAt = 0
  somEngine = ''
  lastCapture: Capture | null = null

  isTextMode(): boolean {
    return !!this.deps.textMode?.() && !!this.deps.ocr
  }

  somEnabled(): boolean {
    return this.deps.somEnabled ? this.deps.somEnabled() : true
  }

  /** 采集无障碍元素 + 矩形控件（+ OCR）并编号 */
  private async collect(c: Capture, opts: { scope?: 'foreground' | 'desktop'; words?: OcrWord[]; boxes?: UiBox[] } = {}): Promise<{ els: SomElement[]; engine: string; foreground?: string; a11yError?: string }> {
    let a11y: ReturnType<typeof a11yToShot> = []
    const engines: string[] = []
    let foreground: string | undefined
    let a11yError: string | undefined
    if (this.deps.elements) {
      try {
        const snap = await this.deps.elements(opts.scope || 'foreground')
        if (snap) {
          if (snap.error) a11yError = snap.error
          if (snap.elements.length && snap.screen.width) {
            a11y = a11yToShot(snap, { width: c.width, height: c.height })
            engines.push(`${snap.engine}${snap.ms ? ` ${snap.ms}ms` : ''}`)
          }
          foreground = snap.foreground
        }
      } catch (e: any) {
        a11yError = e?.message || String(e)
      }
    }
    let boxes = opts.boxes
    if (!boxes && this.deps.boxes && c.png) {
      try {
        boxes = await this.deps.boxes(c.png)
      } catch {
        boxes = []
      }
    }
    if (boxes?.length) engines.push('矩形检测')
    const ocrEls = opts.words ? groupElements(opts.words) : []
    if (ocrEls.length) engines.push('OCR')
    const els = mergeElements({ a11y, ocr: ocrEls, boxes })
    return { els, engine: engines.join(' + ') || '无', foreground, a11yError }
  }

  async screenshot(opts: { scope?: 'foreground' | 'desktop'; full?: boolean } = {}): Promise<ToolResult & { thumb: string }> {
    const c = await this.deps.capture()
    this.shot = { width: c.width, height: c.height }
    this.lastCapture = c
    const som = this.somEnabled()
    if (this.isTextMode() && c.png) {
      let windows: string[] = []
      try {
        windows = await (await this.deps.driver()).windows()
      } catch {
        /* ignore */
      }
      const { words, boxes, engine } = await this.deps.ocr!(c.png)
      this.lastElements = groupElements(words)
      // 控件标签也参与 find_text_on_screen 查找
      for (const b of boxes || []) if (b.text) this.lastElements.push({ text: b.text, cx: b.cx, cy: b.cy, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })
      if (!som) {
        this.som = []
        return {
          text: describeScreen({ width: c.width, height: c.height, elements: groupElements(words), boxes, windows, engine }),
          // 图片只用于界面展示；纯文本模式下不会发送给模型
          images: [toDataUrl(c.jpeg)],
          thumb: toDataUrl(c.thumb)
        }
      }
      const r = await this.collect(c, { scope: opts.scope, words, boxes })
      this.setSom(r.els, `${r.engine}（OCR 引擎 ${engine}）`)
      for (const e of r.els) if (e.source !== 'ocr' && e.name) this.lastElements.push({ text: e.name, cx: e.cx, cy: e.cy, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 })
      const annotated = await this.annotated(c, r.els)
      return {
        text:
          `【纯文本屏幕描述】当前模型不能看图，以下是屏幕上的可交互元素和文字（编号框已画在界面截图上供用户查看）。${this.deps.targetLabel ? `控制目标：${this.deps.targetLabel}。` : ''}\n` +
          (windows.length ? `窗口：${windows.slice(0, 15).join(' | ')}\n` : '') +
          (r.a11yError ? `（无障碍接口不可用：${r.a11yError}，已改用 OCR 与矩形检测）\n` : '') +
          describeSom(r.els, { width: c.width, height: c.height, engine: r.engine, foreground: r.foreground, max: opts.full ? 300 : 150 }),
        images: [annotated],
        thumb: toDataUrl(c.thumb)
      }
    }
    if (!som) {
      this.som = []
      return { text: `屏幕截图 ${c.width}x${c.height}（坐标以此截图为准）`, images: [toDataUrl(c.jpeg)], thumb: toDataUrl(c.thumb) }
    }
    const r = await this.collect(c, { scope: opts.scope })
    this.setSom(r.els, r.engine)
    this.lastElements = r.els.filter((e) => e.name).map((e) => ({ text: e.name, cx: e.cx, cy: e.cy, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }))
    const annotated = await this.annotated(c, r.els)
    return {
      text:
        `屏幕截图 ${c.width}x${c.height}（坐标以此截图为准）${this.deps.targetLabel ? `，控制目标：${this.deps.targetLabel}` : ''}。` +
        (r.els.length ? `截图上已用彩色编号框标出 ${r.els.length} 个可交互元素（来源：${r.engine}${r.foreground ? `，前台窗口「${r.foreground}」` : ''}），可直接 click_element(编号)。\n` : '\n') +
        (r.a11yError ? `（无障碍接口不可用：${r.a11yError}）\n` : '') +
        describeSom(r.els, { width: c.width, height: c.height, engine: r.engine, foreground: r.foreground, max: opts.full ? 300 : 80, header: false }),
      images: [annotated],
      thumb: toDataUrl(c.thumb)
    }
  }

  private setSom(els: SomElement[], engine: string): void {
    this.som = els
    this.somAt = Date.now()
    this.somEngine = engine
  }

  private async annotated(c: Capture, els: SomElement[]): Promise<string> {
    if (!els.length || !this.deps.annotate) return toDataUrl(c.jpeg)
    try {
      return toDataUrl(await this.deps.annotate(c, els))
    } catch {
      return toDataUrl(c.jpeg)
    }
  }

  private async element(id: number): Promise<SomElement> {
    if (!this.som.length || Date.now() - this.somAt > 10 * 60 * 1000) await this.screenshot()
    const e = this.som.find((x) => x.id === Math.round(Number(id)))
    if (!e) throw new Error(`没有编号为 ${id} 的元素（当前共 ${this.som.length} 个，编号在每次截图后会重新生成，请先查看最新截图/列表）`)
    return e
  }

  private async clickAt(x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): Promise<void> {
    const drv = await this.deps.driver()
    const p = await this.toScreen(x, y)
    await drv.move(p.x, p.y)
    await drv.click(button, double)
  }

  private async after(desc: string): Promise<ToolResult & { thumb?: string }> {
    await new Promise((r) => setTimeout(r, this.deps.settleMs ?? 600))
    const s = await this.screenshot()
    return { text: `${desc}。\n${s.text}`, images: s.images, thumb: s.thumb }
  }

  async execute(name: string, args: Record<string, any>): Promise<ToolResult & { thumb?: string }> {
    if (name === 'computer_screenshot') return this.screenshot()
    if (name === 'find_text_on_screen') {
      const s = await this.screenshot()
      if (!this.isTextMode()) return s
      const hits = findElements(this.lastElements, String(args.text || ''))
      return {
        text: hits.length
          ? `找到 ${hits.length} 处「${args.text}」：\n` + hits.map((e, i) => `${i + 1}. 「${e.text}」 中心(${e.cx},${e.cy}) 范围[${e.x1},${e.y1}–${e.x2},${e.y2}]`).join('\n')
          : `屏幕上没有找到「${args.text}」。\n${s.text}`,
        images: s.images,
        thumb: s.thumb
      }
    }
    if (name === 'get_ui_elements') {
      const scope = args.scope === 'desktop' ? 'desktop' : 'foreground'
      if (!this.somEnabled()) return this.screenshot()
      return this.screenshot({ scope, full: true })
    }
    if (name === 'click_element') {
      const e = await this.element(args.id)
      const button = args.button === 'right' ? 'right' : 'left'
      await this.clickAt(e.cx, e.cy, button, !!args.double)
      return this.after(`${args.double ? '双击' : button === 'right' ? '右键单击' : '单击'}了 [${e.id}] ${roleLabel(e.role)}${e.name ? `「${e.name.slice(0, 40)}」` : ''}（中心 ${e.cx},${e.cy}）`)
    }
    if (name === 'type_into_element') {
      const e = await this.element(args.id)
      const text = String(args.text ?? '')
      const clear = args.clear !== false
      let how = ''
      let done = false
      if (this.deps.setValue && clear && e.source === 'uia' && e.patterns?.includes('value')) {
        const p = await this.toScreen(e.cx, e.cy)
        try {
          done = await this.deps.setValue(p.x, p.y, text)
          if (done) how = '（UIA ValuePattern 直接设置）'
        } catch {
          done = false
        }
      }
      const drv = await this.deps.driver()
      if (!done) {
        await this.clickAt(e.cx, e.cy, 'left', false)
        await new Promise((r) => setTimeout(r, 120))
        if (clear) {
          await drv.keys([(this.deps.guestOs ?? (process.platform === 'darwin' ? 'macos' : 'other')) === 'macos' ? 'cmd' : 'ctrl', 'a'])
          await drv.keys(['backspace'])
        }
        await drv.type(text)
      }
      if (args.submit) await drv.keys(['enter'])
      return this.after(`在 [${e.id}] ${roleLabel(e.role)}${e.name ? `「${e.name.slice(0, 30)}」` : ''} 中输入了 ${Array.from(text).length} 个字符${how}${args.submit ? '并按下回车' : ''}`)
    }
    if (name === 'click_target') {
      const description = String(args.description || '').trim()
      if (!description) throw new Error('缺少目标描述 description')
      const button = args.button === 'right' ? 'right' : 'left'
      const c = await this.deps.capture()
      this.shot = { width: c.width, height: c.height }
      let grounded: { x: number; y: number; detail: string } | null = null
      let groundErr = ''
      if (this.deps.ground) {
        try {
          grounded = await this.deps.ground(c, description)
        } catch (e: any) {
          groundErr = e?.message || String(e)
        }
      }
      if (grounded) {
        // 用最新元素列表说明点中了什么
        if (!this.som.length || Date.now() - this.somAt > 5000) {
          try {
            const r = await this.collect(c)
            this.setSom(r.els, r.engine)
          } catch {
            /* ignore */
          }
        }
        const hit = elementAt(this.som, grounded.x, grounded.y)
        await this.clickAt(grounded.x, grounded.y, button, !!args.double)
        return this.after(`grounding 模型定位「${description}」→ (${grounded.x}, ${grounded.y})${hit ? `，落在 [${hit.id}] ${roleLabel(hit.role)}${hit.name ? `「${hit.name.slice(0, 30)}」` : ''}` : ''}，已${args.double ? '双击' : '点击'}（${grounded.detail}）`)
      }
      // 兜底：按元素列表匹配
      if (!this.som.length || Date.now() - this.somAt > 5000) {
        const r = await this.collect(c)
        this.setSom(r.els, r.engine)
      }
      const hits = matchElement(this.som, description)
      if (!hits.length)
        throw new Error(
          `${groundErr ? `grounding 模型不可用（${groundErr}）；` : '未配置 grounding 模型；'}元素列表中也没有找到与「${description}」匹配的元素。请查看截图后用 click_element(编号) 或坐标点击。`
        )
      const e = hits[0].element
      await this.clickAt(e.cx, e.cy, button, !!args.double)
      return this.after(
        `${groundErr ? `grounding 模型不可用（${groundErr.slice(0, 80)}），` : ''}按元素列表匹配「${description}」→ [${e.id}] ${roleLabel(e.role)}「${e.name.slice(0, 40)}」（匹配度 ${hits[0].score}），已${args.double ? '双击' : '点击'}中心 (${e.cx}, ${e.cy})`
      )
    }
    const drv = await this.deps.driver()
    let desc = ''
    switch (name) {
      case 'mouse_move': {
        const p = await this.toScreen(Number(args.x), Number(args.y))
        await drv.move(p.x, p.y)
        desc = `鼠标移动到 (${args.x}, ${args.y})`
        break
      }
      case 'mouse_click':
      case 'mouse_double_click':
      case 'mouse_right_click': {
        const p = await this.toScreen(Number(args.x), Number(args.y))
        await drv.move(p.x, p.y)
        const button = name === 'mouse_right_click' ? 'right' : (args.button as 'left' | 'right' | 'middle') || 'left'
        await drv.click(button, name === 'mouse_double_click')
        desc = `${name === 'mouse_double_click' ? '双击' : button === 'right' ? '右键单击' : '单击'} (${args.x}, ${args.y})`
        break
      }
      case 'mouse_drag': {
        const a = await this.toScreen(Number(args.x), Number(args.y))
        const b = await this.toScreen(Number(args.to_x), Number(args.to_y))
        await drv.drag(a.x, a.y, b.x, b.y)
        desc = `从 (${args.x}, ${args.y}) 拖动到 (${args.to_x}, ${args.to_y})`
        break
      }
      case 'scroll': {
        if (args.x !== undefined && args.y !== undefined) {
          const p = await this.toScreen(Number(args.x), Number(args.y))
          await drv.move(p.x, p.y)
        }
        const dir = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down'
        const amount = Math.max(1, Math.min(50, Number(args.amount) || 5))
        await drv.scroll(dir, amount)
        desc = `向${{ up: '上', down: '下', left: '左', right: '右' }[dir as string]}滚动 ${amount}`
        break
      }
      case 'type_text': {
        const text = String(args.text ?? '')
        await drv.type(text)
        desc = `输入了 ${Array.from(text).length} 个字符`
        break
      }
      case 'key_press': {
        const combo = parseKeyCombo(String(args.keys || ''))
        if (!combo.length) throw new Error('缺少按键')
        await drv.keys(combo)
        desc = `按下 ${combo.join('+')}`
        break
      }
      case 'open_app': {
        const name2 = String(args.name || '').trim()
        if (!name2) throw new Error('缺少应用名')
        desc = await this.deps.openApp(name2, Array.isArray(args.args) ? args.args.map(String) : [])
        break
      }
      case 'open_url': {
        const url = String(args.url || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http(s) 地址')
        await this.deps.openUrl(url)
        desc = `已打开 ${url}`
        break
      }
      case 'list_windows': {
        const list = await drv.windows()
        return { text: list.length ? list.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(没有获取到窗口)' }
      }
      case 'focus_window': {
        const ok = await drv.focus(String(args.title || ''))
        if (!ok) throw new Error(`没有找到标题包含「${args.title}」的窗口`)
        desc = `已切换到窗口「${args.title}」`
        break
      }
      default:
        throw new Error(`未知电脑控制工具：${name}`)
    }
    return this.after(desc)
  }
}
