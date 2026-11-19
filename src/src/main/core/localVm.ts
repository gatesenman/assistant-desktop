/**
 * 一键本地虚拟电脑（Docker）：检测 Docker → 构建/拉取镜像 → 启动容器 →
 * 中文环境 / 浏览器 / 工作目录挂载 / 键鼠控制（docker exec xdotool）。
 * 用户无需手敲 CLI；失败时返回清晰中文说明。
 */
import { atspiSnapshot } from './atspi'
import type { A11ySnapshot } from './som'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Capture, ComputerDeps, InputDriver } from './computer'
import { allocatePort, buildDockerRunArgs, diskPreflightItem, normalizeVmConfig, viewerUrl, VM_PROFILES, type VmOs, type VmPreflightItem, type VmUserConfig } from '../../shared/vmProfiles'


export const VM_CONTAINER = 'assistant-desktop-vm'
export const VM_IMAGE = 'localhost/assistant-desktop-vm:latest'
export const VM_MACHINE_ID = 'vm-local'
export const VM_NOVNC_PORT_DEFAULT = 6080
export const VM_VNC_PORT_DEFAULT = 5900

export type LocalVmPhase =
  | 'idle'
  | 'checking'
  | 'need_docker'
  | 'building'
  | 'starting'
  | 'configuring'
  | 'ready'
  | 'sleeping'
  | 'stopped'
  | 'need_kvm'
  | 'installing'
  | 'error'

export interface LocalVmStatus {
  phase: LocalVmPhase
  message: string
  dockerInstalled: boolean
  dockerRunning: boolean
  imageReady: boolean
  containerRunning: boolean
  desktopUrl: string | null
  workDirMounted: string | null
  platform: string
  installGuide: string
  error?: string
  progress?: string
  /** v0.6 多系统字段 */
  os?: VmOs
  machineId?: string
  title?: string
  containerName?: string
  containerExists?: boolean
  paused?: boolean
  webPort?: number
  extraPort?: number | null
  extraPortLabel?: string
  config?: VmUserConfig
  percent?: number
  preflight?: { ok: boolean; summary: string; items: VmPreflightItem[] } | null
  licenseNote?: string
  agentControl?: boolean
}

export interface LocalVmStartOpts {
  workDir: string
  /** 覆盖默认镜像目录（测试用） */
  dockerfileDir?: string
  /** Electron userData；构建上下文会复制到其下 local-vm-context */
  userDataPath?: string
  /** 强制重新构建镜像（忽略已有镜像） */
  forceRebuild?: boolean
}

/** Paths inside app.asar cannot be docker build contexts (Electron virtual FS). */
export function isAsarPath(p: string): boolean {
  return p.includes('.asar')
}

export const MISSING_DOCKERFILE_MSG = '安装包缺少虚拟电脑配方，请重装最新安装包。'

export function platformGuide(): string {
  const p = process.platform
  if (p === 'darwin') {
    return [
      '未检测到可用的 Docker。请安装 Docker Desktop（Mac）：',
      '1. 打开 https://www.docker.com/products/docker-desktop/ 下载并安装',
      '2. 启动 Docker Desktop，菜单栏鲸鱼图标变为「Running」',
      '3. 回到本应用，再点一次「一键启动虚拟电脑」',
      '（Apple Silicon / Intel 均支持官方安装包）'
    ].join('\n')
  }
  if (p === 'win32') {
    return [
      '未检测到可用的 Docker Desktop（Windows）。请按下列步骤安装并启动：',
      '1. 打开 https://www.docker.com/products/docker-desktop/ 下载 Docker Desktop',
      '2. 安装时勾选「Use WSL 2 instead of Hyper-V」；装完后重启电脑',
      '3. 从开始菜单启动 Docker Desktop，等待托盘鲸鱼图标变为 Running（引擎就绪）',
      '4. 确认「Settings → General」已勾选 Start Docker Desktop when you log in（可选）',
      '5. 打开 PowerShell 执行 docker version，应能看到 Client 与 Server 版本',
      '6. 若提示 docker 不是内部或外部命令：重装时勾选将 docker CLI 加入 PATH，或把 Docker\\resources\\bin 加到用户 PATH',
      '7. 回到本应用，再点「一键启动虚拟电脑」',
      '权限：当前用户需在 docker-users 组；WSL 2 需已启用（wsl --install）。',
      '本应用不会在缺少 docker 命令时尝试构建镜像。'
    ].join('\n')
  }
  return [
    '未检测到可用的 Docker。请在 Linux 安装 Docker Engine / Desktop：',
    '· Ubuntu/Debian：sudo apt update && sudo apt install -y docker.io && sudo usermod -aG docker $USER',
    '· 或安装 Docker Desktop：https://docs.docker.com/desktop/install/linux/',
    '装好后重新登录（或 newgrp docker），再点「一键启动虚拟电脑」。',
    '若 docker 命令存在但无法连接：多半是权限问题，请把用户加入 docker 组，勿用 root 长期跑桌面应用。'
  ].join('\n')
}

export async function runCmd(
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; onChunk?: (chunk: string, stream: 'out' | 'err') => void }
): Promise<{ code: number; out: string; err: string }> {
  return run(cmd, args, opts)
}

async function run(
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; onChunk?: (chunk: string, stream: 'out' | 'err') => void }
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, env: process.env, windowsHide: true })
    let out = ''
    let err = ''
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, out, err: err || '超时' })
    }, opts?.timeout ?? 600_000)
    child.stdout?.on('data', (d) => {
      const s = String(d)
      out = (out + s).slice(-80_000)
      opts?.onChunk?.(s, 'out')
    })
    child.stderr?.on('data', (d) => {
      const s = String(d)
      err = (err + s).slice(-80_000)
      opts?.onChunk?.(s, 'err')
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ code: 127, out, err: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code: code ?? 1, out, err })
    })
  })
}

/** Windows Docker Desktop.exe 常见安装路径（可单测） */
export function dockerDesktopCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const pf = env.ProgramFiles || 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA || ''
  const list = [
    path.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(pf86, 'Docker', 'Docker', 'Docker Desktop.exe')
  ]
  if (local) list.push(path.join(local, 'Docker', 'Docker', 'Docker Desktop.exe'))
  // 常见用户级安装变体
  if (env.USERPROFILE) {
    list.push(path.join(env.USERPROFILE, 'AppData', 'Local', 'Docker', 'Docker Desktop.exe'))
  }
  return list
}

