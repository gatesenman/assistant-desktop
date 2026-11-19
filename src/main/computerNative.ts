import { clipboard, desktopCapturer, nativeImage, screen as eScreen, shell } from 'electron'
import { spawn } from 'child_process'
import type { Capture, ComputerDeps, InputDriver } from './core/computer'
import { runOcr } from './ocrNative'
import { annotateCapture, detectBoxes } from './somNative'
import { uiaSetValue, uiaSnapshot } from './uiaNative'
import { atspiSnapshot } from './core/atspi'
import type { A11ySnapshot } from './core/som'

const MAX_W = 1280

/** 屏幕截图：Electron desktopCapturer（主显示器），缩放到 ~1280px 宽 */
export async function captureScreen(): Promise<Capture> {
  const d = eScreen.getPrimaryDisplay()
  const full = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full })
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0]
  if (!src || src.thumbnail.isEmpty()) throw new Error('无法截取屏幕（macOS 需在「系统设置 → 隐私与安全性 → 屏幕录制」中授权）')
  let img = src.thumbnail
  const size = img.getSize()
  if (size.width > MAX_W) img = img.resize({ width: MAX_W, quality: 'good' })
  const s2 = img.getSize()
  const thumb = img.resize({ width: 320, quality: 'good' })
  return { jpeg: img.toJPEG(72), thumb: thumb.toJPEG(60), width: s2.width, height: s2.height, png: img.toPNG() }
}

type Nut = typeof import('@nut-tree-fork/nut-js')
let nutPromise: Promise<Nut> | null = null
function loadNut(): Promise<Nut> {
  nutPromise ??= import('@nut-tree-fork/nut-js').then((m: any) => {
    const nut: Nut = m.default && !m.mouse ? m.default : m
    nut.mouse.config.autoDelayMs = 30
    nut.mouse.config.mouseSpeed = 4000
    nut.keyboard.config.autoDelayMs = 8
    return nut
  })
  return nutPromise.catch((e) => {
    nutPromise = null
    throw new Error('电脑控制组件加载失败：' + (e?.message || e))
  })
}

const KEY_ALIASES: Record<string, string> = {
  ctrl: 'LeftControl',
  control: 'LeftControl',
  alt: 'LeftAlt',
  option: 'LeftAlt',
  shift: 'LeftShift',
  cmd: process.platform === 'darwin' ? 'LeftCmd' : 'LeftSuper',
  command: process.platform === 'darwin' ? 'LeftCmd' : 'LeftSuper',
  meta: process.platform === 'darwin' ? 'LeftCmd' : 'LeftSuper',
  win: 'LeftSuper',
  super: 'LeftSuper',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  capslock: 'CapsLock',
  printscreen: 'Print',
  minus: 'Minus',
  equal: 'Equal',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash'
}

function keyOf(nut: Nut, name: string): any {
  const K = nut.Key as any
  const alias = KEY_ALIASES[name]
  if (alias && K[alias] !== undefined) return K[alias]
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) return K[name.toUpperCase()]
  if (/^[a-z]$/.test(name)) return K[name.toUpperCase()]
  if (/^[0-9]$/.test(name)) return K[`Num${name}`]
  const direct = Object.keys(K).find((k) => k.toLowerCase() === name)
  if (direct) return K[direct]
  throw new Error(`不支持的按键：${name}`)
}

