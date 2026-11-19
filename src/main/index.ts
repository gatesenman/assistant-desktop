import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Notification, powerSaveBlocker, screen, shell, nativeImage, safeStorage, Tray } from 'electron'
import path from 'path'
import { spawn } from 'child_process'
import type { AppEvent, Assistant, ConnectionTestResult, McpServerConfig, ModelCapabilities, Routine, SettingsPatch, TaskInfo } from '../shared/types'
import { Store } from './core/store'
import { Agent } from './core/agent'
import { Scheduler, isValidCron } from './core/scheduler'
import { streamChat } from './core/llm'
import { BrowserManager } from './core/browser'
import { McpManager } from './core/mcp'
import { TaskManager } from './core/tasks'
import { DefaultToolHost } from './core/toolhost'
import type { SecretCodec } from './core/secrets'
import { setLaunchAtLogin } from './system'
import { APP_ICON_PNG, TRAY_ICON_PNG } from './icons'
import { runSmokeTest } from './smoke'
import { ComputerController } from './core/computer'
import { nativeComputerDeps } from './computerNative'
import { CrashGuard } from './core/crash'
import { ScreenLock } from './core/screenlock'
import { applyProxy, netFetch, normalizeProxyUrl, playwrightProxy, proxyLabel } from './net'
import { capKey, decideComputerMode, describeCapabilities, probeModel, PROVIDER_PRESETS } from './core/capabilities'
import { ocrEngine } from './ocrNative'
import { classifyNetwork, LlmError } from './core/errors'
import { checkForUpdate } from './core/updater'
import { buildLogBundle, teeConsole } from './core/logs'
import { createV04, type V04 } from './core/v04'
import { createV07, type V07 } from './v07'
import { localVm, VM_MACHINE_ID, runCmd } from './core/localVm'
import { vms } from './core/vms'
import type { DockurVmManager } from './core/dockurVm'
import { isVmOs, normalizeVmConfig, viewerUrl, vmOsFromMachineId, vmProfile, type VmOs, type VmUserConfig } from '../shared/vmProfiles'
import { CONNECTOR_PACKS, testConnector } from './core/connectors'
import { uid } from './core/util'
import { TeachRecorder } from './core/teach'
import { exportReplay, groupComputerLog } from './core/replay'
import fs from 'fs'
import os from 'os'

if (process.env.ASSISTANT_USER_DATA) app.setPath('userData', process.env.ASSISTANT_USER_DATA)

const E2E = process.env.ASSISTANT_E2E === '1'
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let store: Store
let agent: Agent
let scheduler: Scheduler
let browser: BrowserManager
let mcp: McpManager
let tasks: TaskManager
let trayHintShown = false
let overlay: BrowserWindow | null = null
let minimizedForComputer = false
let powerId: number | null = null
let powerKind: string | null = null
let crashGuard: CrashGuard | null = null
let rendererReloads = 0
let computerTextMode = false
let v04: V04
let computer: ComputerController
let teach: TeachRecorder
let v07: V07
const STOP_ACCEL = 'Control+Alt+Escape'

/** E2E 测试钩子（仅 ASSISTANT_E2E=1 时暴露） */
const e2e = {
  notifications: [] as { title: string; body: string }[],
  trayMenu: [] as string[],
  showWindow: (): void => showWindow(),
  closeWindow: (): void => win?.close(),
  togglePauseRoutines: (): void => togglePause(),
  quit: (): void => {
    quitting = true
    app.quit()
  },
  isWindowVisible: (): boolean => !!win && !win.isDestroyed() && win.isVisible(),
  hasTray: (): boolean => !!tray && !tray.isDestroyed(),
  overlayVisible: (): boolean => !!overlay && !overlay.isDestroyed() && overlay.isVisible(),
  overlayBounds: (): Electron.Rectangle | null => (overlay && !overlay.isDestroyed() ? overlay.getBounds() : null),
  stopShortcutRegistered: (): boolean => globalShortcut.isRegistered(STOP_ACCEL),
  powerBlocker: (): { kind: string | null; active: boolean } => ({
    kind: powerKind,
    active: powerId !== null && powerSaveBlocker.isStarted(powerId)
  }),
  emergencyStop: (): number => agent.emergencyStop('已通过停止按钮紧急停止'),
  crashRenderer: (): void => win?.webContents.forcefullyCrashRenderer(),
  rendererReloads: (): number => rendererReloads,
  screenLockHistory: () => agent.screen.history.map((h) => ({ ...h })),
  tasks: () => store.tasks.map((t) => ({ id: t.id, assistantId: t.assistantId, parentAssistantId: t.parentAssistantId, groupId: t.groupId, title: t.title, status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, result: t.result })),
  runningAssistants: (): string[] => store.state.assistants.filter((a) => agent.isRunning(a.id)).map((a) => a.id),
  crashMain: (): void => {
    setTimeout(() => {
      throw new Error('E2E 模拟主进程崩溃')
    }, 10)
  }
}
if (E2E) (globalThis as any).__assistantE2E = e2e

function emit(ev: AppEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('app:event', ev)
}
const pushState = (): void => emit({ type: 'state-changed', state: store.publicState() })

const electronCodec: SecretCodec = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  backend: () => {
    if (process.platform === 'darwin') return 'macOS Keychain'
    if (process.platform === 'win32') return 'Windows DPAPI'
    try {
      return (safeStorage as any).getSelectedStorageBackend?.() || 'linux'
    } catch {
      return 'linux'
    }
  },
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
}