export async function tryStartDockerDesktop(): Promise<{ ok: boolean; message: string; pathTried?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, message: '仅 Windows 支持一键启动 Docker Desktop；请在本机手动启动 Docker / dockerd。' }
  }
  const candidates = dockerDesktopCandidatePaths()
  let found: string | null = null
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        found = p
        break
      }
    } catch {
      /* ignore */
    }
  }
  if (!found) {
    return {
      ok: false,
      message: '未找到 Docker Desktop.exe。请先安装 Docker Desktop，或从开始菜单手动启动。',
      pathTried: candidates.join(' | ')
    }
  }
  try {
    const child = spawn(found, [], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { ok: true, message: '已尝试启动 Docker Desktop，正在等待引擎就绪…', pathTried: found }
  } catch (e: any) {
    return { ok: false, message: '启动 Docker Desktop 失败：' + String(e?.message || e), pathTried: found }
  }
}

/** 宿主端口是否空闲（检测失败时视为空闲，不硬挡） */
export async function isPortFree(port: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const r = await run('cmd', ['/c', `netstat -ano | findstr /R /C:":${port} .*LISTENING"`], { timeout: 5000 })
    return r.code !== 0
  }
  const r = await run('bash', ['-lc', `! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':${port} '`], { timeout: 3000 })
  return r.code === 0
}