export async function nutDriver(): Promise<InputDriver> {
  const nut = await loadNut()
  const btn = (b: string): any => (b === 'right' ? nut.Button.RIGHT : b === 'middle' ? nut.Button.MIDDLE : nut.Button.LEFT)
  return {
    size: async () => ({ width: await nut.screen.width(), height: await nut.screen.height() }),
    move: async (x, y) => {
      await nut.mouse.setPosition(new nut.Point(x, y))
    },
    click: async (b, double) => {
      if (double) await nut.mouse.doubleClick(btn(b))
      else await nut.mouse.click(btn(b))
    },
    drag: async (x1, y1, x2, y2) => {
      await nut.mouse.setPosition(new nut.Point(x1, y1))
      await nut.mouse.pressButton(nut.Button.LEFT)
      await nut.mouse.move(nut.straightTo(new nut.Point(x2, y2)))
      await nut.mouse.releaseButton(nut.Button.LEFT)
    },
    scroll: async (dir, amount) => {
      if (dir === 'up') await nut.mouse.scrollUp(amount)
      else if (dir === 'down') await nut.mouse.scrollDown(amount)
      else if (dir === 'left') await nut.mouse.scrollLeft(amount)
      else await nut.mouse.scrollRight(amount)
    },
    type: async (text) => {
      if (/^[\x20-\x7e\n\t]*$/.test(text)) {
        await nut.keyboard.type(text)
        return
      }
      // 非 ASCII（如中文）通过剪贴板粘贴，避免输入法问题
      const prev = clipboard.readText()
      clipboard.writeText(text)
      const mod = process.platform === 'darwin' ? nut.Key.LeftCmd : nut.Key.LeftControl
      await nut.keyboard.pressKey(mod, nut.Key.V)
      await nut.keyboard.releaseKey(mod, nut.Key.V)
      setTimeout(() => clipboard.writeText(prev), 800)
    },
    keys: async (combo) => {
      const ks = combo.map((k) => keyOf(nut, k))
      await nut.keyboard.pressKey(...ks)
      await nut.keyboard.releaseKey(...ks.reverse())
    },
    windows: async () => {
      const ws = await nut.getWindows()
      const titles: string[] = []
      for (const w of ws) {
        try {
          const t = await w.title
          if (t && t.trim()) titles.push(t)
        } catch {
          /* ignore */
        }
      }
      return titles
    },
    focus: async (title) => {
      const ws = await nut.getWindows()
      for (const w of ws) {
        try {
          const t = await w.title
          if (t && t.toLowerCase().includes(title.toLowerCase())) {
            await (w as any).focus()
            return true
          }
        } catch {
          /* ignore */
        }
      }
      return false
    }
  }
}

export function openApp(name: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let cmd: string
    let a: string[]
    if (process.platform === 'darwin' && !name.includes('/')) {
      cmd = 'open'
      a = ['-a', name, ...(args.length ? ['--args', ...args] : [])]
    } else if (process.platform === 'win32') {
      cmd = 'cmd.exe'
      a = ['/c', 'start', '""', name, ...args]
    } else {
      cmd = name
      a = args
    }
    const child = spawn(cmd, a, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', (e) => reject(new Error(`无法启动 ${name}：${e.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve(`已启动 ${name}`)
    })
  })
}

/** 本机 python3 运行 AT-SPI 脚本（脚本从 stdin 读入） */
function runPython(script: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_AT_BRIDGE: '0' } })
    let out = ''
    let err = ''
    const t = setTimeout(() => {
      p.kill('SIGKILL')
      reject(new Error(`超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.once('error', (e) => {
      clearTimeout(t)
      reject(new Error('无法运行 python3：' + e.message))
    })
    p.once('close', () => {
      clearTimeout(t)
      if (out.trim()) resolve(out)
      else reject(new Error(err.trim().split('\n').pop() || 'python3 没有输出'))
    })
    p.stdin.end(script)
  })
}

let atspiMissingAt = 0
/** 无障碍元素：Windows → UIA；Linux → AT-SPI（未安装则返回带说明的空结果，自动退回 OCR）；macOS 暂不支持 */
export async function nativeElements(scope: 'foreground' | 'desktop'): Promise<A11ySnapshot | null> {
  if (process.platform === 'win32') return uiaSnapshot(scope)
  if (process.platform === 'linux') {
    if (Date.now() - atspiMissingAt < 120000) return null
    const d = eScreen.getPrimaryDisplay()
    const screen = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    const snap = await atspiSnapshot(runPython, screen, scope)
    if (snap.error && /pyatspi|python3/.test(snap.error)) atspiMissingAt = Date.now()
    return snap
  }
  return null
}

/** Windows：UIA ValuePattern 直接写入输入框（坐标从 nut 坐标换算到 UIA 物理像素） */
async function nativeSetValue(x: number, y: number, text: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const snap = await uiaSnapshot('foreground')
  let px = x
  let py = y
  try {
    const nut = await loadNut()
    const w = await nut.screen.width()
    const h = await nut.screen.height()
    if (snap?.screen.width && w && h) {
      px = Math.round((x * snap.screen.width) / w)
      py = Math.round((y * snap.screen.height) / h)
    }
  } catch {
    /* ignore */
  }
  return uiaSetValue(px, py, text)
}

export const nativeComputerDeps: ComputerDeps = {
  capture: captureScreen,
  driver: nutDriver,
  openApp,
  openUrl: (url) => shell.openExternal(url),
  settleMs: 700,
  ocr: runOcr,
  elements: nativeElements,
  boxes: detectBoxes,
  annotate: annotateCapture,
  setValue: nativeSetValue
}
void nativeImage