function createWindow(show = true): void {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: '小助手',
    icon: nativeImage.createFromDataURL(APP_ICON_PNG),
    backgroundColor: store?.settings.theme === 'light' ? '#ffffff' : '#0d0d0d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.on('ready-to-show', () => {
    if (show && (!process.env.ASSISTANT_SMOKE || process.env.ASSISTANT_SMOKE_SCREENSHOT)) win?.show()
  })
  win.on('close', (e) => {
    if (!quitting && store.settings.closeToTray && tray) {
      e.preventDefault()
      win?.hide()
      if (!trayHintShown) {
        trayHintShown = true
        showNotification('小助手仍在后台运行', '定时任务会继续执行。可通过托盘图标重新打开或退出。')
      }
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    crashGuard?.log(`渲染进程退出：${details.reason} (${details.exitCode})`)
    rendererReloads++
    const w = win
    setTimeout(() => {
      if (!w || w.isDestroyed()) return
      // 重建窗口（比在崩溃的 webContents 上 reload 更可靠）
      const visible = w.isVisible()
      w.destroy()
      createWindow(visible)
    }, 300)
  })
  win.on('unresponsive', () => crashGuard?.log('窗口无响应'))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow(true)
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/** 「正在控制电脑」悬浮条：置顶、不抢焦点，带停止按钮 */
function showOverlay(): void {
  if (!overlay || overlay.isDestroyed()) {
    const d = screen.getPrimaryDisplay().workArea
    const w = 620
    overlay = new BrowserWindow({
      width: w,
      height: 44,
      x: Math.round(d.x + (d.width - w) / 2),
      y: d.y + 8,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      backgroundColor: '#1f1f1f',
      title: '小助手正在控制电脑',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true)
    const keys = STOP_ACCEL.replace('Control', 'Ctrl').replace('Escape', 'Esc')
    if (process.env.ELECTRON_RENDERER_URL) void overlay.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html?keys=${encodeURIComponent(keys)}`)
    else void overlay.loadFile(path.join(__dirname, '../renderer/overlay.html'), { query: { keys } })
    overlay.once('ready-to-show', () => overlay?.showInactive())
    overlay.on('closed', () => (overlay = null))
  } else overlay.showInactive()
}

function hideOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.hide()
}

function onComputerSession(active: boolean): void {
  store.runtime.computerActive = active
  if (active) {
    showOverlay()
    if (!globalShortcut.isRegistered(STOP_ACCEL)) {
      const ok = globalShortcut.register(STOP_ACCEL, () => {
        const n = agent.emergencyStop('已通过 Ctrl+Alt+Esc 紧急停止')
        if (n) showNotification('已紧急停止', '小助手已停止控制电脑。')
      })
      if (!ok) console.warn('[computer] 无法注册全局急停快捷键', STOP_ACCEL)
    }
    if (store.settings.minimizeOnComputerUse && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
      minimizedForComputer = true
      win.minimize()
    }
  } else {
    hideOverlay()
    globalShortcut.unregister(STOP_ACCEL)
    if (minimizedForComputer && win && !win.isDestroyed()) {
      minimizedForComputer = false
      if (win.isMinimized()) win.restore()
    }
  }
  updatePower()
}

/** 阻止休眠：控制电脑时保持屏幕常亮；有运行中的对话/任务或启用的定时任务时阻止系统挂起 */
function updatePower(): void {
  let want: 'prevent-display-sleep' | 'prevent-app-suspension' | null = null
  if (store.runtime.computerActive) want = 'prevent-display-sleep'
  else if (store.settings.preventSleep) {
    const busy =
      store.state.assistants.some((a) => agent.isRunning(a.id)) ||
      store.tasks.some((t) => t.status === 'running' || t.status === 'queued') ||
      (!store.settings.routinesPaused && store.state.routines.some((r) => r.enabled))
    if (busy) want = 'prevent-app-suspension'
  }
  if (want !== powerKind) {
    if (powerId !== null && powerSaveBlocker.isStarted(powerId)) powerSaveBlocker.stop(powerId)
    powerId = want ? powerSaveBlocker.start(want) : null
    powerKind = want
  }
  if (powerKind !== store.runtime.powerBlocker || store.runtime.computerActive !== lastRuntimeSent) {
    store.runtime.powerBlocker = powerKind
    lastRuntimeSent = store.runtime.computerActive
    emitRuntime()
  }
}
function emitRuntime(): void {
  const r = store.runtime
  emit({
    type: 'runtime',
    runtime: {
      computerActive: r.computerActive,
      powerBlocker: r.powerBlocker,
      screenOwner: r.screenOwner,
      screenQueue: [...r.screenQueue],
      takeover: r.takeover ? { ...r.takeover } : null,
      teachRecording: !!r.teachRecording
    }
  })
}
let lastRuntimeSent = false

async function transcribe(b64: string, mime: string): Promise<{ ok: boolean; text: string }> {
  const s = store.settings
  try {
    const base = s.baseUrl.replace(/\/+$/, '')
    const fd = new FormData()
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : 'webm'
    fd.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime || 'audio/webm' }), `voice.${ext}`)
    fd.append('model', s.transcriptionModel || 'whisper-1')
    fd.append('language', 'zh')
    const res = await netFetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      body: fd,
      signal: AbortSignal.timeout(120000)
    })
    const body = await res.text()
    if (!res.ok) return { ok: false, text: `转写失败（HTTP ${res.status}）：${body.slice(0, 200)}` }
    let text = body
    try {
      text = JSON.parse(body).text ?? body
    } catch {
      /* 纯文本响应 */
    }
    return { ok: true, text: String(text).trim() }
  } catch (e) {
    return { ok: false, text: '转写失败：' + errorText(e) }
  }
}

function togglePause(): void {
  store.updateSettings({ routinesPaused: !store.settings.routinesPaused })
  pushState()
  buildTrayMenu()
}

function buildTrayMenu(): void {
  if (!tray) return
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: '打开小助手', click: () => showWindow() },
    { label: '暂停定时任务', type: 'checkbox', checked: store.settings.routinesPaused, click: () => togglePause() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ]
  e2e.trayMenu = items.filter((i) => i.label).map((i) => `${i.label}${i.type === 'checkbox' ? (i.checked ? ' [✓]' : ' [ ]') : ''}`)
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(store.settings.routinesPaused ? '小助手（定时任务已暂停）' : '小助手')
}

function createTray(): void {
  try {
    const img = nativeImage.createFromDataURL(TRAY_ICON_PNG)
    tray = new Tray(process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img)
    tray.on('click', () => showWindow())
    buildTrayMenu()
  } catch (e) {
    console.error('[tray] 创建托盘失败', e)
    tray = null
  }
}

function showNotification(title: string, body: string, assistantId?: string): void {
  e2e.notifications.push({ title, body })
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body: body.slice(0, 220), icon: nativeImage.createFromDataURL(APP_ICON_PNG) })
  n.on('click', () => {
    showWindow()
    if (assistantId) emit({ type: 'navigate', assistantId })
  })
  n.show()
}

function onRoutineDone(routine: Routine, assistantName: string, text: string, error?: string): void {
  showNotification(
    `${assistantName} · ${routine.name}`,
    error ? `执行失败：${error}` : (text || '（无文本输出）').replace(/\s+/g, ' '),
    routine.assistantId
  )
}

function onTaskFinished(t: TaskInfo, assistantName: string): void {
  if (win && win.isVisible() && win.isFocused()) return
  showNotification(`${assistantName} · 后台任务${t.status === 'done' ? '完成' : '结束'}`, `「${t.title}」${t.error ? '：' + t.error : ''}`, t.assistantId)
}

async function runProbe(baseUrl: string, apiKey: string, model: string): Promise<ConnectionTestResult> {
  if (!baseUrl || !model) return { ok: false, message: '请填写 Base URL 和模型名称' }
  try {
    const caps: ModelCapabilities = await probeModel({ baseUrl, apiKey, model, fetchImpl: netFetch, proxyLabel: proxyLabel() })
    store.state.settings.capabilities = { ...store.settings.capabilities, [capKey(baseUrl, model)]: caps }
    store.save()
    pushState()
    return { ok: true, message: describeCapabilities(caps), capabilities: caps }
  } catch (e) {
    const err = e instanceof LlmError ? e : classifyNetwork(e, { baseUrl, proxy: proxyLabel() })
    return { ok: false, message: err.message, errorKind: err.kind }
  }
}

function errorText(e: unknown): string {
  return (e as any)?.message || String(e)
}

/** v0.6：告诉模型当前电脑控制目标（本机 / 远程 / 哪台虚拟电脑） */
function describeComputerTarget(): string {
  const id = store?.settings.activeMachineId || 'local'
  const vmOs = vmOsFromMachineId(id)
  if (!vmOs) return id === 'local' ? '当前电脑控制目标：本机（用户的真实桌面）。' : `当前电脑控制目标：远程机器 ${id}。`
  const p = vmProfile(vmOs)
  const st = vms.get(vmOs).status()
  const head = `当前电脑控制目标：本地虚拟电脑「${p.title}」（Docker 容器 ${p.container}，状态 ${st.phase}${st.desktopUrl ? '，查看器 ' + st.desktopUrl : ''}）。`
  if (vmOs === 'linux') return head + `屏幕分辨率 1280x800，操作不会影响用户的真实桌面${store.settings.linuxVmControl === 'vnc' ? '（键鼠经 VNC 发送）' : ''}。`
  return (
    head +
    `智能体通过 VNC 直接控制这台虚拟机的屏幕、鼠标和键盘，操作不会影响用户的真实桌面。注意：VNC 只能输入英文字母、数字和符号（中文会报错，可改用英文或拼音输入法）；` +
    (vmOs === 'windows' ? 'open_app / open_url 通过「运行」对话框（Win+R）实现；' : 'open_app / open_url 通过聚焦搜索（⌘+空格）实现；') +
    (st.phase === 'installing' ? '系统仍在安装中，画面可能是安装程序。' : '')
  )
}

function resolveActiveAssistantId(preferred?: string): string | null {
  if (preferred) return preferred
  if (store.runtime.takeover?.assistantId) return store.runtime.takeover.assistantId
  const owner = store.runtime.screenOwner
  if (owner) {
    if (!owner.startsWith('task:')) return owner
    const tid = owner.slice(5)
    const task = store.tasks.find((x) => x.id === tid)
    if (task) return task.assistantId
  }
  const running = store.state.assistants.find((a) => agent.isRunning(a.id))
  return running?.id || store.state.assistants[0]?.id || null
}

function registerIpc(): void {
  const st = () => store.publicState()
  ipcMain.handle('state:get', () => st())
  ipcMain.handle('settings:save', async (_e, patch: SettingsPatch) => {
    const prevLogin = store.settings.launchAtLogin
    if (patch.proxyMode === 'custom' || (patch.proxyUrl !== undefined && (patch.proxyMode ?? store.settings.proxyMode) === 'custom')) {
      const u = patch.proxyUrl ?? store.settings.proxyUrl
      if (!normalizeProxyUrl(u)) throw new Error(`代理地址无效：「${u}」。示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080`)
    }
    // 渲染进程不应覆盖主进程维护的能力缓存
    delete (patch as any).capabilities
    store.updateSettings(patch)
    if (patch.proxyMode !== undefined || patch.proxyUrl !== undefined) {
      await applyProxy(store.settings.proxyMode, store.settings.proxyUrl).catch((e) => console.error('[proxy]', e))
      void browser.close()
    }
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== prevLogin) {
      try {
        setLaunchAtLogin(patch.launchAtLogin)
      } catch (e) {
        console.error('[autostart]', e)
      }
    }
    if (patch.routinesPaused !== undefined) buildTrayMenu()
    if (patch.browserHeadless !== undefined || patch.browserExecutablePath !== undefined) void browser.close()
    if (patch.linuxVmControl !== undefined) {
      try {
        computer.setDeps(v07.computerDeps())
      } catch (e) {
        console.error('[computer] setDeps', e)
      }
    }
    pushState()
    return st()
  })
  ipcMain.handle('usage:resume', async (_e, assistantId: string) => {
    v07.usage.paused.delete(assistantId)
    if (agent.isRunning(assistantId)) return
    void agent.run(assistantId, { text: '（已调整预算）请从刚才暂停的地方继续完成任务。' }).catch((err) => console.error('[agent]', err))
  })
  ipcMain.handle('assistant:create', (_e, name: string) => {
    const a = store.createAssistant(name)
    pushState()
    return a
  })
  ipcMain.handle('assistant:update', (_e, id: string, patch: Partial<Assistant>) => {
    store.updateAssistant(id, patch)
    pushState()
    return st()
  })
  ipcMain.handle('assistant:delete', (_e, id: string) => {
    agent.stop(id)
    for (const t of store.tasks) if (t.assistantId === id && (t.status === 'running' || t.status === 'queued')) tasks.cancel(t.id)
    store.deleteAssistant(id)
    scheduler.sync()
    pushState()
    return st()
  })
  ipcMain.handle('messages:get', (_e, id: string) => store.getMessages(id))
  ipcMain.handle('messages:clear', (_e, id: string) => {
    if (agent.isRunning(id)) agent.stop(id)
    store.clearMessages(id)
    emit({ type: 'messages-reset', assistantId: id })
  })
  ipcMain.handle('chat:running', (_e, id: string) => agent.isRunning(id))
  ipcMain.handle('chat:send', (_e, id: string, text: string, images: string[]) => {
    if (agent.isRunning(id)) {
      // v0.8：运行中引导入队
      if (agent.enqueueGuidance(id, text)) {
        const msgs = store.getMessages(id)
        const m = { id: uid(), role: 'user' as const, content: text, images: images?.length ? images : undefined, createdAt: Date.now() }
        msgs.push(m)
        emit({ type: 'message-upsert', assistantId: id, message: m })
        store.saveMessages(id)
        return
      }
      throw new Error('该助手正在回复中，请稍候或点击停止')
    }
    void agent.run(id, { text, images }).catch((err) => console.error('[agent]', err))
  })
  ipcMain.handle('chat:stop', (_e, id: string) => agent.stop(id))
  ipcMain.handle('tool:respond', (_e, callId: string, approved: boolean) => agent.respondApproval(callId, approved))
  ipcMain.handle('ask:respond', (_e, callId: string, answer: string | null) => agent.respondAskUser(callId, answer))
  ipcMain.handle('plan:confirm', (_e, messageId: string, action: 'confirm' | 'reject' | 'edit', text?: string) => agent.confirmPlan(messageId, action, text))
  ipcMain.handle('agent:takeover', (_e, assistantId: string, reason?: string) => {
    const id = resolveActiveAssistantId(assistantId)
    if (!id) throw new Error('没有可接管的运行中助手')
    return agent.takeover(id, reason || '用户接管')
  })
  ipcMain.handle('agent:handback', (_e, assistantId: string, note?: string) => {
    const id = resolveActiveAssistantId(assistantId) || store.runtime.takeover?.assistantId
    if (!id) throw new Error('没有可交还的接管会话')
    return agent.handback(id, note)
  })
  ipcMain.handle('computer:exportReplay', (_e, opts: { runId?: string; format?: 'gif' | 'mp4' } = {}) => {
    const groups = groupComputerLog(store.computerLog)
    const g = opts.runId ? groups.find((x) => x.runId === opts.runId) : groups[0]
    if (!g) return { ok: false, message: '没有可导出的轨迹' }
    const outDir = path.join(app.getPath('userData'), 'replays')
    return exportReplay(g.frames, outDir, { format: opts.format || 'gif', basename: `replay-${g.runId.slice(0, 12)}` })
  })
  ipcMain.handle('experience:list', () => store.experience.list())
  ipcMain.handle('teach:start', (_e, title: string, assistantId?: string) => {
    try {
      const s = teach.start(title, assistantId)
      store.runtime.teachRecording = true
      emit({ type: 'teach', recording: true, sessionId: s.id })
      emitRuntime()
      return { ok: true, id: s.id, message: '已开始示教录制' }
    } catch (e: any) {
      return { ok: false, message: e?.message || String(e) }
    }
  })
  ipcMain.handle('teach:stop', (_e, saveSkill?: boolean) => {
    try {
      const s = teach.stop()
      store.runtime.teachRecording = false
      emit({ type: 'teach', recording: false, sessionId: s.id })
      emitRuntime()
      let skillId: string | undefined
      let skillPath: string | undefined
      if (saveSkill !== false) {
        const r = teach.saveAsSkill(s)
        skillId = r.id
        skillPath = r.path
      }
      return { ok: true, id: s.id, skillId, path: skillPath, message: skillId ? `已生成技能草稿 ${skillId}` : '已停止录制' }
    } catch (e: any) {
      return { ok: false, message: e?.message || String(e) }
    }
  })
  ipcMain.handle('teach:record', (_e, ev: any) => {
    try {
      teach.record(ev)
    } catch {
      /* ignore if not recording */
    }
  })
  ipcMain.handle('routine:create', (_e, r: Omit<Routine, 'id' | 'createdAt'>) => {
    if (!isValidCron(r.cron)) throw new Error('无效的 cron 表达式')
    store.createRoutine(r)
    scheduler.sync()
    pushState()
    return st()
  })
  ipcMain.handle('routine:update', (_e, id: string, patch: Partial<Routine>) => {
    if (patch.cron !== undefined && !isValidCron(patch.cron)) throw new Error('无效的 cron 表达式')
    store.updateRoutine(id, patch)
    scheduler.sync()
    pushState()
    return st()
  })
  ipcMain.handle('routine:delete', (_e, id: string) => {
    store.deleteRoutine(id)
    scheduler.sync()
    pushState()
    return st()
  })
  ipcMain.handle('routine:runNow', (_e, id: string) => {
    void scheduler.runRoutine(id)
  })
  ipcMain.handle('cron:validate', (_e, expr: string) => isValidCron(expr))
  ipcMain.handle('llm:test', async () => {
    const s = store.settings
    try {
      const r = await streamChat({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        messages: [{ role: 'user', content: '请只回复：OK' }],
        signal: AbortSignal.timeout(30000),
        fetchImpl: netFetch,
        proxyLabel: proxyLabel()
      })
      return { ok: true, message: `连接成功，模型回复：${(r.content || '(空)').slice(0, 100)}` }
    } catch (e) {
      return { ok: false, message: errorText(e instanceof LlmError ? e : classifyNetwork(e, { baseUrl: s.baseUrl, proxy: proxyLabel() })) }
    }
  })
  ipcMain.handle('llm:testModel', async (_e, cfg: { baseUrl: string; apiKey?: string; model: string; useSavedKey?: boolean }) => {
    const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '')
    let apiKey = cfg.useSavedKey || !cfg.apiKey ? store.settings.apiKey : cfg.apiKey.trim()
    let fromEnv = false
    if (!apiKey) {
      const preset = PROVIDER_PRESETS.find((p) => p.envKey && process.env[p.envKey] && p.baseUrl.replace(/\/+$/, '') === baseUrl)
      if (preset) {
        apiKey = process.env[preset.envKey!]!.trim()
        fromEnv = true
      }
    }
    const r = await runProbe(baseUrl, apiKey, cfg.model.trim())
    if (r.ok && fromEnv) {
      store.updateSettings({ apiKey })
      pushState()
    }
    return r
  })
  ipcMain.handle('llm:capabilities', async (_e, force?: boolean) => {
    const s = store.settings
    const cached = s.capabilities[capKey(s.baseUrl, s.model)]
    if (cached && !force) return { ok: true, message: describeCapabilities(cached), capabilities: cached }
    return runProbe(s.baseUrl, s.apiKey, s.model)
  })
  ipcMain.handle('proxy:test', async (_e, cfg: { proxyMode: 'system' | 'direct' | 'custom'; proxyUrl: string }) => {
    const { session } = await import('electron')
    const ses = session.fromPartition('proxy-test-' + Date.now())
    try {
      const label = await applyProxy(cfg.proxyMode, cfg.proxyUrl, ses)
      const target = store.settings.baseUrl || 'https://api.openai.com/v1'
      const t0 = Date.now()
      const res = await ses.fetch(target.replace(/\/+$/, '') + '/models', { signal: AbortSignal.timeout(15000) })
      return { ok: true, message: `通过「${label}」访问 ${new URL(target).host} 成功（HTTP ${res.status}，${Date.now() - t0} ms）` }
    } catch (e: any) {
      if (/代理地址无效/.test(e?.message)) return { ok: false, message: e.message }
      return { ok: false, message: classifyNetwork(e, { baseUrl: store.settings.baseUrl, proxy: cfg.proxyMode === 'custom' ? cfg.proxyUrl : undefined }).message }
    } finally {
      // 恢复默认会话的代理（applyProxy 会更新全局标签）
      void applyProxy(store.settings.proxyMode, store.settings.proxyUrl).catch(() => {})
    }
  })
  ipcMain.handle('setup:defaults', () => ({
    presets: PROVIDER_PRESETS,
    env: PROVIDER_PRESETS.filter((p) => p.envKey && process.env[p.envKey]).map((p) => ({ id: p.id, envKey: p.envKey! }))
  }))
  ipcMain.handle('chat:retry', (_e, id: string) => {
    if (agent.isRunning(id)) throw new Error('该助手正在回复中')
    void agent.retryLast(id).catch((err) => console.error('[agent]', err))
  })
  ipcMain.handle('update:check', () => checkForUpdate(app.getVersion(), store.settings.updateUrl, netFetch))

  // —— v0.4 连接器 / 技能 / 远程 / 通道 / 编排 ——
  ipcMain.handle('connectors:packs', () => CONNECTOR_PACKS)
  ipcMain.handle('connectors:save', async (_e, cfg: any) => {
    const list = [...(store.settings.connectors || [])]
    const secrets = cfg.secrets || {}
    delete cfg.secrets
    const i = list.findIndex((c) => c.id === cfg.id)
    const row = { ...cfg, status: cfg.status || 'disconnected', createdAt: cfg.createdAt || Date.now() }
    if (i >= 0) list[i] = { ...list[i], ...row }
    else list.push(row)
    if (Object.keys(secrets).length) v04.connSecrets.save(cfg.id, secrets)
    store.updateSettings({ connectors: list })
    v04.refreshViews()
    await v04.syncConnectorsToMcp()
    pushState()
    return st()
  })
  ipcMain.handle('connectors:delete', async (_e, id: string) => {
    v04.connSecrets.remove(id)
    store.updateSettings({ connectors: (store.settings.connectors || []).filter((c) => c.id !== id), mcpServers: store.settings.mcpServers.filter((m) => m.id !== 'connector:' + id) })
    await v04.syncConnectorsToMcp()
    v04.refreshViews()
    pushState()
    return st()
  })
  ipcMain.handle('connectors:test', async (_e, id: string) => {
    const c = store.settings.connectors.find((x) => x.id === id)
    if (!c) return { ok: false, message: '连接器不存在' }
    const r = await testConnector(c.kind, c.config, v04.connSecrets.load(id), netFetch)
    const list = store.settings.connectors.map((x) => (x.id === id ? { ...x, status: r.ok ? 'connected' as const : 'error' as const, error: r.ok ? undefined : r.message, lastOkAt: r.ok ? Date.now() : x.lastOkAt } : x))
    store.updateSettings({ connectors: list })
    pushState()
    return r
  })
  ipcMain.handle('skills:list', () => v04.skills.list())
  ipcMain.handle('skills:read', (_e, id: string) => v04.skills.read(id))
  ipcMain.handle('skills:save', (_e, id: string, body: string, meta: any) => {
    const m = v04.skills.save(id, body, meta)
    v04.refreshViews()
    pushState()
    return m
  })
  ipcMain.handle('skills:delete', (_e, id: string) => {
    v04.skills.delete(id)
    v04.refreshViews()
    pushState()
  })
  ipcMain.handle('workflows:list', () => v04.workflows.list())
  ipcMain.handle('workflows:save', (_e, w: any) => {
    const saved = v04.workflows.save(w)
    store.updateSettings({ workflows: v04.workflows.list() })
    pushState()
    return saved
  })
  ipcMain.handle('workflows:delete', (_e, id: string) => {
    v04.workflows.delete(id)
    store.updateSettings({ workflows: v04.workflows.list() })
    pushState()
  })
  ipcMain.handle('workflows:run', async (_e, id: string, assistantId: string) => {
    const w = v04.workflows.list().find((x: { id: string }) => x.id === id)
    if (!w) throw new Error('工作流不存在')
    const job = v04.orch.create(
      assistantId,
      w.name + '：' + w.description,
      w.steps.map((st: any, i: number) => {
        const deps = (st.dependsOn || [])
          .map((dep: string) => w.steps.findIndex((s: any) => s.id === dep))
          .filter((idx: number) => idx >= 0)
          .map((idx: number) => `wf-${idx}`)
        return {
          title: st.title,
          prompt: st.kind === 'skill' ? `请先 load_skill ${st.ref}，然后：${st.input || st.title}` : st.kind === 'tool' ? `请调用工具 ${st.ref}。${st.input || ''}` : st.input || st.title,
          dependsOn: deps,
          id: `wf-${i}`
        }
      })
    )
    return { jobId: job.id }
  })
  ipcMain.handle('machines:list', () => {
    v04.refreshViews()
    return store.machinesView
  })
  ipcMain.handle('machines:save', async (_e, m: any) => {
    const list = [...(store.settings.machines || [])]
    if (m.token) v04.setRemoteToken(m.token)
    if (m.url && m.token) {
      try {
        const client = new (await import('./core/remote')).RemoteAgentClient(m.url, m.token, m.label)
        const info = await client.connect()
        v04.clients.set(info.id, client)
        const row = { ...info, label: m.label || info.label, url: m.url }
        const i = list.findIndex((x) => x.id === row.id || x.url === m.url)
        if (i >= 0) list[i] = row
        else list.push(row)
        store.updateSettings({ machines: list })
        v04.refreshViews()
        pushState()
        return row
      } catch (e: any) {
        throw new Error('连接远程机器失败：' + (e?.message || e))
      }
    }
    const row = { id: m.id || uid(), label: m.label, kind: 'remote' as const, status: 'offline' as const, url: m.url, lastSeenAt: Date.now() }
    list.push(row)
    store.updateSettings({ machines: list })
    v04.refreshViews()
    pushState()
    return row
  })
  ipcMain.handle('machines:delete', (_e, id: string) => {
    v04.clients.get(id)?.close()
    v04.clients.delete(id)
    store.updateSettings({ machines: (store.settings.machines || []).filter((m) => m.id !== id) })
    if (store.settings.activeMachineId === id) store.updateSettings({ activeMachineId: 'local' })
    v04.refreshViews()
    pushState()
  })
  ipcMain.handle('machines:setActive', (_e, id: string) => {
    store.updateSettings({ activeMachineId: id })
    try {
      computer.setDeps(v07.computerDeps())
    } catch (e) {
      console.error(e)
    }
    pushState()
    return st()
  })
  ipcMain.handle('remote:startServer', async () => {
    let token = v04.remoteToken() || ''
    if (!token) {
      token = uid() + uid()
      v04.setRemoteToken(token)
    }
    const port = await v04.remoteServer.start(store.settings.remoteAgentPort || 8787)
    store.updateSettings({ remoteAgentPort: port })
    v04.refreshViews()
    pushState()
    return { ok: true, message: `远程伴侣已在端口 ${port} 监听。其他电脑添加 ws://<本机IP>:${port}，口令已保存在本机（设置中可见「已设置」）。` }
  })
  ipcMain.handle('remote:stopServer', async () => {
    await v04.remoteServer.stop()
    return
  })
  ipcMain.handle('channels:save', async (_e, cfg: any) => {
    const secrets = cfg.secrets || {}
    delete cfg.secrets
    const list = [...(store.settings.channels || [])]
    const i = list.findIndex((c) => c.id === cfg.id)
    const row = { requireApproval: true, status: 'disconnected', createdAt: Date.now(), ...cfg }
    if (i >= 0) list[i] = { ...list[i], ...row }
    else list.push(row)
    if (Object.keys(secrets).length) v04.channelSecrets.save(cfg.id, secrets)
    store.updateSettings({ channels: list })
    await v04.channels.sync(list)
    if (cfg.kind === 'wechat_bridge') await v04.channels.ensureBridge()
    v04.refreshViews()
    pushState()
    return st()
  })
  ipcMain.handle('channels:delete', async (_e, id: string) => {
    v04.channelSecrets.remove(id)
    store.updateSettings({ channels: (store.settings.channels || []).filter((c) => c.id !== id) })
    await v04.channels.sync(store.settings.channels)
    pushState()
    return st()
  })
  ipcMain.handle('channels:test', async (_e, id: string) => {
    const c = store.settings.channels.find((x) => x.id === id)
    if (!c) return { ok: false, message: '通道不存在' }
    if (c.kind === 'telegram' || c.kind === 'slack') return testConnector(c.kind === 'telegram' ? 'telegram' : 'slack', c.config, v04.channelSecrets.load(id), netFetch)
    if (c.kind === 'wechat_bridge') {
      const port = await v04.channels.ensureBridge()
      return { ok: true, message: `微信本地桥 http://127.0.0.1:${port}/wechat （POST JSON {chatKey,text}）` }
    }
    return { ok: false, message: '未知通道' }
  })
  ipcMain.handle('channels:approveSend', async (_e, draftId: string, approved: boolean) => {
    const raw = await v04.channels.respondDraft(draftId, approved)
    if (!approved) return
    try {
      const { __send } = JSON.parse(raw)
      const c = store.settings.channels.find((x) => x.id === __send.channelId)
      if (c) await v04.channels.deliver(c, __send.chatKey, __send.text)
    } catch {
      /* not a send payload */
    }
  })
  ipcMain.handle('orch:create', (_e, assistantId: string, goal: string, nodes: any) => v04.orch.create(assistantId, goal, nodes))
  ipcMain.handle('orch:pause', (_e, id: string) => v04.orch.pause(id))
  ipcMain.handle('orch:resume', (_e, id: string) => v04.orch.resume(id))
  ipcMain.handle('orch:cancel', (_e, id: string) => v04.orch.cancel(id))
  ipcMain.handle('orch:list', () => v04.orch.list())

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('logs:export', async () => {
    try {
      const dir = E2E ? app.getPath('userData') : app.getPath('downloads')
      const file = path.join(dir, `assistant-desktop-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`)
      const s = store.settings
      let localVmDiag = ''
      try {
        localVmDiag = await vms.diagnostics(app.getAppPath(), s.workDir || os.homedir())
      } catch (e) {
        localVmDiag = 'localVm 诊断不可用：' + String((e as Error)?.message || e)
      }
      const text = buildLogBundle({
        userData: app.getPath('userData'),
        info: {
          版本: app.getVersion(),
          系统: `${process.platform} ${os.release()} ${process.arch}`,
          Electron: process.versions.electron,
          代理: s.proxyMode + (s.proxyMode === 'custom' ? ' ' + s.proxyUrl : ''),
          能力检测: Object.values(s.capabilities || {}).map((c) => `${c.model}: tools=${c.tools} vision=${c.vision}`),
          助手数: store.state.assistants.length,
          任务: store.tasks.slice(-20).map((t) => `${t.status} ${t.title}`),
          虚拟电脑诊断: localVmDiag,
          v07: await v07.diagnostics().catch((e: unknown) => ({ error: String((e as Error)?.message || e) }))
        },
        settings: s as any,
        secrets: [s.apiKey, s.groundingApiKey || '', ...s.mcpServers.flatMap((m: any) => Object.values({ ...(m.env || {}), ...(m.headers || {}) }) as string[])]
      })
      fs.writeFileSync(file, text)
      if (!E2E) shell.showItemInFolder(file)
      return { ok: true, path: file, message: `已导出到 ${file}` }
    } catch (e) {
      return { ok: false, path: '', message: '导出失败：' + errorText(e) }
    }
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url)
  })
  ipcMain.handle('tasks:list', () => store.tasks)
  ipcMain.handle('tasks:cancel', (_e, id: string) => tasks.cancel(id))
  ipcMain.handle('tasks:clear', (_e, aid: string) => {
    tasks.clearFinished(aid)
    return store.tasks
  })
  ipcMain.handle('mcp:save', async (_e, cfg: McpServerConfig) => {
    store.upsertMcpServer(cfg)
    await mcp.sync(store.settings.mcpServers)
    return st()
  })
  ipcMain.handle('mcp:delete', async (_e, id: string) => {
    store.deleteMcpServer(id)
    await mcp.sync(store.settings.mcpServers)
    return st()
  })
  ipcMain.handle('mcp:refresh', async (_e, id: string) => {
    const cfg = store.settings.mcpServers.find((s) => s.id === id)
    if (cfg?.enabled) await mcp.connect(cfg)
    return st()
  })
  ipcMain.handle('browser:install', () => installChromium())
  ipcMain.handle('computer:log', () => store.computerLog)
  ipcMain.handle('computer:clearLog', () => store.clearComputerLog())
  ipcMain.handle('computer:stop', () => {
    agent.emergencyStop('已通过停止按钮紧急停止')
  })

  ipcMain.handle('threads:list', (_e, assistantId: string) => store.listThreads(assistantId))
  ipcMain.handle('threads:create', (_e, assistantId: string, title?: string) => {
    const t = store.createThread(assistantId, title)
    pushState()
    emit({ type: 'messages-reset', assistantId })
    return t
  })
  ipcMain.handle('threads:switch', (_e, assistantId: string, threadId: string) => {
    store.switchThread(assistantId, threadId)
    emit({ type: 'messages-reset', assistantId })
    return st()
  })
  ipcMain.handle('threads:rename', (_e, threadId: string, title: string) => {
    store.renameThread(threadId, title)
    return st()
  })
  ipcMain.handle('threads:delete', (_e, threadId: string) => {
    const thr = store.state.threads.find((x) => x.id === threadId)
    const aid = thr?.assistantId
    store.deleteThread(threadId)
    if (aid) emit({ type: 'messages-reset', assistantId: aid })
    return st()
  })
  ipcMain.handle('assistant:pin', (_e, id: string, pinned: boolean) => {
    store.pinAssistant(id, pinned)
    return st()
  })
  ipcMain.handle('assistant:hide', (_e, id: string, hidden: boolean) => {
    store.hideAssistant(id, hidden)
    return st()
  })
  ipcMain.handle('assistant:duplicate', (_e, id: string) => {
    const a = store.duplicateAssistant(id)
    pushState()
    return a
  })
  ipcMain.handle('folders:list', () => store.listFolders())
  ipcMain.handle('folders:save', (_e, f: any) => {
    const folder = store.saveFolder(f)
    pushState()
    return folder
  })
  ipcMain.handle('folders:delete', (_e, id: string) => {
    store.deleteFolder(id)
    pushState()
  })
  ipcMain.handle('assistant:moveFolder', (_e, assistantId: string, folderId: string | null) => {
    store.moveAssistantToFolder(assistantId, folderId)
    return st()
  })
  ipcMain.handle('assistant:runStyle', (_e, assistantId: string, style: 'ask' | 'auto') => {
    store.setRunStyle(assistantId, style)
    // Auto ≈ 信任模式倾向；Ask ≈ 逐步审批（关闭信任模式）
    if (style === 'auto') store.updateSettings({ trustedMode: true })
    else store.updateSettings({ trustedMode: false })
    pushState()
    return st()
  })
  ipcMain.handle('computer:preview', async () => {
    try {
      const mid = store.settings.activeMachineId || 'local'
      const vmOsSel = vmOsFromMachineId(mid)
      // Windows / macOS 虚拟电脑：v0.7 通过 VNC 截图；未运行则返回 null（绝不回落去截宿主屏幕）
      if (vmOsSel && vmOsSel !== 'linux') {
        if (!process.env.ASSISTANT_VNC_URL_OVERRIDE && !vms.get(vmOsSel).status().containerRunning && !(await vms.get(vmOsSel).refresh().catch(() => vms.get(vmOsSel).status())).containerRunning) return null
        const c = await v07.vncSession(vmOsSel).capture()
        const thumb = 'data:image/jpeg;base64,' + c.thumb.toString('base64')
        store.setComputerPreview(thumb, mid)
        emit({ type: 'computer-preview', thumb, at: Date.now(), machineId: mid })
        return { thumb, at: Date.now() }
      }
      if (vmOsSel === 'linux' && localVm.phase !== 'ready') return null
      if ((mid === VM_MACHINE_ID || mid === 'virtual') && localVm.phase === 'ready') {
        const c = await localVm.capture()
        const thumb = 'data:image/jpeg;base64,' + c.thumb.toString('base64')
        store.setComputerPreview(thumb, VM_MACHINE_ID)
        emit({ type: 'computer-preview', thumb, at: Date.now(), machineId: VM_MACHINE_ID })
        return { thumb, at: Date.now() }
      }
      if (!computer) return store.computerPreview
      const r = await computer.screenshot()
      store.setComputerPreview(r.thumb, mid)
      emit({ type: 'computer-preview', thumb: r.thumb, at: Date.now(), machineId: mid })
      return { thumb: r.thumb, at: Date.now() }
    } catch (e) {
      return store.computerPreview ? { thumb: store.computerPreview.thumb, at: store.computerPreview.at } : null
    }
  })


  ipcMain.handle('localVm:status', async () => {
    const s = await localVm.refresh()
    store.localVmStatus = s
    return s
  })
  ipcMain.handle('localVm:start', async (_e, assistantId?: string, opts?: { forceRebuild?: boolean }) => {
    const aid = assistantId || store.state.assistants[0]?.id
    const a = aid ? store.getAssistant(aid) : undefined
    const workDir = (a?.workDir || store.settings.workDir || require('os').homedir())
    const s = await localVm.start({ workDir, appPath: app.getAppPath(), userDataPath: app.getPath('userData'), forceRebuild: !!opts?.forceRebuild })
    store.localVmStatus = s
    if (s.phase === 'ready') {
      store.updateSettings({ activeMachineId: VM_MACHINE_ID, computerEnabled: true })
      if (a) store.updateAssistant(a.id, { computerMode: 'virtual', computerEnabled: true, remoteMachineId: VM_MACHINE_ID })
      try {
        computer.setDeps(v07.computerDeps())
      } catch (e) {
        console.error('[localVm] setDeps', e)
      }
      v04.refreshViews()
    }
    emit({ type: 'local-vm', status: s })
    pushState()
    return s
  })
  ipcMain.handle('localVm:stop', async () => {
    const s = await localVm.stop()
    store.localVmStatus = s
    if (store.settings.activeMachineId === VM_MACHINE_ID) {
      store.updateSettings({ activeMachineId: 'local' })
      try {
        computer.setDeps(v07.computerDeps())
      } catch {
        /* ignore */
      }
    }
    v04.refreshViews()
    emit({ type: 'local-vm', status: s })
    pushState()
    return s
  })
  ipcMain.handle('localVm:openDesktop', async () => {
    if (localVm.phase !== 'ready' && !(await localVm.containerRunning())) {
      return { ok: false, message: '虚拟电脑未运行。请先切换到「虚拟电脑」并一键启动；本机桌面请直接使用系统桌面。' }
    }
    const url = localVm.desktopUrl()
    await shell.openExternal(url)
    return { ok: true, url, message: '已在浏览器打开虚拟桌面（noVNC）' }
  })

  ipcMain.handle('localVm:tryStartDocker', async () => {
    const s = await localVm.tryStartDockerDesktopAndWait(90_000)
    store.localVmStatus = s
    emit({ type: 'local-vm', status: s })
    pushState()
    return s
  })

  ipcMain.handle('localVm:rebuild', async (_e, assistantId?: string) => {
    const aid = assistantId || store.state.assistants[0]?.id
    const a = aid ? store.getAssistant(aid) : undefined
    const workDir = (a?.workDir || store.settings.workDir || require('os').homedir())
    const s = await localVm.start({
      workDir,
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      forceRebuild: true
    })
    store.localVmStatus = s
    if (s.phase === 'ready') {
      store.updateSettings({ activeMachineId: VM_MACHINE_ID, computerEnabled: true })
      if (a) store.updateAssistant(a.id, { computerMode: 'virtual', computerEnabled: true, remoteMachineId: VM_MACHINE_ID })
      try {
        computer.setDeps(v07.computerDeps())
      } catch (e) {
        console.error('[localVm] setDeps', e)
      }
      v04.refreshViews()
    }
    emit({ type: 'local-vm', status: s })
    pushState()
    return s
  })

  /* ---------------------- v0.6 多系统虚拟电脑 ---------------------- */
  const vmWorkDir = (assistantId?: string): string => {
    const aid = assistantId || store.state.assistants[0]?.id
    const a = aid ? store.getAssistant(aid) : undefined
    return a?.workDir || store.settings.workDir || os.homedir()
  }
  const vmOsArg = (v: unknown): VmOs => (isVmOs(v) ? v : 'linux')
  const applyDeps = (): void => {
    try {
      computer.setDeps(v07.computerDeps())
    } catch (e) {
      console.error('[vm] setDeps', e)
    }
  }
  const releaseIfActive = (vmOs: VmOs): void => {
    const mid = store.settings.activeMachineId
    if (vmOsFromMachineId(mid) === vmOs) {
      store.updateSettings({ activeMachineId: 'local' })
      applyDeps()
    }
  }
  const finishVm = (vmOs: VmOs): any => {
    const st = { ...vms.get(vmOs).status(), os: vmOs }
    if (vmOs === 'linux') store.localVmStatus = st
    store.vmsStatus = vms.statuses()
    v04.refreshViews()
    emit({ type: 'vms', list: store.vmsStatus as any })
    if (vmOs === 'linux') emit({ type: 'local-vm', status: st })
    pushState()
    return st
  }
  const saveVmConfig = (vmOs: VmOs, cfg?: Partial<VmUserConfig>): void => {
    const all = { ...(store.settings.vmConfigs || {}) }
    all[vmOs] = normalizeVmConfig(vmOs, { ...(all[vmOs] || {}), ...(cfg || {}) })
    store.updateSettings({ vmConfigs: all, vmLastOs: vmOs })
    if (vmOs !== 'linux') (vms.get(vmOs) as DockurVmManager).setConfig(all[vmOs])
  }
  const activateVm = (vmOs: VmOs, assistantId?: string): void => {
    const p = vmProfile(vmOs)
    store.updateSettings({ activeMachineId: p.machineId, ...(vmOs === 'linux' ? { computerEnabled: true } : {}) })
    const a = assistantId ? store.getAssistant(assistantId) : undefined
    if (a) store.updateAssistant(a.id, { computerMode: 'virtual', vmOs, ...(vmOs === 'linux' ? { computerEnabled: true, remoteMachineId: VM_MACHINE_ID } : {}) })
    applyDeps()
  }
  ipcMain.handle('vm:list', async () => {
    const list = await vms.refreshAll()
    store.vmsStatus = list
    const lin = list.find((x) => x.os === 'linux')
    if (lin) store.localVmStatus = lin
    v04.refreshViews()
    emit({ type: 'vms', list: list as any })
    return list
  })
  ipcMain.handle('vm:preflight', async (_e, osArg: unknown, assistantId?: string) => {
    const vmOs = vmOsArg(osArg)
    const r = await vms.preflight(vmOs, vmWorkDir(assistantId), app.getAppPath())
    finishVm(vmOs)
    return r
  })
  ipcMain.handle('vm:start', async (_e, osArg: unknown, assistantId?: string, opts?: { forceRebuild?: boolean; config?: Partial<VmUserConfig> }) => {
    const vmOs = vmOsArg(osArg)
    saveVmConfig(vmOs, opts?.config)
    const workDir = vmWorkDir(assistantId)
    if (vmOs === 'linux') {
      const s = await localVm.start({ workDir, appPath: app.getAppPath(), userDataPath: app.getPath('userData'), forceRebuild: !!opts?.forceRebuild })
      if (s.phase === 'ready') activateVm('linux', assistantId)
      return finishVm('linux')
    }
    const vm = vms.get(vmOs) as DockurVmManager
    const s = await vm.start({ workDir, forceRebuild: !!opts?.forceRebuild, config: store.settings.vmConfigs?.[vmOs] })
    if (s.containerRunning) activateVm(vmOs, assistantId)
    return finishVm(vmOs)
  })
  ipcMain.handle('vm:sleep', async (_e, osArg: unknown) => {
    const vmOs = vmOsArg(osArg)
    await vms.get(vmOs).sleep()
    releaseIfActive(vmOs)
    return finishVm(vmOs)
  })
  ipcMain.handle('vm:stop', async (_e, osArg: unknown) => {
    const vmOs = vmOsArg(osArg)
    await vms.get(vmOs).stop()
    releaseIfActive(vmOs)
    return finishVm(vmOs)
  })
  ipcMain.handle('vm:delete', async (_e, osArg: unknown, removeData?: boolean) => {
    const vmOs = vmOsArg(osArg)
    if (vmOs === 'linux') await localVm.destroy()
    else await (vms.get(vmOs) as DockurVmManager).destroy(!!removeData)
    releaseIfActive(vmOs)
    return finishVm(vmOs)
  })
  ipcMain.handle('vm:openInBrowser', async (_e, osArg: unknown) => {
    const vmOs = vmOsArg(osArg)
    const st = vms.get(vmOs).status()
    if (!st.containerRunning) return { ok: false, message: `${vmProfile(vmOs).title}未运行，请先启动。` }
    const url = st.desktopUrl || viewerUrl(vmOs, st.webPort || vmProfile(vmOs).webHostPortPreferred)
    await shell.openExternal(url)
    return { ok: true, url, message: '已在浏览器打开 ' + url }
  })
  ipcMain.handle('vm:saveConfig', (_e, osArg: unknown, cfg?: Partial<VmUserConfig>) => {
    saveVmConfig(vmOsArg(osArg), cfg)
    finishVm(vmOsArg(osArg))
    return st()
  })
  ipcMain.handle('vm:setActive', (_e, osArg: unknown, assistantId?: string) => {
    if (osArg === null || osArg === undefined || osArg === 'local') {
      store.updateSettings({ activeMachineId: 'local' })
      applyDeps()
    } else activateVm(vmOsArg(osArg), assistantId)
    v04.refreshViews()
    pushState()
    return st()
  })
  ipcMain.handle('vm:logs', async (_e, osArg: unknown) => {
    const vmOs = vmOsArg(osArg)
    if (vmOs === 'linux') {
      const r = await runCmd('docker', ['logs', '--tail', '80', vmProfile('linux').container], { timeout: 10000 })
      return (r.out + r.err).slice(-8000)
    }
    return (await (vms.get(vmOs) as DockurVmManager).logs(80)).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-8000)
  })
  store.vmsStatus = vms.statuses()
  for (const o of ['windows', 'macos'] as const) {
    vms.get(o).onChange(() => {
      store.vmsStatus = vms.statuses()
      emit({ type: 'vms', list: store.vmsStatus as any })
    })
  }

  ipcMain.handle('audio:transcribe', (_e, b64: string, mime: string) => transcribe(b64, mime))
}