/** 从 docker inspect 的 PortBindings JSON 中取出某容器端口映射到的宿主端口 */
export function parseHostPort(bindingsJson: string, containerPort: number): number | null {
  try {
    const b = JSON.parse(bindingsJson || '{}') as Record<string, { HostIp?: string; HostPort?: string }[] | null>
    for (const key of [`${containerPort}/tcp`, `${containerPort}/udp`, String(containerPort)]) {
      const arr = b?.[key]
      if (arr && arr.length) {
        const n = parseInt(arr[0].HostPort || '', 10)
        if (Number.isFinite(n) && n > 0) return n
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export interface PreflightItem {
  id: string
  ok: boolean
  warn?: boolean
  label: string
  detail: string
}

export interface PreflightResult {
  ok: boolean
  items: PreflightItem[]
  summary: string
}

function formatBytesGb(n: number): string {
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

/** 估算 workDir 所在盘剩余空间（失败时 warn，不硬挡） */
export async function checkDiskFree(workDir: string): Promise<{ ok: boolean; warn?: boolean; detail: string; freeBytes?: number }> {
  const target = workDir && fs.existsSync(workDir) ? workDir : path.parse(workDir || process.cwd()).root || process.cwd()
  try {
    const statfs = (fs as typeof fs & { promises: { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> } }).promises.statfs
    if (typeof statfs === 'function') {
      const s = await statfs(target)
      const free = Number(s.bavail) * Number(s.bsize)
      if (free < 2 * 1024 * 1024 * 1024) {
        return { ok: false, detail: `磁盘剩余约 ${formatBytesGb(free)}，建议至少保留 2 GB 再构建虚拟电脑镜像`, freeBytes: free }
      }
      if (free < 5 * 1024 * 1024 * 1024) {
        return { ok: true, warn: true, detail: `磁盘剩余约 ${formatBytesGb(free)}（偏低，构建镜像可能较慢或失败）`, freeBytes: free }
      }
      return { ok: true, detail: `磁盘剩余约 ${formatBytesGb(free)}`, freeBytes: free }
    }
  } catch {
    /* fall through */
  }
  if (process.platform === 'win32') {
    const drive = (path.parse(target).root || 'C:\\').replace(/\\$/, '')
    const ps = await run(
      'powershell',
      ['-NoProfile', '-Command', `(Get-PSDrive -Name '${drive[0]}').Free`],
      { timeout: 8000 }
    )
    const n = parseInt((ps.out || '').trim(), 10)
    if (ps.code === 0 && Number.isFinite(n)) {
      if (n < 2 * 1024 * 1024 * 1024) return { ok: false, detail: `磁盘剩余约 ${formatBytesGb(n)}，建议至少保留 2 GB`, freeBytes: n }
      if (n < 5 * 1024 * 1024 * 1024) return { ok: true, warn: true, detail: `磁盘剩余约 ${formatBytesGb(n)}（偏低）`, freeBytes: n }
      return { ok: true, detail: `磁盘剩余约 ${formatBytesGb(n)}`, freeBytes: n }
    }
    return { ok: true, warn: true, detail: '未能检测 Windows 磁盘剩余空间（已跳过硬挡）' }
  }
  const df = await run('df', ['-Pk', target], { timeout: 5000 })
  const lines = (df.out || '').trim().split('\n')
  if (df.code === 0 && lines.length >= 2) {
    const cols = lines[lines.length - 1].split(/\s+/)
    // df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted
    const availKb = parseInt(cols[3], 10)
    if (Number.isFinite(availKb)) {
      const free = availKb * 1024
      if (free < 2 * 1024 * 1024 * 1024) return { ok: false, detail: `磁盘剩余约 ${formatBytesGb(free)}，建议至少保留 2 GB`, freeBytes: free }
      if (free < 5 * 1024 * 1024 * 1024) return { ok: true, warn: true, detail: `磁盘剩余约 ${formatBytesGb(free)}（偏低）`, freeBytes: free }
      return { ok: true, detail: `磁盘剩余约 ${formatBytesGb(free)}`, freeBytes: free }
    }
  }
  return { ok: true, warn: true, detail: '未能检测磁盘剩余空间（已跳过硬挡）' }
}

export class LocalVmManager {
  readonly os: VmOs = 'linux'
  /** 由注册表注入：其它 VM 已占用的宿主端口，避免冲突 */
  reservedPorts: () => number[] = () => []
  phase: LocalVmPhase = 'idle'
  message = '尚未启动'
  lastError?: string
  workDirMounted: string | null = null
  novncPort = VM_NOVNC_PORT_DEFAULT
  vncPort = VM_VNC_PORT_DEFAULT
  /** 最近一次 detectDocker 结果，供 status()/诊断使用 */
  lastDockerInstalled = false
  lastDockerRunning = false
  lastDockerDetail = ''
  lastImageReady = false
  lastPreflight: PreflightResult | null = null
  buildProgress = ''
  private listeners = new Set<(s: LocalVmStatus) => void>()

  onChange(cb: (s: LocalVmStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    const s = this.status()
    for (const cb of this.listeners) cb(s)
  }

  private set(phase: LocalVmPhase, message: string, error?: string): void {
    this.phase = phase
    this.message = message
    if (error !== undefined) this.lastError = error
    this.emit()
  }

  installGuide(): string {
    return platformGuide()
  }

  async detectDocker(): Promise<{ installed: boolean; running: boolean; detail: string }> {
    const isWin = process.platform === 'win32'
    const which = await run(isWin ? 'where' : 'which', ['docker'], { timeout: 5000 })
    const version = await run('docker', ['version'], { timeout: 20000 })
    const cliOk = which.code === 0 || version.code === 0 || /Client:/i.test(version.out + version.err)

    if (isWin) {
      const proc = await run('tasklist', ['/FI', 'IMAGENAME eq Docker Desktop.exe'], { timeout: 10000 })
      const desktopProc = /Docker Desktop\.exe/i.test(proc.out)
      const wsl = await run('wsl', ['-l', '-v'], { timeout: 12000 })
      const wslOut = (wsl.out || '') + (wsl.err || '')
      // wsl -l output is often UTF-16; still look for ascii substrings when present
      const hasDockerWsl = /docker-desktop/i.test(wslOut) || /Docker/i.test(wslOut)

      if (!cliOk) {
        const bits: string[] = ['未检测到 docker 命令（CLI）。请先安装并启动 Docker Desktop。']
        if (!desktopProc) bits.push('当前也未发现「Docker Desktop.exe」进程。')
        else bits.push('已发现 Docker Desktop 进程，但 CLI 不在 PATH——请确认安装勾选了将 docker 加入 PATH，或重启应用后再试。')
        if (wsl.code !== 0) bits.push('WSL 似乎不可用：可在管理员 PowerShell 运行 wsl --install 后重启。')
        else if (!hasDockerWsl) bits.push('WSL 已安装，但未见 docker-desktop 发行版；请打开 Docker Desktop 完成引擎初始化。')
        bits.push('详见下方安装指引。在检测到 docker 之前不会尝试构建镜像。')
        return { installed: false, running: false, detail: bits.join(' ') }
      }

      const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 })
      if (info.code !== 0) {
        const msg = (info.err || info.out || version.err || '').toLowerCase()
        if (!desktopProc) {
          return {
            installed: true,
            running: false,
            detail: '已找到 docker CLI，但 Docker Desktop 未在运行。请从开始菜单启动 Docker Desktop，待托盘图标变为 Running 后再试。'
          }
        }
        if (msg.includes('permission') || msg.includes('access is denied') || msg.includes('docker-users')) {
          return {
            installed: true,
            running: false,
            detail: 'Docker 已安装，但当前用户无权限。请将用户加入 docker-users 组后注销再登录。'
          }
        }
        return {
          installed: true,
          running: false,
          detail: 'Docker Desktop 进程在，但引擎未就绪（docker info 失败）。请等待引擎启动完成，或检查 WSL 2 后端是否正常。'
        }
      }
      const ver = info.out.trim() || 'ok'
      return {
        installed: true,
        running: true,
        detail: 'Docker ' + ver + (desktopProc ? '（Desktop 运行中）' : '')
      }
    }

    if (!cliOk) return { installed: false, running: false, detail: '未找到 docker 命令' }
    const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 })
    if (info.code !== 0) {
      const msg = (info.err || info.out || '').toLowerCase()
      if (msg.includes('permission denied') || msg.includes('dial unix')) {
        return { installed: true, running: false, detail: 'Docker 已安装，但当前用户无权限访问。请将用户加入 docker 组后重新登录。' }
      }
      return { installed: true, running: false, detail: 'Docker 已安装但引擎未运行。请先启动 Docker Desktop / dockerd。' }
    }
    return { installed: true, running: true, detail: 'Docker ' + (info.out.trim() || 'ok') }
  }

  async imageExists(): Promise<boolean> {
    const r = await run('docker', ['image', 'inspect', VM_IMAGE], { timeout: 10000 })
    return r.code === 0
  }

  async containerRunning(): Promise<boolean> {
    const r = await run('docker', ['inspect', '-f', '{{.State.Running}}', VM_CONTAINER], { timeout: 8000 })
    return r.code === 0 && r.out.trim() === 'true'
  }

  /** 容器是否存在（含已停止） */
  async containerExists(): Promise<boolean> {
    const r = await run('docker', ['inspect', '-f', '{{.Id}}', VM_CONTAINER], { timeout: 8000 })
    return r.code === 0 && r.out.trim().length > 0
  }

  desktopUrl(): string {
    return `http://127.0.0.1:${this.novncPort}/vnc.html?autoconnect=1&resize=scale`
  }

  private async portFree(port: number): Promise<boolean> {
    return isPortFree(port)
  }

  /** 容器是否处于暂停（休眠）状态 */
  async containerPaused(): Promise<boolean> {
    const r = await run('docker', ['inspect', '-f', '{{.State.Paused}}', VM_CONTAINER], { timeout: 8000 })
    return r.code === 0 && r.out.trim() === 'true'
  }

  /** 从已有容器恢复端口映射（应用重启后仍能打开正确的桌面地址） */
  async recoverPorts(): Promise<void> {
    const r = await run('docker', ['inspect', '-f', '{{json .HostConfig.PortBindings}}', VM_CONTAINER], { timeout: 8000 })
    if (r.code !== 0) return
    const web = parseHostPort(r.out.trim(), 6080)
    const vnc = parseHostPort(r.out.trim(), 5900)
    if (web) this.novncPort = web
    if (vnc) this.vncPort = vnc
  }

  private async pickPorts(): Promise<void> {
    const p = VM_PROFILES.linux
    const reserved = this.reservedPorts()
    try {
      this.novncPort = await allocatePort(p.webPortCandidates, (n) => this.portFree(n), reserved)
    } catch {
      this.novncPort = VM_NOVNC_PORT_DEFAULT
    }
    try {
      this.vncPort = await allocatePort(p.extraPortCandidates, (n) => this.portFree(n), [...reserved, this.novncPort])
    } catch {
      this.vncPort = VM_VNC_PORT_DEFAULT
    }
  }

  /** 当前占用/预留的宿主端口（容器存在时） */
  usedPorts(): number[] {
    return this.phase === 'idle' && !this.lastContainerExists ? [] : [this.novncPort, this.vncPort]
  }

  lastContainerExists = false
  lastPaused = false

  status(): LocalVmStatus {
    return {
      phase: this.phase,
      message: this.message,
      dockerInstalled: this.lastDockerInstalled || (this.phase !== 'need_docker' && this.phase !== 'idle'),
      dockerRunning: this.lastDockerRunning || ['building', 'starting', 'configuring', 'ready', 'sleeping', 'checking'].includes(this.phase),
      imageReady: this.lastImageReady,
      containerRunning: this.phase === 'ready',
      desktopUrl: this.phase === 'ready' ? this.desktopUrl() : null,
      workDirMounted: this.workDirMounted,
      platform: process.platform,
      installGuide: platformGuide(),
      error: this.lastError,
      progress: this.buildProgress || this.message,
      os: 'linux',
      machineId: VM_MACHINE_ID,
      title: VM_PROFILES.linux.title,
      containerName: VM_CONTAINER,
      containerExists: this.lastContainerExists || this.phase === 'ready' || this.phase === 'sleeping',
      paused: this.lastPaused,
      webPort: this.novncPort,
      extraPort: this.vncPort,
      extraPortLabel: 'VNC',
      config: normalizeVmConfig('linux', null),
      preflight: this.lastPreflight ? { ok: this.lastPreflight.ok, summary: this.lastPreflight.summary, items: this.lastPreflight.items } : null,
      agentControl: true
    }
  }

  /** 异步刷新真实检测字段 */
  async refresh(): Promise<LocalVmStatus> {
    this.set('checking', '正在检测 Docker…')
    const d = await this.detectDocker()
    this.lastDockerInstalled = d.installed
    this.lastDockerRunning = d.running
    this.lastDockerDetail = d.detail
    if (!d.installed || !d.running) {
      this.set('need_docker', d.detail)
      const s = this.status()
      s.dockerInstalled = d.installed
      s.dockerRunning = d.running
      s.message = d.detail
      return s
    }
    const img = await this.imageExists()
    this.lastImageReady = img
    const exists = await this.containerExists()
    this.lastContainerExists = exists
    if (exists) await this.recoverPorts()
    const paused = exists ? await this.containerPaused() : false
    this.lastPaused = paused
    const runn = !paused && (await this.containerRunning())
    if (paused) {
      this.phase = 'sleeping'
      this.message = '虚拟电脑已休眠（容器已暂停，内存状态保留）'
    } else if (runn) {
      this.phase = 'ready'
      this.message = '虚拟电脑运行中'
    } else if (this.phase === 'ready' || this.phase === 'sleeping' || (exists && this.phase !== 'building' && this.phase !== 'starting' && this.phase !== 'configuring')) {
      this.phase = 'stopped'
      this.message = '虚拟电脑已停止（容器保留，可一键唤醒）'
    } else if (this.phase !== 'building' && this.phase !== 'starting' && this.phase !== 'configuring') {
      this.phase = img ? 'idle' : 'idle'
      this.message = img ? '镜像已就绪，可一键启动' : '可一键安装并启动虚拟电脑'
    }
    const s = this.status()
    s.dockerInstalled = true
    s.dockerRunning = true
    s.imageReady = img
    s.containerRunning = runn
    s.desktopUrl = runn ? this.desktopUrl() : null
    this.emit()
    return s
  }

  /**
   * Locate the real (non-asar) Dockerfile directory.
   * Prefer process.resourcesPath/local-vm (extraResources) first.
   * Never returns a path containing `.asar`.
   */
  resolveDockerfileDir(appPath: string, override?: string): string {
    if (override) {
      if (isAsarPath(override)) {
        throw new Error('虚拟电脑配方路径位于 asar 内，无法用于 docker build')
      }
      if (fs.existsSync(path.join(override, 'Dockerfile'))) return path.resolve(override)
    }
    const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const candidates = [
      // Packaged: extraResources → resources/local-vm (real folder next to app.asar)
      resPath ? path.join(resPath, 'local-vm') : '',
      // Dev / unpacked fallbacks (still skip asar below)
      path.join(appPath, '..', 'resources', 'local-vm'),
      path.join(appPath, 'resources', 'local-vm'),
      path.join(__dirname, '..', '..', '..', 'resources', 'local-vm'),
      path.join(process.cwd(), 'resources', 'local-vm')
    ].filter(Boolean) as string[]

    for (const c of candidates) {
      if (isAsarPath(c)) continue
      if (fs.existsSync(path.join(c, 'Dockerfile'))) return path.resolve(c)
    }
    throw new Error(MISSING_DOCKERFILE_MSG)
  }

  /** Real folder for docker build context (never asar). */
  resolveBuildContextRoot(userDataPath?: string): string {
    if (userDataPath && userDataPath.trim()) {
      return path.join(path.resolve(userDataPath), 'local-vm-context')
    }
    try {
      // Lazy require so unit tests without electron still work
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { app?: { getPath: (n: string) => string } }
      const ud = electron?.app?.getPath?.('userData')
      if (ud) return path.join(ud, 'local-vm-context')
    } catch {
      /* tests / non-electron */
    }
    return path.join(os.tmpdir(), 'assistant-desktop-local-vm-context')
  }

  /**
   * Copy Dockerfile dir to a real filesystem folder before docker build.
   * Always copies — even when source is already real — so Windows path
   * mangling / asar edge cases cannot reach the docker CLI.
   */
  prepareDockerBuildContext(sourceDir: string, userDataPath?: string): string {
    if (isAsarPath(sourceDir)) {
      throw new Error('拒绝将 asar 路径作为 docker 构建上下文：' + sourceDir)
    }
    if (!fs.existsSync(path.join(sourceDir, 'Dockerfile'))) {
      throw new Error(MISSING_DOCKERFILE_MSG)
    }
    const dest = this.resolveBuildContextRoot(userDataPath)
    fs.mkdirSync(dest, { recursive: true })
    // Fresh copy each time so recipe updates apply
    for (const name of fs.readdirSync(dest)) {
      fs.rmSync(path.join(dest, name), { recursive: true, force: true })
    }
    fs.cpSync(sourceDir, dest, { recursive: true })
    if (!fs.existsSync(path.join(dest, 'Dockerfile'))) {
      throw new Error(MISSING_DOCKERFILE_MSG)
    }
    if (isAsarPath(dest)) {
      throw new Error('构建上下文落到了 asar 路径，已中止')
    }
    return dest
  }

  /** 启动前预检：Docker / 磁盘 / 配方 / 端口（端口冲突仅 warn） */
  async preflight(opts: { workDir: string; appPath: string; dockerfileDir?: string }): Promise<PreflightResult> {
    const items: PreflightItem[] = []
    const d = await this.detectDocker()
    this.lastDockerInstalled = d.installed
    this.lastDockerRunning = d.running
    this.lastDockerDetail = d.detail
    items.push({
      id: 'docker',
      ok: !!(d.installed && d.running),
      label: 'Docker CLI 与引擎',
      detail: d.detail
    })

    const disk = await checkDiskFree(opts.workDir || process.cwd())
    if (typeof disk.freeBytes === 'number') {
      const it = diskPreflightItem('linux', disk.freeBytes)
      // 镜像已存在时只需少量空间：降级为警告
      if (!it.ok && d.running && (await this.imageExists())) {
        it.ok = true
        it.warn = true
        it.detail += '（镜像已存在，仍可启动）'
      }
      items.push({ id: it.id, ok: it.ok, warn: it.warn, label: it.label, detail: it.detail })
    } else {
      items.push({
        id: 'disk',
        ok: disk.ok,
        warn: disk.warn,
        label: '磁盘剩余空间',
        detail: disk.detail
      })
    }

    try {
      const dir = this.resolveDockerfileDir(opts.appPath, opts.dockerfileDir)
      if (isAsarPath(dir)) {
        items.push({ id: 'recipe', ok: false, label: '虚拟电脑配方目录', detail: '配方位于 asar 内，无法用于 docker build' })
      } else {
        items.push({ id: 'recipe', ok: true, label: '虚拟电脑配方目录', detail: dir })
      }
    } catch (e: any) {
      items.push({ id: 'recipe', ok: false, label: '虚拟电脑配方目录', detail: String(e?.message || e) })
    }

    // 端口 6080：尽量检测，失败或占用仅 warn
    try {
      const occupied = !(await this.portFree(VM_NOVNC_PORT_DEFAULT))
      if (occupied) {
        const ours = await this.containerRunning()
        if (ours) {
          items.push({ id: 'port6080', ok: true, label: '端口 6080', detail: '已被本虚拟电脑容器使用' })
        } else {
          items.push({
            id: 'port6080',
            ok: true,
            warn: true,
            label: '端口 6080',
            detail: '端口可能被其它进程占用；启动时将自动尝试备用端口'
          })
        }
      } else {
        items.push({ id: 'port6080', ok: true, label: '端口 6080', detail: '空闲可用' })
      }
    } catch {
      items.push({ id: 'port6080', ok: true, warn: true, label: '端口 6080', detail: '未能检测端口占用（已跳过硬挡）' })
    }

    const hardFail = items.some((i) => !i.ok)
    const lines = items.map((i) => `${i.ok ? (i.warn ? '⚠' : '✓') : '✗'} ${i.label}：${i.detail}`)
    const summary = hardFail
      ? '预检未通过，请先处理下列问题：\n' + lines.join('\n')
      : '预检通过：\n' + lines.join('\n')
    const result: PreflightResult = { ok: !hardFail, items, summary }
    this.lastPreflight = result
    return result
  }

  /** Windows：尝试启动 Docker Desktop 并轮询至引擎就绪或超时 */
  async tryStartDockerDesktopAndWait(timeoutMs = 90_000): Promise<LocalVmStatus> {
    this.set('checking', '正在启动 Docker Desktop…')
    const launched = await tryStartDockerDesktop()
    if (!launched.ok) {
      this.set('need_docker', launched.message)
      const s = this.status()
      s.dockerInstalled = this.lastDockerInstalled
      s.dockerRunning = false
      s.message = launched.message
      s.error = launched.message
      this.emit()
      return s
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      this.set('checking', `已启动 Docker Desktop，等待引擎就绪…（约 ${left}s）`)
      this.buildProgress = this.message
      const d = await this.detectDocker()
      this.lastDockerInstalled = d.installed
      this.lastDockerRunning = d.running
      this.lastDockerDetail = d.detail
      if (d.running) {
        this.set('idle', 'Docker Desktop 已就绪，可一键启动虚拟电脑')
        return await this.refresh()
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
    const msg = '已尝试启动 Docker Desktop，但引擎在约 90 秒内未就绪。请确认托盘鲸鱼图标变为 Running 后再试。'
    this.set('need_docker', msg)
    const s = this.status()
    s.dockerInstalled = true
    s.dockerRunning = false
    s.message = msg
    s.error = msg
    this.emit()
    return s
  }

  async ensureImage(
    appPath: string,
    dockerfileDir?: string,
    onProgress?: (line: string) => void,
    userDataPath?: string,
    force = false
  ): Promise<void> {
    if (!force && (await this.imageExists())) {
      this.lastImageReady = true
      return
    }
    const alt = await run('docker', ['image', 'inspect', 'localhost/agentos-desktop:latest'], { timeout: 5000 })
    if (alt.code === 0) {
      onProgress?.('发现本机已有桌面镜像，正在适配…')
    }
    const dir = this.resolveDockerfileDir(appPath, dockerfileDir)
    const contextDir = this.prepareDockerBuildContext(dir, userDataPath)
    this.set('building', force ? '正在强制重建虚拟电脑镜像…' : '正在构建虚拟电脑镜像（首次约需几分钟，请保持网络畅通）…')
    onProgress?.('docker build ' + VM_IMAGE + ' (context=' + contextDir + ')')
    let tailBuf = ''
    const r = await run('docker', ['build', '-t', VM_IMAGE, contextDir], {
      timeout: 900_000,
      onChunk: (chunk) => {
        tailBuf = (tailBuf + chunk).slice(-4000)
        const lines = tailBuf.split('\n').map((l) => l.trim()).filter(Boolean)
        const last = lines[lines.length - 1] || ''
        if (last) {
          const brief = last.slice(0, 160)
          this.buildProgress = brief
          this.set('building', '构建中：' + brief)
          onProgress?.(brief)
        }
      }
    })
    if (r.code !== 0) {
      const tail = (r.err || r.out || tailBuf).slice(-600)
      this.buildProgress = tail.slice(-200)
      throw new Error('构建虚拟电脑镜像失败。\n' + tail + '\n请确认 Docker 磁盘空间充足、网络可拉取 ubuntu:24.04。')
    }
    this.lastImageReady = true
    this.buildProgress = '镜像构建完成'
  }

  async start(opts: LocalVmStartOpts & { appPath: string }): Promise<LocalVmStatus> {
    try {
      this.set('checking', '正在预检环境…')
      const pf = await this.preflight({
        workDir: opts.workDir,
        appPath: opts.appPath,
        dockerfileDir: opts.dockerfileDir
      })
      if (!pf.ok) {
        const dockerItem = pf.items.find((i) => i.id === 'docker')
        const phase: LocalVmPhase = dockerItem && !dockerItem.ok ? 'need_docker' : 'error'
        this.set(phase, pf.summary, pf.summary)
        const s = this.status()
        s.dockerInstalled = this.lastDockerInstalled
        s.dockerRunning = this.lastDockerRunning
        s.error = pf.summary
        s.message = pf.summary
        s.installGuide = platformGuide()
        this.emit()
        return s
      }

      const d = await this.detectDocker()
      this.lastDockerInstalled = d.installed
      this.lastDockerRunning = d.running
      if (!d.installed || !d.running) {
        this.set('need_docker', d.detail)
        const s = this.status()
        s.dockerInstalled = d.installed
        s.dockerRunning = d.running
        s.error = d.detail
        s.installGuide = platformGuide()
        s.message = d.detail
        this.emit()
        return s
      }

      // 智能恢复：已有镜像则不强制 rebuild；仅 forceRebuild 或无镜像时构建
      await this.ensureImage(
        opts.appPath,
        opts.dockerfileDir,
        (line) => {
          this.buildProgress = line
          this.set('building', line)
        },
        opts.userDataPath,
        !!opts.forceRebuild
      )

      if (!opts.forceRebuild && (await this.containerPaused())) {
        this.set('starting', '正在从休眠中恢复虚拟电脑…')
        await run('docker', ['unpause', VM_CONTAINER], { timeout: 30000 })
        this.lastPaused = false
      }

      if (await this.containerRunning()) {
        await this.recoverPorts()
        this.workDirMounted = opts.workDir
        this.set('configuring', '虚拟电脑已在运行，正在对齐配置…')
        await this.postConfigure(opts.workDir)
        this.set('ready', '虚拟电脑已就绪（中文桌面 · 浏览器 · 工作目录已挂载 · 可控制）')
        return this.statusReady(opts.workDir)
      }

      // 容器存在但已停止 → docker start，避免每次重建
      if (!opts.forceRebuild && (await this.containerExists())) {
        this.set('starting', '发现已停止的虚拟电脑容器，正在唤醒…')
        const started = await run('docker', ['start', VM_CONTAINER], { timeout: 60000 })
        if (started.code === 0) {
          await this.recoverPorts()
          const work = path.resolve(opts.workDir || process.cwd())
          this.workDirMounted = work
          this.set('configuring', '正在完成唤醒后配置…')
          for (let i = 0; i < 40; i++) {
            if (await this.containerRunning()) {
              const probe = await run(
                'docker',
                ['exec', VM_CONTAINER, 'bash', '-lc', 'test -e /tmp/.X11-unix/X0 && echo ok'],
                { timeout: 5000 }
              )
              if (probe.out.includes('ok')) break
            }
            await new Promise((r) => setTimeout(r, 500))
          }
          await this.postConfigure(work)
          this.set('ready', '虚拟电脑已从休眠唤醒并就绪')
          return this.statusReady(work)
        }
        // start 失败则继续走重建容器路径
        this.set('starting', '唤醒失败，正在重新创建容器…')
      }

      this.set('starting', '正在启动虚拟电脑容器…')
      await this.pickPorts()
      await run('docker', ['rm', '-f', VM_CONTAINER], { timeout: 20000 })

      const work = path.resolve(opts.workDir || process.cwd())
      if (!fs.existsSync(work)) fs.mkdirSync(work, { recursive: true })
      this.workDirMounted = work

      const args = buildDockerRunArgs({
        os: 'linux',
        config: normalizeVmConfig('linux', null),
        webHostPort: this.novncPort,
        extraHostPort: this.vncPort,
        workDir: work,
        image: VM_IMAGE,
        hostUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
        hostGid: typeof process.getgid === 'function' ? process.getgid() : undefined
      })
      const r = await run('docker', args, { timeout: 120000 })
      if (r.code !== 0) {
        throw new Error('启动容器失败：' + (r.err || r.out).slice(-400))
      }

      this.set('configuring', '正在完成中文环境、浏览器与工作目录配置…')
      for (let i = 0; i < 40; i++) {
        const ok = await this.containerRunning()
        if (ok) {
          const probe = await run('docker', ['exec', VM_CONTAINER, 'bash', '-lc', 'test -e /tmp/.X11-unix/X0 && echo ok'], { timeout: 5000 })
          if (probe.out.includes('ok')) break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      await this.postConfigure(work)
      this.set('ready', '虚拟电脑已就绪：中文桌面、Firefox、工作目录挂载、电脑控制已指向此 VM')
      return this.statusReady(work)
    } catch (e: any) {
      const msg = String(e?.message || e)
      this.set('error', msg, msg)
      const s = this.status()
      s.error = msg
      return s
    }
  }

  /** 脱敏诊断摘要（供导出日志） */
  async diagnosticSummary(appPath?: string, workDir?: string): Promise<string> {
    let detect = { installed: this.lastDockerInstalled, running: this.lastDockerRunning, detail: this.lastDockerDetail }
    try {
      detect = await this.detectDocker()
      this.lastDockerInstalled = detect.installed
      this.lastDockerRunning = detect.running
      this.lastDockerDetail = detect.detail
    } catch (e: any) {
      detect = { installed: false, running: false, detail: String(e?.message || e) }
    }
    let pf = this.lastPreflight
    try {
      pf = await this.preflight({
        workDir: workDir || this.workDirMounted || process.cwd(),
        appPath: appPath || process.cwd()
      })
    } catch (e: any) {
      pf = {
        ok: false,
        items: [],
        summary: '预检失败：' + String(e?.message || e)
      }
    }
    const st = this.status()
    const payload = {
      localVm: {
        phase: st.phase,
        message: st.message,
        progress: st.progress,
        dockerInstalled: detect.installed,
        dockerRunning: detect.running,
        imageReady: this.lastImageReady || st.imageReady,
        containerRunning: st.containerRunning,
        desktopUrl: st.desktopUrl ? '(novnc localhost)' : null,
        workDirMounted: st.workDirMounted,
        platform: st.platform,
        novncPort: this.novncPort
      },
      detectDocker: detect,
      preflight: pf
        ? {
            ok: pf.ok,
            summary: pf.summary,
            items: pf.items.map((i) => ({ id: i.id, ok: i.ok, warn: i.warn, label: i.label, detail: i.detail }))
          }
        : null
    }
    return JSON.stringify(payload, null, 2)
  }

  private statusReady(workDir: string): LocalVmStatus {
    this.lastDockerInstalled = true
    this.lastDockerRunning = true
    this.lastImageReady = true
    this.phase = 'ready'
    const s = this.status()
    s.phase = 'ready'
    s.dockerInstalled = true
    s.dockerRunning = true
    s.imageReady = true
    s.containerRunning = true
    s.desktopUrl = this.desktopUrl()
    s.workDirMounted = workDir
    s.message = this.message
    this.emit()
    return s
  }

  /** 启动后自动配置：中文、快捷方式、确认挂载、预装探测 */
  private async postConfigure(workDir: string): Promise<void> {
    const script = [
      'export DISPLAY=:0 LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8',
      'mkdir -p /workspace /home/desk/Desktop',
      'ln -sfn /workspace /home/desk/Desktop/工作目录',
      'echo "工作目录: $(ls /workspace 2>/dev/null | head -5)" > /tmp/vm-ready.txt',
      'command -v firefox >/dev/null && echo firefox=ok >> /tmp/vm-ready.txt || echo firefox=missing >> /tmp/vm-ready.txt',
      'fc-list :lang=zh 2>/dev/null | head -1 >> /tmp/vm-ready.txt || true',
      'echo ready'
    ].join(' && ')
    await run('docker', ['exec', VM_CONTAINER, 'bash', '-lc', script], { timeout: 30000 })
    this.workDirMounted = workDir
  }

  /** 休眠 = docker pause（冻结进程，内存状态保留，唤醒秒级） */
  async sleep(): Promise<LocalVmStatus> {
    this.set('sleeping', '正在休眠虚拟电脑…')
    const r = await run('docker', ['pause', VM_CONTAINER], { timeout: 30000 })
    if (r.code !== 0) {
      // 未运行等情况退回为停止
      return this.stop()
    }
    this.lastPaused = true
    this.set('sleeping', '虚拟电脑已休眠（容器已暂停，内存状态保留；点「启动」即可唤醒）')
    const s = this.status()
    s.containerRunning = false
    s.desktopUrl = null
    return s
  }

  /** 停止 = docker stop（关机，容器与数据保留） */
  async stop(): Promise<LocalVmStatus> {
    this.set('stopped', '正在停止虚拟电脑…')
    if (await this.containerPaused()) await run('docker', ['unpause', VM_CONTAINER], { timeout: 30000 })
    await run('docker', ['stop', '-t', '5', VM_CONTAINER], { timeout: 60000 })
    this.lastPaused = false
    this.lastContainerExists = true
    this.set('stopped', '虚拟电脑已停止（容器已停止，数据与工作目录保留）')
    const s = this.status()
    s.containerRunning = false
    s.desktopUrl = null
    return s
  }

  async destroy(): Promise<LocalVmStatus> {
    await run('docker', ['rm', '-f', VM_CONTAINER], { timeout: 30000 })
    this.phase = 'idle'
    this.message = '已删除虚拟电脑容器（镜像保留；工作目录在宿主机上不受影响）'
    this.lastContainerExists = false
    this.lastPaused = false
    this.emit()
    return this.status()
  }

  viewerUrl(): string {
    return viewerUrl('linux', this.novncPort)
  }

  async exec(args: string[], timeout = 15000): Promise<string> {
    const r = await run('docker', ['exec', VM_CONTAINER, ...args], { timeout })
    if (r.code !== 0) throw new Error((r.err || r.out || 'docker exec 失败').slice(-300))
    return r.out
  }

  /** v0.7：以 desk 用户在容器内运行 python3 脚本（stdin 传入），用于读取 AT-SPI 控件树 */
  execPython(script: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        ['exec', '-i', '-u', 'desk', VM_CONTAINER, 'bash', '-c', '. /tmp/desk-session.env 2>/dev/null; exec python3 - "$@"', '_', ...args],
        { env: process.env, windowsHide: true }
      )
      let out = ''
      let err = ''
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, timeoutMs)
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', (e) => {
        clearTimeout(t)
        reject(new Error(e.message))
      })
      child.on('close', () => {
        clearTimeout(t)
        if (out.trim()) resolve(out)
        else reject(new Error((err.trim().split('\n').pop() || 'python3 没有输出').slice(0, 200)))
      })
      child.stdin.end(script)
    })
  }

  /** v0.7：虚拟电脑里的无障碍元素（AT-SPI）；旧镜像没有 pyatspi 时返回说明，自动退回 OCR */
  async elements(scope: 'foreground' | 'desktop'): Promise<A11ySnapshot> {
    return atspiSnapshot((sc, a, t) => this.execPython(sc, a, t), { width: 1280, height: 800 }, scope, { timeoutMs: 8000 })
  }

  /** 截图 → Capture（在容器内 scrot，再 docker cp） */
  async capture(): Promise<Capture> {
    if (!(await this.containerRunning())) throw new Error('虚拟电脑未运行，请先一键启动')
    const remote = '/tmp/ad-cap.jpg'
    await this.exec(['bash', '-lc', `export DISPLAY=:0; scrot -o ${remote} 2>/dev/null || import -window root ${remote}`], 20000)
    const local = path.join(require('os').tmpdir(), `ad-vm-cap-${Date.now()}.jpg`)
    const cp = await run('docker', ['cp', `${VM_CONTAINER}:${remote}`, local], { timeout: 15000 })
    if (cp.code !== 0) throw new Error('拉取虚拟电脑截图失败')
    const jpeg = fs.readFileSync(local)
    try {
      fs.unlinkSync(local)
    } catch {
      /* ignore */
    }
    // 缩略图：简单复用（Electron 侧可再压）；此处用同一缓冲
    const thumb = jpeg
    return { jpeg, thumb, width: 1280, height: 800 }
  }

  /** 以 desk 用户启动程序（与桌面同一 D-Bus 会话，控件树可读） */
  async openApp(name: string, args: string[]): Promise<string> {
    const cmd = `${name} ${args.map((a) => JSON.stringify(a)).join(' ')}`
    const b64 = Buffer.from(cmd, 'utf8').toString('base64')
    await this.exec(['su', '-s', '/bin/bash', 'desk', '-c', `. /tmp/desk-session.env 2>/dev/null; export DISPLAY=:0; cd /workspace 2>/dev/null; nohup bash -c "$(echo ${b64} | base64 -d)" >/tmp/app.log 2>&1 & echo started`])
    return `已在虚拟电脑启动 ${name}`
  }

  async openUrl(url: string): Promise<void> {
    await this.openApp('firefox', [url])
  }

  createComputerDeps(extras?: Partial<ComputerDeps>): ComputerDeps {
    const self = this
    const driver = async (): Promise<InputDriver> => ({
      size: async () => ({ width: 1280, height: 800 }),
      move: async (x, y) => {
        await self.exec(['bash', '-lc', `export DISPLAY=:0; xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)}`])
      },
      click: async (button, double) => {
        const map: Record<string, number> = { left: 1, middle: 2, right: 3 }
        const b = map[button] || 1
        const cmd = double ? `xdotool click --repeat 2 --delay 60 ${b}` : `xdotool click ${b}`
        await self.exec(['bash', '-lc', `export DISPLAY=:0; ${cmd}`])
      },
      drag: async (x, y, tx, ty) => {
        await self.exec([
          'bash',
          '-lc',
          `export DISPLAY=:0; xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} mousedown 1 mousemove --sync ${Math.round(tx)} ${Math.round(ty)} mouseup 1`
        ])
      },
      scroll: async (direction, amount) => {
        const n = Math.max(1, Math.min(20, amount || 5))
        const btn = direction === 'up' ? 4 : direction === 'down' ? 5 : direction === 'left' ? 6 : 7
        await self.exec(['bash', '-lc', `export DISPLAY=:0; for i in $(seq 1 ${n}); do xdotool click ${btn}; done`])
      },
      type: async (text) => {
        // 中文：clipboard + ctrl+v 更稳；无剪贴板工具时退回 type
        const b64 = Buffer.from(text, 'utf8').toString('base64')
        await self.exec([
          'bash',
          '-lc',
          `export DISPLAY=:0; echo '${b64}' | base64 -d | xclip -selection clipboard 2>/dev/null && xdotool key ctrl+v || xdotool type --delay 12 -- "$(echo '${b64}' | base64 -d)"`
        ])
      },
      keys: async (combo) => {
        const mapped = combo.map(xdotoolKeyName).join('+')
        await self.exec(['bash', '-lc', `export DISPLAY=:0; xdotool key ${mapped}`])
      },
      windows: async () => {
        const out = await self.exec(['bash', '-lc', 'export DISPLAY=:0; xdotool search --name "" getwindowname %@ 2>/dev/null | head -40'])
        return out.split('\n').map((s) => s.trim()).filter(Boolean)
      },
      focus: async (title) => {
        const out = await self.exec(['bash', '-lc', `export DISPLAY=:0; id=$(xdotool search --name "${title.replace(/"/g, '')}" | head -1); [ -n "$id" ] && xdotool windowactivate "$id" && echo ok`])
        return out.includes('ok')
      }
    })
    return {
      capture: () => self.capture(),
      driver,
      openApp: (name, args) => self.openApp(name, args),
      openUrl: (url) => self.openUrl(url),
      elements: (scope) => self.elements(scope),
      targetLabel: 'Linux 桌面虚拟电脑',
      guestOs: 'linux',
      settleMs: 400,
      ...extras
    }
  }
}

export const localVm = new LocalVmManager()

/** 通用按键名 → xdotool / X keysym 名（X keysym 区分大小写：Return、Escape、Page_Up…） */
const XDO_KEYS: Record<string, string> = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End', pageup: 'Page_Up', page_up: 'Page_Up', pagedown: 'Page_Down', page_down: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'space', capslock: 'Caps_Lock', printscreen: 'Print', print: 'Print', menu: 'Menu',
  ctrl: 'ctrl', control: 'ctrl', leftctrl: 'ctrl', rightctrl: 'ctrl', alt: 'alt', leftalt: 'alt', option: 'alt', shift: 'shift', leftshift: 'shift',
  win: 'super', windows: 'super', super: 'super', cmd: 'super', command: 'super', meta: 'super'
}
export function xdotoolKeyName(k: string): string {
  const key = k.trim()
  const low = key.toLowerCase().replace(/\s+/g, '')
  if (XDO_KEYS[low]) return XDO_KEYS[low]
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(low)) return low.toUpperCase()
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase()
  // 其它（如 plus、minus、XF86 键）原样传给 xdotool
  return key.replace(/[^A-Za-z0-9_+\-]/g, '')
}
