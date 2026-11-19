/**
 * v0.7 装配：Set-of-Mark / 无障碍树、grounding 模型、用量统计与预算、虚拟电脑 VNC 控制。
 * 集中在这里，index.ts 只需少量调用。
 */
import { app, ipcMain, nativeImage } from 'electron'
import { spawn } from 'child_process'
import type { AppEvent, GroundingSettings, PriceEntry, Settings } from '../shared/types'
import type { Store } from './core/store'
import type { Capture, ComputerController, ComputerDeps } from './core/computer'
import { groundingPreset, groundOnce, type GroundingConfig } from './core/grounding'
import { DEFAULT_PRICES, parseUsage, UsageLedger, type BudgetSettings } from './core/usage'
import { UsageTracker } from './core/usageTracker'
import { tcpTransport, wsTransport } from './core/rfb'
import { VncSession } from './core/vncComputer'
import { annotateCapture, detectBoxes, encodeBgra } from './somNative'
import { uiaStatus } from './uiaNative'
import { runOcr } from './ocrNative'
import { localVm } from './core/localVm'
import { vms } from './core/vms'
import { vmOsFromMachineId, vmProfile, type VmOs } from '../shared/vmProfiles'
import { fillRect, strokeRect } from './core/somDraw'

export interface V07Ctx {
  store: Store
  emit: (e: AppEvent) => void
  pushState: () => void
  fetchImpl: typeof fetch
  textMode: () => boolean
  getComputer: () => ComputerController
  /** 当前目标的 deps（v04.getComputerDeps） */
  baseDeps: () => ComputerDeps
}

const toDataUrl = (b: Buffer, mime = 'image/jpeg'): string => `data:${mime};base64,${b.toString('base64')}`

