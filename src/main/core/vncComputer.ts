/**
 * v0.7 用 VNC（RFB）把本地虚拟电脑接入电脑控制工具：截图 = 帧缓冲，鼠标/键盘 = Pointer/KeyEvent。
 * 适用于 dockur Windows / macOS（QEMU 内置 VNC，经 Web 查看器端口 /websockify 访问）和 Linux 虚拟电脑（x11vnc）。
 * 不需要在虚拟机里安装任何程序；不会回落到宿主机。
 */
import type { Capture, ComputerDeps, InputDriver } from './computer'
import { BUTTON_MASK, comboToKeyEvents, RfbClient, textToKeyEvents, type RfbTransport } from './rfb'

export interface VncTargetOptions {
  /** 目标说明（用于错误提示），如「Windows 桌面虚拟电脑」 */
  label: string
  /** 虚拟机系统：决定 open_app / open_url 的实现方式 */
  guestOs: 'windows' | 'macos' | 'linux'
  connect: () => Promise<RfbTransport>
  password?: string
  /** 把 BGRA 帧编码成 Capture（主进程用 nativeImage 实现） */
  encode: (bgra: Buffer, width: number, height: number) => Capture
  /** 可选：自定义打开应用/网址（如 Linux 虚拟电脑仍用 docker exec 启动程序） */
  openApp?: ComputerDeps['openApp']
  openUrl?: ComputerDeps['openUrl']
  /** 按键间隔（毫秒） */
  keyDelayMs?: number
  /** 连接前检查（如容器是否运行），返回错误信息或 null */
  precheck?: () => Promise<string | null>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class VncSession {
  private client: RfbClient | null = null
  private connecting: Promise<RfbClient> | null = null
  private pos = { x: 0, y: 0 }
  lastError: string | null = null
  connectedAt = 0

  constructor(readonly opts: VncTargetOptions) {}

  get connected(): boolean {
    return !!this.client && !this.client.closed
  }

  info(): { connected: boolean; width: number; height: number; name: string; version: string; error: string | null } {
    return { connected: this.connected, width: this.client?.width || 0, height: this.client?.height || 0, name: this.client?.name || '', version: this.client?.version || '', error: this.lastError }
  }

  async ensure(): Promise<RfbClient> {
    if (this.client && !this.client.closed) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      try {
        const pre = await this.opts.precheck?.()
        if (pre) throw new Error(pre)
        const t = await this.opts.connect()
        const c = await RfbClient.connect(t, { password: this.opts.password })
        c.on('close', () => {
          if (this.client === c) this.client = null
        })
        this.client = c
        this.connectedAt = Date.now()
        this.lastError = null
        return c
      } catch (e: any) {
        this.lastError = e?.message || String(e)
        throw new Error(`${this.opts.label}：VNC 连接失败——${this.lastError}`)
      } finally {
        this.connecting = null
      }
    })()
    return this.connecting
  }

  close(): void {
    this.client?.close()
    this.client = null
  }

  async capture(): Promise<Capture> {
    const c = await this.ensure()
    const s = await c.snapshot()
    if (!s.width || !s.height) throw new Error(`${this.opts.label}：虚拟机画面尚未就绪`)
    return this.opts.encode(s.bgra, s.width, s.height)
  }

  private async keyEvents(ev: [number, boolean][]): Promise<void> {
    const c = await this.ensure()
    const d = this.opts.keyDelayMs ?? 6
    for (const [ks, down] of ev) {
      c.key(ks, down)
      if (d) await sleep(d)
    }
  }

  driver(): InputDriver {
    return {
      size: async () => {
        const c = await this.ensure()
        return { width: c.width, height: c.height }
      },
      move: async (x, y) => {
        const c = await this.ensure()
        this.pos = { x, y }
        c.pointer(x, y, 0)
        await sleep(30)
      },
      click: async (button, double) => {
        const c = await this.ensure()
        const m = button === 'right' ? BUTTON_MASK.right : button === 'middle' ? BUTTON_MASK.middle : BUTTON_MASK.left
        for (let i = 0; i < (double ? 2 : 1); i++) {
          c.pointer(this.pos.x, this.pos.y, m)
          await sleep(50)
          c.pointer(this.pos.x, this.pos.y, 0)
          await sleep(double ? 90 : 30)
        }
      },
      drag: async (x1, y1, x2, y2) => {
        const c = await this.ensure()
        c.pointer(x1, y1, 0)
        await sleep(40)
        c.pointer(x1, y1, BUTTON_MASK.left)
        await sleep(60)
        const steps = 12
        for (let i = 1; i <= steps; i++) {
          c.pointer(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, BUTTON_MASK.left)
          await sleep(20)
        }
        c.pointer(x2, y2, 0)
        this.pos = { x: x2, y: y2 }
        await sleep(30)
      },
      scroll: async (dir, amount) => {
        const c = await this.ensure()
        const m = dir === 'up' ? BUTTON_MASK.wheelUp : dir === 'down' ? BUTTON_MASK.wheelDown : dir === 'left' ? BUTTON_MASK.wheelLeft : BUTTON_MASK.wheelRight
        for (let i = 0; i < amount; i++) {
          c.pointer(this.pos.x, this.pos.y, m)
          c.pointer(this.pos.x, this.pos.y, 0)
          await sleep(25)
        }
      },
      type: async (text) => {
        if (this.opts.guestOs !== 'linux' && /[^\x20-\x7e\n\t]/.test(text))
          throw new Error(
            `${this.opts.label}：通过 VNC 只能输入英文字母、数字和符号（QEMU 只转发键盘扫描码，无法直接输入中文等字符）。请改用英文内容，或先在虚拟机里切换到中文输入法后用拼音按键输入。`
          )
        await this.keyEvents(textToKeyEvents(text))
      },
      keys: async (combo) => {
        await this.keyEvents(comboToKeyEvents(combo))
      },
      windows: async () => [],
      focus: async () => {
        throw new Error(`${this.opts.label}：VNC 控制方式无法按标题切换窗口，请用 key_press("alt+tab") 或点击任务栏。`)
      }
    }
  }

  deps(extra?: Partial<ComputerDeps>): ComputerDeps {
    const o = this.opts
    const runDialog = async (text: string): Promise<void> => {
      const drv = this.driver()
      if (o.guestOs === 'windows') {
        await drv.keys(['win', 'r'])
        await sleep(900)
        await drv.keys(['ctrl', 'a'])
        await drv.type(text)
        await sleep(150)
        await drv.keys(['enter'])
      } else if (o.guestOs === 'macos') {
        await drv.keys(['cmd', 'space'])
        await sleep(700)
        await drv.type(text)
        await sleep(400)
        await drv.keys(['enter'])
      } else {
        throw new Error(`${o.label}：该系统不支持通过运行框启动程序`)
      }
    }
    return {
      capture: () => this.capture(),
      driver: async () => {
        await this.ensure()
        return this.driver()
      },
      openApp:
        o.openApp ||
        (async (name, args) => {
          const cmd = [name, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
          await runDialog(cmd)
          return `已在${o.label}中通过${o.guestOs === 'windows' ? '「运行」对话框（Win+R）' : '聚焦搜索（⌘+空格）'}启动 ${name}`
        }),
      openUrl:
        o.openUrl ||
        (async (url) => {
          if (o.guestOs === 'macos') await runDialog(url)
          else await runDialog(url)
        }),
      settleMs: 900,
      guestOs: o.guestOs,
      targetLabel: o.label,
      ...extra
    }
  }
}