/** 通过 playwright-core 自带 CLI 下载 Chromium（使用 Electron 内置的 Node 运行） */
function installChromium(): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let cli: string
    try {
      cli = require.resolve('playwright-core/cli.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    } catch (e) {
      return resolve({ ok: false, message: '找不到 playwright-core：' + errorText(e) })
    }
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out = (out + d).slice(-2000)))
    child.stderr.on('data', (d) => (out = (out + d).slice(-2000)))
    child.on('error', (e) => resolve({ ok: false, message: errorText(e) }))
    child.on('close', (code) => {
      void browser.close()
      resolve(code === 0 ? { ok: true, message: 'Chromium 安装完成' } : { ok: false, message: `安装失败（${code}）：${out.trim().slice(-400)}` })
    })
  })
}

const gotLock = process.env.ASSISTANT_SMOKE || E2E ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  crashGuard = new CrashGuard(app.getPath('userData'), {
    relaunch: (args) => {
      app.relaunch({ args })
      app.exit(1)
    },
    argv: process.argv.slice(1),
    enabled: !process.env.ASSISTANT_SMOKE
  })
  crashGuard.install()
  crashGuard.markStart()
  try {
    teeConsole(path.join(app.getPath('userData'), 'logs'))
    console.log(`[app] 启动 v${app.getVersion()} ${process.platform}/${process.arch} electron ${process.versions.electron}`)
  } catch {
    /* ignore */
  }

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.example.assistantdesktop')
    store = new Store(app.getPath('userData'), electronCodec)
    if (process.env.ASSISTANT_SMOKE_BASEURL) {
      store.updateSettings({ baseUrl: process.env.ASSISTANT_SMOKE_BASEURL, apiKey: 'smoke', model: 'mock-model', setupDone: true })
    }
    await applyProxy(store.settings.proxyMode, store.settings.proxyUrl).catch((e) => console.error('[proxy]', e))
    mcp = new McpManager((statuses) => {
      store.mcpStatus = statuses
      pushState()
    })
    browser = new BrowserManager(() => {
      const s = store.settings
      const profileDir = (s.browserProfileDir || '').trim() || path.join(app.getPath('userData'), 'browser-profiles')
      return {
        headless: s.browserHeadless,
        executablePath: s.browserExecutablePath,
        proxy: playwrightProxy(s.proxyMode, s.proxyUrl),
        persistentProfile: !!s.browserPersistentProfile,
        profileDir,
        cdpUrl: (s.browserCdpUrl || '').trim(),
        profilePerAssistant: s.browserProfilePerAssistant !== false
      }
    })
    v07 = createV07({
      store,
      emit,
      pushState,
      fetchImpl: netFetch,
      textMode: () => computerTextMode,
      getComputer: () => computer,
      baseDeps: () => (v04 ? v04.getComputerDeps() : { ...nativeComputerDeps })
    })
    computer = new ComputerController(v07.enhance({ ...nativeComputerDeps }))
    let host: DefaultToolHost
    const bootV04 = (): void => {
      v04 = createV04({
        userData: app.getPath('userData'),
        appPath: app.getAppPath(),
        store,
        codec: electronCodec,
        mcp,
        localComputerDeps: { ...nativeComputerDeps, textMode: () => computerTextMode },
        vncDeps: (os) => v07.vncDeps(os),
        emit,
        pushState,
        fetchImpl: netFetch,
        spawnTask: async (assistantId, title, prompt, o) => {
          const id = tasks.spawn(assistantId, title, prompt, o)
          const t = store.tasks.find((x) => x.id === id)
          if (!t) throw new Error('任务创建失败')
          return t
        }
      }) as V04
      v04.refreshViews()
    }
    host = new DefaultToolHost({
      store,
      fetchImpl: netFetch,
      browser,
      mcp,
      computer,
      onMemorySaved: pushState,
      onComputerLog: (entry) => {
        try {
          if (!entry.runId && (host as any).currentRunId) entry.runId = (host as any).currentRunId
        } catch {
          /* ignore */
        }
        store.addComputerLog(entry)
        emit({ type: 'computer-log', entry })
      },
      askUser: async (question, ctx, meta) => {
        const msgs = store.getMessages(ctx.assistantId)
        const callId = uid()
        const asstMsg: any = {
          id: uid(),
          role: 'assistant',
          content: '',
          askUser: { question },
          toolCalls: [
            {
              id: callId,
              name: 'ask_user',
              arguments: JSON.stringify({ question, placeholder: meta?.placeholder || '' }),
              status: 'awaiting_input'
            }
          ],
          createdAt: Date.now(),
          taskId: ctx.taskId
        }
        msgs.push(asstMsg)
        emit({ type: 'message-upsert', assistantId: ctx.assistantId, message: asstMsg })
        store.saveMessages(ctx.assistantId)
        const answer = await agent.waitAsk(callId, ctx.signal)
        asstMsg.askUser = { question, answer: answer || undefined }
        if (asstMsg.toolCalls?.[0]) {
          asstMsg.toolCalls[0].status = answer != null ? 'done' : 'cancelled'
          asstMsg.toolCalls[0].result = answer ?? '用户未回答'
        }
        emit({ type: 'message-upsert', assistantId: ctx.assistantId, message: asstMsg })
        store.saveMessages(ctx.assistantId)
        return answer
      },
      onBrowserTakeoverHint: (reason, ctx) => {
        void agent.takeover(ctx.assistantId, reason)
      },
      loadSkill: async (id) => {
        const { meta, body } = v04.skills.read(id)
        return `# 技能：${meta.name}\n\n${meta.description}\n\n${body}`
      },
      orchestrate: async (assistantId, goal, steps) => {
        const nodes = (steps || []).map((st: any, i: number) => ({
          title: st.title,
          prompt: st.prompt || st.title,
          dependsOn: (st.depends_on || []).map((idx: number) => `tmp-${idx}`),
          priority: st.priority ?? 10 - i,
          id: `tmp-${i}`
        }))
        // remap dependsOn to real ids after create — orchestrator.create regenerates ids if we pass partials with id
        const job = v04.orch.create(
          assistantId,
          goal,
          nodes.length
            ? nodes.map((n, i) => ({
                title: n.title,
                prompt: n.prompt,
                priority: n.priority,
                dependsOn: (steps?.[i]?.depends_on || []).map((idx: number) => nodes[idx]?.id).filter(Boolean)
              }))
            : undefined
        )
        return `已创建编排任务 ${job.id}，共 ${job.nodes.length} 步。可在「编排」面板查看进度。`
      },
      channelReply: async (channelId, chatKey, text) => {
        const c = store.settings.channels.find((x) => x.id === channelId)
        if (!c) throw new Error('通道不存在')
        const r = await v04.channels.send(c, chatKey, text, { trusted: store.settings.trustedMode })
        if (r.draftId) return `外发草稿 ${r.draftId}：${r.detail}（请在通道面板批准）`
        return r.detail || '已发送'
      }
    })
    // tasks/agent created below; boot v04 after tasks exists
    const screenLock = new ScreenLock((owner, queue) => {
      store.runtime.screenOwner = owner
      store.runtime.screenQueue = queue
      emitRuntime()
    })
    agent = new Agent({
      store,
      emit,
      tools: host,
      onComputerSession,
      screenLock,
      fetchImpl: netFetch,
      proxyLabel,
      experience: store.experience,
      captureComputerThumb: async () => {
        try {
          const shot = await computer.screenshot({ full: true })
          return shot.thumb || shot.images?.[0] || null
        } catch {
          return null
        }
      },
      onTakeover: (assistantId, active, reason) => {
        store.runtime.takeover = active ? { assistantId, reason, since: Date.now() } : null
        emitRuntime()
        // 更新悬浮条文案
        try {
          if (overlay && !overlay.isDestroyed()) {
            overlay.webContents.send('overlay:mode', { takeover: active, reason })
          }
        } catch {
          /* ignore */
        }
      },
      computerPreflight: async (model) => {
        const s = store.settings
        const key = capKey(s.baseUrl, model)
        let caps = s.capabilities[key]
        if (!caps) {
          const r = await runProbe(s.baseUrl, s.apiKey, model)
          caps = r.capabilities as ModelCapabilities
        }
        const engine = await ocrEngine()
        const d = decideComputerMode(caps, { vision: s.vision, mode: s.computerScreenMode }, engine !== 'none')
        computerTextMode = d.mode === 'text'
        console.log(`[computer] 模型 ${model} 屏幕感知方式：${d.mode ?? '不可用'}（OCR=${engine}）`)
        return d.mode ? null : d.reason!
      },
      visionFor: (model) => {
        const s = store.settings
        return s.vision && s.capabilities[capKey(s.baseUrl, model)]?.vision !== 'no' && s.computerScreenMode !== 'text'
      },
      skillsSummary: () => v04?.skills.promptSummary(store.settings.enabledSkills),
      computerTargetSummary: () => describeComputerTarget(),
      usage: v07.usage
    })
    tasks = new TaskManager({ store, agent, emit, onFinished: (t, name) => { onTaskFinished(t, name); v04?.orch.onTaskFinished(t) } })
    host.tasks = tasks
    bootV04()
    teach = new TeachRecorder(app.getPath('userData'), v04.skills)
    pushState()
    // 动态电脑 deps：切换机器时更新
    const applyMachineDeps = (): void => {
      try {
        computer.setDeps(v07.computerDeps())
      } catch (e) {
        console.error('[machine]', e)
      }
    }
    applyMachineDeps()
    void v04.syncConnectorsToMcp().catch((e: unknown) => console.error('[connectors]', e))
    v04.channels.on('message', (msg: any) => {
      const ch = store.settings.channels.find((c) => c.id === msg.channelId)
      const aid = ch?.assistantId || store.state.assistants[0]?.id
      if (!aid) return
      const text = `【来自通道 ${ch?.name || msg.channelId} / ${msg.chatKey}${msg.sender ? ' @' + msg.sender : ''}】\n${msg.text}`
      void agent.run(aid, { text }).catch((e) => console.error('[channel]', e))
    })
    scheduler = new Scheduler({ store, agent, onRoutineDone, onStateChanged: pushState })
    scheduler.sync()
    registerIpc()
    v07.registerIpc()
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromDataURL(APP_ICON_PNG))
    if (!process.env.ASSISTANT_SMOKE) createTray()
    const startHidden = process.argv.includes('--hidden') && !!tray
    createWindow(!startHidden)
    if (process.env.ASSISTANT_SMOKE && win) runSmokeTest(win, { store, scheduler })
    void mcp.sync(store.settings.mcpServers)
    updatePower()
    setInterval(updatePower, 3000).unref?.()

    app.on('activate', () => showWindow())
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    // 托盘模式下保持运行（定时任务继续）；否则在非 macOS 上退出
    if (tray && store?.settings.closeToTray) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    crashGuard?.markCleanExit()
    scheduler?.stopAll()
    void browser?.close()
    void mcp?.closeAll()
  })
}