export function createV07(ctx: V07Ctx) {
  const { store } = ctx
  const ledger = new UsageLedger(app.getPath('userData'))
  const usage = new UsageTracker(ledger, store)
  let usageTimer: NodeJS.Timeout | null = null
  ledger.onChange = () => {
    if (usageTimer) return
    usageTimer = setTimeout(() => {
      usageTimer = null
      ctx.emit({ type: 'usage', today: ledger.today(), total: ledger.summary.total })
    }, 300)
  }

  /* ------------------------------ grounding ------------------------------ */
  function groundingConfig(over?: Partial<GroundingSettings> & { apiKey?: string }): GroundingConfig & { enabled: boolean } {
    const g: GroundingSettings = { ...store.settings.grounding, ...(over || {}) }
    const preset = groundingPreset(g.preset)
    if (g.preset === 'main') {
      // 用主模型做定位：要求主模型能看图，坐标为截图像素
      return {
        enabled: g.enabled,
        preset: 'main',
        baseUrl: store.settings.baseUrl,
        apiKey: store.settings.apiKey,
        model: store.settings.model,
        coordSpace: 'pixel',
        promptStyle: 'json'
      }
    }
    return {
      enabled: g.enabled,
      preset: g.preset,
      baseUrl: g.baseUrl || preset.baseUrl,
      apiKey: over?.apiKey !== undefined && over.apiKey !== '' ? over.apiKey : store.settings.groundingApiKey || '',
      model: g.model || preset.model,
      coordSpace: g.coordSpace || preset.coordSpace,
      promptStyle: g.promptStyle || preset.promptStyle,
      minPixels: preset.minPixels,
      maxPixels: preset.maxPixels
    }
  }

  function recordGroundingUsage(cfg: GroundingConfig, u: unknown): void {
    const n = parseUsage(u)
    if (n) usage.record(n, { model: cfg.model, baseUrl: cfg.baseUrl, kind: 'grounding' })
  }

  async function ground(c: Capture, description: string): Promise<{ x: number; y: number; detail: string } | null> {
    const cfg = groundingConfig()
    if (!cfg.enabled) return null
    const r = await groundOnce(cfg, toDataUrl(c.jpeg), { width: c.width, height: c.height }, description, { fetchImpl: ctx.fetchImpl, timeoutMs: 60000 })
    recordGroundingUsage(cfg, r.usage)
    return { x: r.x, y: r.y, detail: `${cfg.model}，${r.ms}ms` }
  }

  /** 合成测试图：浅色「窗口」+ 若干灰色按钮 + 一个红色「确定」按钮；返回 PNG 与红色按钮位置 */
  function groundingTestImage(): { png: Buffer; target: { x1: number; y1: number; x2: number; y2: number }; width: number; height: number } {
    const width = 1280
    const height = 800
    const data = Buffer.alloc(width * height * 4)
    const bm = { data, width, height }
    fillRect(bm, 0, 0, width, height, [236, 239, 244])
    fillRect(bm, 80, 60, 1200, 740, [255, 255, 255])
    strokeRect(bm, 80, 60, 1200, 740, [180, 186, 196], 2)
    fillRect(bm, 80, 60, 1200, 100, [64, 92, 160])
    const seed = Date.now()
    const cols = 5
    for (let i = 0; i < 10; i++) {
      const x = 140 + (i % cols) * 210
      const y = 180 + Math.floor(i / cols) * 120
      fillRect(bm, x, y, x + 150, y + 50, [210, 214, 222])
      strokeRect(bm, x, y, x + 150, y + 50, [150, 156, 168], 2)
    }
    const tx = 200 + (seed % 760)
    const ty = 470 + ((seed >> 4) % 180)
    const target = { x1: tx, y1: ty, x2: tx + 120, y2: ty + 56 }
    fillRect(bm, target.x1, target.y1, target.x2, target.y2, [220, 38, 38])
    strokeRect(bm, target.x1, target.y1, target.x2, target.y2, [127, 29, 29], 3)
    // 白色「勾」示意
    for (let k = 0; k < 18; k++) fillRect(bm, tx + 40 + k, ty + 26 + Math.floor(k / 2), tx + 44 + k, ty + 30 + Math.floor(k / 2), [255, 255, 255])
    for (let k = 0; k < 26; k++) fillRect(bm, tx + 58 + k, ty + 34 - k, tx + 62 + k, ty + 38 - k, [255, 255, 255])
    const img = nativeImage.createFromBitmap(data, { width, height })
    return { png: img.toPNG(), target, width, height }
  }

  async function testGrounding(over?: Partial<GroundingSettings> & { apiKey?: string }) {
    const cfg = groundingConfig({ ...(over || {}), enabled: true })
    if (!cfg.baseUrl || !cfg.model) return { ok: false, message: '请先填写 grounding 模型的 Base URL 和模型名称' }
    const t = groundingTestImage()
    const instruction = '红色的确认按钮（带白色对勾）'
    try {
      const r = await groundOnce(cfg, toDataUrl(t.png, 'image/png'), { width: t.width, height: t.height }, instruction, { fetchImpl: ctx.fetchImpl, timeoutMs: 90000 })
      recordGroundingUsage(cfg, r.usage)
      const m = 8
      const hit = r.x >= t.target.x1 - m && r.x <= t.target.x2 + m && r.y >= t.target.y1 - m && r.y <= t.target.y2 + m
      const expected = { x: Math.round((t.target.x1 + t.target.x2) / 2), y: Math.round((t.target.y1 + t.target.y2) / 2) }
      // 结果图：在测试图上画出模型给出的点
      const img = nativeImage.createFromBuffer(t.png)
      const data = Buffer.from(img.toBitmap())
      const bm = { data, width: t.width, height: t.height }
      const c: [number, number, number] = hit ? [22, 163, 74] : [234, 88, 12]
      fillRect(bm, r.x - 14, r.y - 2, r.x + 14, r.y + 2, c)
      fillRect(bm, r.x - 2, r.y - 14, r.x + 2, r.y + 14, c)
      strokeRect(bm, r.x - 10, r.y - 10, r.x + 10, r.y + 10, c, 2)
      const shot = nativeImage.createFromBitmap(data, { width: t.width, height: t.height }).resize({ width: 640 }).toJPEG(80)
      return {
        ok: hit,
        message: hit
          ? `定位成功：模型给出 (${r.x}, ${r.y})，目标中心 (${expected.x}, ${expected.y})，耗时 ${(r.ms / 1000).toFixed(1)} 秒。原始输出：${r.raw.slice(0, 120)}`
          : `模型有响应，但没有点中目标：给出 (${r.x}, ${r.y})，目标中心 (${expected.x}, ${expected.y})。请检查坐标格式设置（UI-TARS-1.5 用 smart_resize，UI-TARS v1 用 0–1000 相对坐标）。原始输出：${r.raw.slice(0, 120)}`,
        x: r.x,
        y: r.y,
        expected,
        raw: r.raw,
        ms: r.ms,
        image: toDataUrl(shot)
      }
    } catch (e: any) {
      return { ok: false, message: e?.message || String(e) }
    }
  }

  /* ------------------------------ VNC 会话 ------------------------------ */
  const sessions = new Map<VmOs, VncSession>()
  function vncSession(os: VmOs): VncSession {
    let s = sessions.get(os)
    if (s) return s
    const label = os === 'linux' ? 'Linux 桌面虚拟电脑（VNC）' : `${vmProfile(os).title}虚拟电脑（VNC）`
    s = new VncSession({
      label,
      guestOs: os,
      encode: (bgra, w, h) => encodeBgra(bgra, w, h),
      precheck: async () => {
        let st = vms.get(os).status()
        // 应用重启后状态是缓存的：容器可能仍在 docker 里运行，先刷新一次再判断
        if (os !== 'linux' && !st.containerRunning) st = await vms.get(os).refresh().catch(() => st)
        if (os === 'linux') return localVm.phase === 'ready' ? null : '虚拟电脑未运行，请先在「电脑」面板一键启动'
        // 显式的测试/高级覆盖：直接连接给定的 VNC WebSocket 地址（仍然是虚拟机，不会回落到本机）
        if (process.env.ASSISTANT_VNC_URL_OVERRIDE) return null
        if (!st.containerRunning) return `${vmProfile(os).title}虚拟电脑未运行（当前状态：${st.phase}），请先启动`
        return null
      },
      connect: async () => {
        if (os === 'linux') {
          const port = Number(process.env.ASSISTANT_VNC_PORT_OVERRIDE) || localVm.vncPort
          return tcpTransport('127.0.0.1', port)
        }
        // dockur（qemux/qemu）：nginx 在 Web 端口上把 /websockify 反代到 QEMU 内置 VNC 的 WebSocket
        const port = vms.get(os).status().webPort || vmProfile(os).webHostPortPreferred
        return wsTransport(process.env.ASSISTANT_VNC_URL_OVERRIDE || `ws://127.0.0.1:${port}/websockify`)
      },
      ...(os === 'linux' ? { openApp: (n: string, a: string[]) => localVm.openApp(n, a), openUrl: (u: string) => localVm.openUrl(u) } : {})
    })
    sessions.set(os, s)
    return s
  }
  const vncDeps = (os: VmOs): ComputerDeps => vncSession(os).deps()

  /* ------------------------------ deps 增强 ------------------------------ */
  function ensurePng(c: Capture): Capture {
    if (c.png) return c
    try {
      const img = nativeImage.createFromBuffer(c.jpeg)
      const s = img.getSize()
      if (!s.width) return c
      const thumb = c.thumb === c.jpeg ? img.resize({ width: 320, quality: 'good' }).toJPEG(60) : c.thumb
      return { ...c, png: img.toPNG(), thumb, width: c.width || s.width, height: c.height || s.height }
    } catch {
      return c
    }
  }

  function enhance(base: ComputerDeps): ComputerDeps {
    return {
      annotate: annotateCapture,
      boxes: detectBoxes,
      ...base,
      ocr: base.ocr || runOcr,
      capture: async () => ensurePng(await base.capture()),
      textMode: ctx.textMode,
      somEnabled: () => store.settings.somEnabled !== false,
      elements: base.elements ? (scope) => base.elements!(scope === 'desktop' ? 'desktop' : store.settings.somScope || 'foreground') : undefined,
      ground
    }
  }

  const computerDeps = (): ComputerDeps => enhance(ctx.baseDeps())

  /* ------------------------------ 状态 / 诊断 ------------------------------ */
  function pyatspiAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn('python3', ['-c', 'import pyatspi'], { stdio: 'ignore' })
      const t = setTimeout(() => {
        p.kill()
        resolve(false)
      }, 4000)
      p.once('error', () => {
        clearTimeout(t)
        resolve(false)
      })
      p.once('close', (code) => {
        clearTimeout(t)
        resolve(code === 0)
      })
    })
  }

  async function senseStatus(): Promise<{ engine: string; available: boolean; detail: string; lastMs?: number; lastCount?: number; lastError?: string }> {
    const mid = store.settings.activeMachineId || 'local'
    const vmOs = vmOsFromMachineId(mid)
    if (vmOs === 'windows' || vmOs === 'macos') {
      const s = sessions.get(vmOs)
      const i = s?.info()
      return {
        engine: 'vnc',
        available: true,
        detail: `${vmProfile(vmOs).title}虚拟电脑：通过 VNC 截图与键鼠；虚拟机内没有无障碍接口可读，编号来自矩形检测${ctx.textMode() ? ' + OCR' : ''}。${i?.connected ? `已连接 ${i.width}x${i.height}（${i.name || 'QEMU'}）` : i?.error ? '上次连接失败：' + i.error : '尚未连接（第一次截图时连接）'}`
      }
    }
    if (vmOs === 'linux') {
      if (localVm.phase !== 'ready') return { engine: 'atspi', available: false, detail: 'Linux 虚拟电脑未运行' }
      const snap = await localVm.elements('foreground').catch((e) => ({ error: String(e?.message || e), elements: [] as unknown[], ms: 0 }))
      return snap.error
        ? { engine: 'ocr', available: false, detail: `虚拟电脑内 AT-SPI 不可用（${snap.error}），使用 OCR + 矩形检测编号。重建虚拟电脑镜像可获得 AT-SPI。`, lastError: snap.error }
        : { engine: 'atspi', available: true, detail: `虚拟电脑内 AT-SPI 可用：前台窗口 ${snap.elements.length} 个元素，${snap.ms}ms`, lastCount: snap.elements.length, lastMs: snap.ms }
    }
    if (mid !== 'local') return { engine: 'remote', available: false, detail: '远程电脑伴侣：使用截图 + OCR' }
    if (process.platform === 'win32') {
      const s = uiaStatus()
      return { engine: 'uia', available: s.state !== 'error', detail: `Windows UI Automation（系统自带 PowerShell）：${s.state === 'ready' ? '已就绪' : s.state === 'error' ? '启动失败' : '首次截图时启动'}${s.lastMs !== undefined ? `，上次 ${s.lastCount} 个元素 / ${s.lastMs}ms` : ''}`, lastMs: s.lastMs, lastCount: s.lastCount, lastError: s.lastError }
    }
    if (process.platform === 'linux') {
      const ok = await pyatspiAvailable()
      return ok
        ? { engine: 'atspi', available: true, detail: 'Linux AT-SPI（python3-pyatspi）可用' }
        : { engine: 'ocr', available: false, detail: '未检测到 python3-pyatspi，使用 OCR + 矩形检测编号。安装：sudo apt install python3-pyatspi at-spi2-core' }
    }
    return { engine: 'ocr', available: false, detail: 'macOS 暂未接入辅助功能 API，使用 OCR + 矩形检测编号' }
  }

  async function diagnostics(): Promise<Record<string, unknown>> {
    const g = groundingConfig()
    let sense: unknown
    try {
      sense = await senseStatus()
    } catch (e: any) {
      sense = { error: e?.message || String(e) }
    }
    return {
      用量: ledger.diagnostics(),
      预算: store.settings.budget,
      价格表: (store.settings.prices || []).map((p) => `${p.label}: in ${p.price.input} / hit ${p.price.cacheHit ?? '-'} / out ${p.price.output} ${p.currency}${p.peak ? `（高峰 ${p.peak.input}/${p.peak.cacheHit ?? '-'}/${p.peak.output}）` : ''}`),
      编号标注: { 启用: store.settings.somEnabled, 范围: store.settings.somScope, 感知: sense, UIA: uiaStatus() },
      grounding: { 启用: g.enabled, 预设: g.preset, baseUrl: g.baseUrl, 模型: g.model, 坐标: g.coordSpace, 已设置密钥: !!store.settings.groundingApiKey },
      VNC: Object.fromEntries([...sessions.entries()].map(([k, s]) => [k, s.info()]))
    }
  }

  /* ------------------------------ IPC ------------------------------ */
  function registerIpc(): void {
    const view = () => usage.view()
    ipcMain.handle('usage:get', () => view())
    ipcMain.handle('usage:budget', (_e, b: Partial<BudgetSettings>) => {
      const clean: Partial<BudgetSettings> = {}
      for (const k of ['perTaskUsd', 'perDayUsd', 'perTaskTokens'] as const) if (b?.[k] !== undefined) clean[k] = Math.max(0, Number(b[k]) || 0)
      store.updateSettings({ budget: { ...store.settings.budget, ...clean } })
      ctx.pushState()
      return view()
    })
    ipcMain.handle('usage:prices', (_e, prices: PriceEntry[]) => {
      if (!Array.isArray(prices)) throw new Error('价格表格式错误')
      const clean = prices
        .filter((p) => p && p.models && p.label)
        .map((p) => {
          const d = DEFAULT_PRICES.find((x) => x.id === p.id)
          // 用户修改过内置条目 → 不再随版本自动更新
          const changed = d && JSON.stringify({ ...d }) !== JSON.stringify({ ...p })
          return { ...p, builtin: d ? !changed && p.builtin !== false : false }
        })
      store.updateSettings({ prices: clean })
      ctx.pushState()
      return view()
    })
    ipcMain.handle('usage:resetPrices', () => {
      store.updateSettings({ prices: DEFAULT_PRICES.map((p) => ({ ...p })) })
      ctx.pushState()
      return view()
    })
    ipcMain.handle('usage:clear', () => {
      ledger.clear()
      return view()
    })
    ipcMain.handle('grounding:save', (_e, g: Partial<GroundingSettings> & { apiKey?: string }) => {
      const { apiKey, ...rest } = g || {}
      const patch: Partial<Settings> = { grounding: { ...store.settings.grounding, ...rest } }
      if (apiKey !== undefined) patch.groundingApiKey = apiKey
      store.updateSettings(patch)
      ctx.pushState()
      return store.publicState()
    })
    ipcMain.handle('grounding:test', (_e, g?: Partial<GroundingSettings> & { apiKey?: string }) => testGrounding(g))
    ipcMain.handle('computer:senseStatus', () => senseStatus())
    ipcMain.handle('computer:previewMarks', async () => {
      try {
        const c = ctx.getComputer()
        const r = await c.execute('get_ui_elements', {})
        return { ok: true, message: `已识别 ${c.som.length} 个元素（${c.somEngine || '无'}）`, image: r.images?.[0], list: r.text, count: c.som.length, engine: c.somEngine }
      } catch (e: any) {
        return { ok: false, message: e?.message || String(e) }
      }
    })
  }

  return { usage, ledger, computerDeps, enhance, vncDeps, vncSession, sessions, ground, testGrounding, senseStatus, diagnostics, registerIpc, groundingConfig }
}

export type V07 = ReturnType<typeof createV07>
