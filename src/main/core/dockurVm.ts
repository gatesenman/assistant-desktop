/**
 * v0.6：基于开源 dockur 镜像的 Windows / macOS 桌面虚拟电脑。
 *  - Windows: dockurr/windows（https://github.com/dockur/windows）
 *  - macOS:   dockurr/macos  （https://github.com/dockur/macos）
 * 两者都在容器内用 QEMU+KVM 运行完整系统，Web 查看器在容器 8006 端口。
 * 需要 /dev/kvm：Linux 宿主直接提供；Windows 宿主需 Windows 11 + Docker Desktop(WSL2) + 嵌套虚拟化；
 * Mac 宿主的 Docker Desktop 不提供 KVM（上游明确不支持）。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  allocatePort,
  buildDockerRunArgs,
  diskPreflightItem,
  kvmPreflightItem,
  normalizeVmConfig,
  parseDockurMsgHtml,
  parseDockurProgress,
  portPreflightItem,
  summarizePreflight,
  viewerUrl,
  vmProfile,
  type KvmProbe,
  type VmOs,
  type VmPreflightItem,
  type VmUserConfig
} from '../../shared/vmProfiles'
import { checkDiskFree, isPortFree, localVm, parseHostPort, platformGuide, runCmd, type LocalVmPhase, type LocalVmStatus } from './localVm'

export type Runner = typeof runCmd

export interface DockurDeps {
  run: Runner
  detectDocker: () => Promise<{ installed: boolean; running: boolean; detail: string }>
  portFree: (port: number) => Promise<boolean>
  diskFreeBytes: (dir: string) => Promise<number | null>
  hostPlatform: string
  /** 可覆盖 KVM 探测（测试 / e2e 模拟） */
  probeKvm?: () => Promise<KvmProbe>
}

export interface DockurPreflight {
  os: VmOs
  ok: boolean
  summary: string
  items: VmPreflightItem[]
  webPort: number
  extraPort: number | null
}

/** Windows 宿主 build 号（os.release() 形如 10.0.22631） */
export function windowsBuildFromRelease(release: string): number | undefined {
  const m = /^\d+\.\d+\.(\d+)/.exec(release || '')
  return m ? parseInt(m[1], 10) : undefined
}

/** 根据 docker run --device /dev/kvm 探测的输出判断 KVM 状态（纯函数） */
export function classifyKvmProbeOutput(code: number, out: string): KvmProbe {
  const t = (out || '').toLowerCase()
  if (code === 0 && /kvm-ok/.test(t)) return { state: 'ok', detail: '容器内可访问 /dev/kvm' }
  if (/error gathering device information|no such file or directory|\/dev\/kvm.*not found|kvm-missing/.test(t)) {
    return { state: 'missing', detail: 'Docker 容器内不存在 /dev/kvm' }
  }
  if (/permission denied|operation not permitted/.test(t)) return { state: 'no_permission', detail: '容器内无权访问 /dev/kvm' }
  if (/unable to find image|pull access denied|timeout|tls handshake|i\/o timeout|connection refused|network/.test(t)) {
    return { state: 'unknown', detail: '探测容器无法拉取 alpine 镜像（网络问题），未能确认' }
  }
  return { state: 'unknown', detail: (out || '').trim().slice(-160) || '探测失败' }
}

async function defaultDiskFree(dir: string): Promise<number | null> {
  const r = await checkDiskFree(dir)
  return typeof r.freeBytes === 'number' ? r.freeBytes : null
}

export class DockurVmManager {
  readonly os: Exclude<VmOs, 'linux'>
  phase: LocalVmPhase = 'idle'
  message = '尚未创建'
  lastError?: string
  progress = ''
  percent?: number
  webPort: number
  extraPort: number | null
  config: VmUserConfig
  workDir: string | null = null
  lastDockerInstalled = false
  lastDockerRunning = false
  lastImageReady = false
  lastContainerExists = false
  lastPaused = false
  lastPreflight: DockurPreflight | null = null
  reservedPorts: () => number[] = () => []
  private deps: DockurDeps
  private listeners = new Set<(s: LocalVmStatus) => void>()
  private logTimer: ReturnType<typeof setInterval> | null = null

  constructor(osName: Exclude<VmOs, 'linux'>, deps?: Partial<DockurDeps>) {
    this.os = osName
    const p = vmProfile(osName)
    this.webPort = p.webHostPortPreferred
    this.extraPort = p.extraPortCandidates[0] ?? null
    this.config = normalizeVmConfig(osName, null)
    this.deps = {
      run: deps?.run || runCmd,
      detectDocker:
        deps?.detectDocker ||
        (() => localVm.detectDocker()),
      portFree: deps?.portFree || isPortFree,
      diskFreeBytes: deps?.diskFreeBytes || defaultDiskFree,
      hostPlatform: deps?.hostPlatform || process.platform,
      probeKvm: deps?.probeKvm
    }
  }

  get profile() {
    return vmProfile(this.os)
  }

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

  setConfig(cfg?: Partial<VmUserConfig> | null): void {
    this.config = normalizeVmConfig(this.os, { ...this.config, ...(cfg || {}) })
  }

  viewerUrl(): string {
    return viewerUrl(this.os, this.webPort)
  }

  usedPorts(): number[] {
    if (!this.lastContainerExists && this.phase === 'idle') return []
    return [this.webPort, ...(this.extraPort ? [this.extraPort] : [])]
  }

  status(): LocalVmStatus {
    const p = this.profile
    const running = this.phase === 'ready' || this.phase === 'installing'
    return {
      phase: this.phase,
      message: this.message,
      dockerInstalled: this.lastDockerInstalled,
      dockerRunning: this.lastDockerRunning,
      imageReady: this.lastImageReady,
      containerRunning: running,
      desktopUrl: running ? this.viewerUrl() : null,
      workDirMounted: this.workDir,
      platform: this.deps.hostPlatform,
      installGuide: platformGuide(),
      error: this.lastError,
      progress: this.progress || this.message,
      os: this.os,
      machineId: p.machineId,
      title: p.title,
      containerName: p.container,
      containerExists: this.lastContainerExists,
      paused: this.lastPaused,
      webPort: this.webPort,
      extraPort: this.extraPort,
      extraPortLabel: p.extraPortLabel,
      config: this.config,
      percent: this.percent,
      preflight: this.lastPreflight ? { ok: this.lastPreflight.ok, summary: this.lastPreflight.summary, items: this.lastPreflight.items } : null,
      licenseNote: p.licenseNote,
      agentControl: p.agentControl
    }
  }

  private async inspect(fmt: string): Promise<{ ok: boolean; out: string }> {
    const r = await this.deps.run('docker', ['inspect', '-f', fmt, this.profile.container], { timeout: 8000 })
    return { ok: r.code === 0, out: r.out.trim() }
  }

  async containerExists(): Promise<boolean> {
    const r = await this.inspect('{{.Id}}')
    return r.ok && r.out.length > 0
  }

  async containerState(): Promise<{ exists: boolean; running: boolean; paused: boolean }> {
    const r = await this.inspect('{{.State.Running}} {{.State.Paused}}')
    if (!r.ok) return { exists: false, running: false, paused: false }
    const [run, pause] = r.out.split(/\s+/)
    return { exists: true, running: run === 'true' && pause !== 'true', paused: pause === 'true' }
  }

  async imageExists(): Promise<boolean> {
    const r = await this.deps.run('docker', ['image', 'inspect', this.profile.image], { timeout: 10000 })
    return r.code === 0
  }

  async recoverPorts(): Promise<void> {
    const r = await this.inspect('{{json .HostConfig.PortBindings}}')
    if (!r.ok) return
    const web = parseHostPort(r.out, this.profile.webInternalPort)
    if (web) this.webPort = web
    if (this.profile.extraInternalPort) {
      const ex = parseHostPort(r.out, this.profile.extraInternalPort)
      if (ex) this.extraPort = ex
    }
  }

  async logs(tail = 80): Promise<string> {
    const r = await this.deps.run('docker', ['logs', '--tail', String(tail), this.profile.container], { timeout: 10000 })
    return (r.out || '') + (r.err || '')
  }

  /** KVM 探测：Mac 宿主不支持；Linux 宿主看 /dev/kvm；Docker 可用时再用临时容器验证 */
  async probeKvm(dockerRunning: boolean): Promise<KvmProbe> {
    if (this.deps.probeKvm) return this.deps.probeKvm()
    const host = this.deps.hostPlatform
    if (host === 'darwin') return { state: 'unsupported_host' }
    const windowsBuild = host === 'win32' ? windowsBuildFromRelease(os.release()) : undefined
    let hostProbe: KvmProbe | null = null
    if (host === 'linux') {
      if (!fs.existsSync('/dev/kvm')) hostProbe = { state: 'missing', detail: '宿主机不存在 /dev/kvm' }
      else {
        try {
          fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
          hostProbe = { state: 'ok', detail: '宿主机 /dev/kvm 可读写' }
        } catch {
          hostProbe = { state: 'no_permission', detail: '宿主机 /dev/kvm 无读写权限' }
        }
      }
    }
    if (!dockerRunning) {
      if (hostProbe) return hostProbe
      return { state: 'unknown', detail: 'Docker 未运行，暂无法检测容器内 KVM', windowsBuild }
    }
    const r = await this.deps.run(
      'docker',
      ['run', '--rm', '--device', '/dev/kvm', 'alpine:3', 'sh', '-c', 'test -c /dev/kvm && echo kvm-ok || echo kvm-missing'],
      { timeout: 90000 }
    )
    const probe = classifyKvmProbeOutput(r.code, r.out + '\n' + r.err)
    probe.windowsBuild = windowsBuild
    // Linux 宿主：探测容器拉取失败时以宿主检测为准
    if (probe.state === 'unknown' && hostProbe) return hostProbe
    return probe
  }

  async preflight(opts: { workDir: string }): Promise<DockurPreflight> {
    const items: VmPreflightItem[] = []
    const d = await this.deps.detectDocker()
    this.lastDockerInstalled = d.installed
    this.lastDockerRunning = d.running
    items.push({ id: 'docker', ok: !!(d.installed && d.running), label: 'Docker CLI 与引擎', detail: d.detail })

    // Windows 宿主的 Docker 数据通常在系统盘（WSL2 虚拟磁盘），按 home 所在盘检测
    const diskDir = this.deps.hostPlatform === 'win32' ? os.homedir() : opts.workDir || os.homedir()
    let free: number | null = null
    try {
      free = await this.deps.diskFreeBytes(diskDir)
    } catch {
      free = null
    }
    const diskItem = diskPreflightItem(this.os, free)
    // 已创建过磁盘卷的 VM 不再需要整块空间
    const state = d.running ? await this.containerState() : { exists: false, running: false, paused: false }
    this.lastContainerExists = state.exists
    if (!diskItem.ok && state.exists) {
      diskItem.ok = true
      diskItem.warn = true
      diskItem.detail += '（虚拟电脑已创建，仍可启动）'
    }
    items.push(diskItem)

    const kvm = kvmPreflightItem(this.os, this.deps.hostPlatform, await this.probeKvm(d.running))
    if (kvm) items.push(kvm)

    // 端口：首选被占用 → 自动顺延
    const p = this.profile
    let webPort = this.webPort
    let extraPort = this.extraPort
    if (state.exists) {
      await this.recoverPorts()
      webPort = this.webPort
      extraPort = this.extraPort
      items.push(portPreflightItem(this.os, p.webHostPortPreferred, webPort, true))
    } else {
      try {
        const reserved = this.reservedPorts()
        webPort = await allocatePort(p.webPortCandidates, (n) => this.deps.portFree(n), reserved)
        extraPort = p.extraPortCandidates.length
          ? await allocatePort(p.extraPortCandidates, (n) => this.deps.portFree(n), [...reserved, webPort])
          : null
        items.push(portPreflightItem(this.os, p.webHostPortPreferred, webPort))
      } catch {
        items.push(portPreflightItem(this.os, p.webHostPortPreferred, null))
      }
    }
    const sum = summarizePreflight(this.os, items)
    const res: DockurPreflight = { os: this.os, ok: sum.ok, summary: sum.summary, items, webPort, extraPort }
    this.lastPreflight = res
    return res
  }

  /** 拉取镜像（显示进度） */
  private async pull(force: boolean): Promise<void> {
    if (!force && (await this.imageExists())) {
      this.lastImageReady = true
      return
    }
    this.set('building', `正在下载 ${this.profile.image} 镜像…`)
    let buf = ''
    const r = await this.deps.run('docker', ['pull', this.profile.image], {
      timeout: 1_800_000,
      onChunk: (chunk) => {
        buf = (buf + chunk).slice(-3000)
        const last = buf.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).pop()
        if (last) {
          this.progress = '拉取镜像：' + last.slice(0, 140)
          this.set('building', this.progress)
        }
      }
    })
    if (r.code !== 0) {
      if (!force || !(await this.imageExists())) {
        throw new Error(`拉取 ${this.profile.image} 失败：${(r.err || r.out).slice(-300)}\n请检查网络（Docker Hub 可配置镜像加速）。`)
      }
    }
    this.lastImageReady = true
  }

  async start(opts: { workDir: string; forceRebuild?: boolean; config?: Partial<VmUserConfig> | null }): Promise<LocalVmStatus> {
    if (opts.config) this.setConfig(opts.config)
    try {
      this.set('checking', '正在预检环境…')
      this.percent = undefined
      this.progress = ''
      const pf = await this.preflight({ workDir: opts.workDir })
      if (!pf.ok) {
        const docker = pf.items.find((i) => i.id === 'docker')
        const kvm = pf.items.find((i) => i.id === 'kvm')
        const phase: LocalVmPhase = docker && !docker.ok ? 'need_docker' : kvm && !kvm.ok ? 'need_kvm' : 'error'
        this.set(phase, pf.summary, pf.summary)
        return this.status()
      }
      this.lastError = undefined
      const state = await this.containerState()
      const c = this.profile.container

      if (state.paused && !opts.forceRebuild) {
        this.set('starting', '正在从休眠中唤醒…')
        await this.deps.run('docker', ['unpause', c], { timeout: 30000 })
        this.lastPaused = false
        await this.recoverPorts()
        this.beginLogWatch()
        return this.status()
      }
      if (state.running && !opts.forceRebuild) {
        await this.recoverPorts()
        this.set('installing', '虚拟电脑运行中，正在读取状态…')
        this.beginLogWatch()
        return this.status()
      }
      if (state.exists && !opts.forceRebuild) {
        this.set('starting', '发现已停止的虚拟电脑，正在开机…')
        const r = await this.deps.run('docker', ['start', c], { timeout: 60000 })
        if (r.code === 0) {
          await this.recoverPorts()
          this.lastContainerExists = true
          this.beginLogWatch()
          return this.status()
        }
        this.set('starting', '开机失败，正在重新创建容器（磁盘数据保留）…')
      }

      await this.pull(!!opts.forceRebuild)
      this.set('starting', '正在创建虚拟电脑容器…')
      await this.deps.run('docker', ['rm', '-f', c], { timeout: 60000 })
      if (this.profile.volume) await this.deps.run('docker', ['volume', 'create', this.profile.volume], { timeout: 20000 })
      const work = opts.workDir ? path.resolve(opts.workDir) : ''
      if (work && !fs.existsSync(work)) fs.mkdirSync(work, { recursive: true })
      this.workDir = work || null
      this.webPort = pf.webPort
      this.extraPort = pf.extraPort
      const args = buildDockerRunArgs({ os: this.os, config: this.config, webHostPort: this.webPort, extraHostPort: this.extraPort, workDir: work })
      const r = await this.deps.run('docker', args, { timeout: 120000 })
      if (r.code !== 0) {
        const tail = (r.err || r.out).slice(-400)
        if (/kvm/i.test(tail)) {
          const item = kvmPreflightItem(this.os, this.deps.hostPlatform, { state: 'missing', detail: tail.trim().slice(-120) })
          const msg = summarizePreflight(this.os, item ? [item] : []).summary
          this.set('need_kvm', msg, msg)
          return this.status()
        }
        throw new Error('启动容器失败：' + tail)
      }
      this.lastContainerExists = true
      this.set('installing', this.os === 'windows' ? '容器已启动：首次会自动下载并安装 Windows，可打开桌面观看进度' : '容器已启动：首次会下载 macOS 恢复镜像，然后在桌面里完成安装')
      this.beginLogWatch()
      return this.status()
    } catch (e: any) {
      const msg = String(e?.message || e)
      this.set('error', msg, msg)
      return this.status()
    }
  }

  /** 读取一次容器日志并更新阶段（ready / installing / error） */
  async pollLogs(): Promise<void> {
    const st = await this.containerState()
    this.lastContainerExists = st.exists
    this.lastPaused = st.paused
    if (!st.exists) {
      this.stopLogWatch()
      if (this.phase === 'installing' || this.phase === 'ready') this.set('idle', '容器不存在')
      return
    }
    if (st.paused) {
      this.stopLogWatch()
      this.set('sleeping', '虚拟电脑已休眠（容器已暂停，内存状态保留）')
      return
    }
    if (!st.running) {
      this.stopLogWatch()
      const logs = await this.logs(40)
      const p = parseDockurProgress(logs)
      if (p.stage === 'error') {
        const kvm = /kvm/i.test(p.line)
        if (kvm) {
          const item = kvmPreflightItem(this.os, this.deps.hostPlatform, { state: 'missing', detail: p.line.slice(0, 160) })
          const msg = summarizePreflight(this.os, item ? [item] : []).summary
          this.set('need_kvm', msg, msg)
        } else this.set('error', p.zh, p.zh)
      } else this.set('stopped', '虚拟电脑已停止（磁盘数据保留）')
      return
    }
    const p = parseDockurProgress(await this.logs(60))
    this.percent = p.percent
    this.progress = p.zh
    if (p.stage !== 'ready' && p.stage !== 'error') {
      // 上游 Web 查看器的进度文件（带百分比）
      const r = await this.deps.run('docker', ['exec', this.profile.container, 'cat', '/run/shm/msg.html'], { timeout: 8000 })
      const m = r.code === 0 ? parseDockurMsgHtml(r.out) : null
      if (m) {
        if (m.percent !== undefined) this.percent = m.percent
        const zh = /^Downloading/i.test(m.text) ? '正在下载系统镜像' : /^Extracting/i.test(m.text) ? '正在解压系统镜像' : /^Building/i.test(m.text) ? '正在生成安装镜像' : ''
        this.progress = (zh ? zh + '：' : '') + m.text + (m.percent !== undefined ? ` ${m.percent}%` : '')
      }
    }
    if (p.stage === 'ready') this.set('ready', `${this.profile.title}已就绪`)
    else if (p.stage === 'error') {
      if (/kvm/i.test(p.line)) {
        const item = kvmPreflightItem(this.os, this.deps.hostPlatform, { state: 'missing', detail: p.line.slice(0, 160) })
        const msg = summarizePreflight(this.os, item ? [item] : []).summary
        this.set('need_kvm', msg, msg)
      } else this.set('error', p.zh, p.zh)
    } else this.set('installing', p.zh)
  }

  beginLogWatch(): void {
    this.stopLogWatch()
    void this.pollLogs().catch(() => {})
    this.logTimer = setInterval(() => {
      void this.pollLogs().catch(() => {})
    }, 5000)
    ;(this.logTimer as unknown as { unref?: () => void }).unref?.()
  }

  stopLogWatch(): void {
    if (this.logTimer) clearInterval(this.logTimer)
    this.logTimer = null
  }

  async refresh(): Promise<LocalVmStatus> {
    const d = await this.deps.detectDocker()
    this.lastDockerInstalled = d.installed
    this.lastDockerRunning = d.running
    if (!d.running) {
      if (!['need_kvm', 'error'].includes(this.phase)) {
        this.phase = 'idle'
        this.message = d.installed ? 'Docker 未运行' : '未检测到 Docker'
      }
      this.lastContainerExists = false
      return this.status()
    }
    const st = await this.containerState()
    this.lastContainerExists = st.exists
    this.lastPaused = st.paused
    this.lastImageReady = await this.imageExists()
    if (st.exists) await this.recoverPorts()
    if (st.paused) {
      this.phase = 'sleeping'
      this.message = '虚拟电脑已休眠（容器已暂停）'
    } else if (st.running) {
      if (this.phase !== 'ready' && this.phase !== 'installing') {
        this.phase = 'installing'
        this.message = '虚拟电脑运行中，正在读取状态…'
      }
      if (!this.logTimer) this.beginLogWatch()
    } else if (st.exists) {
      if (this.phase !== 'need_kvm' && this.phase !== 'error') {
        this.phase = 'stopped'
        this.message = '虚拟电脑已停止（磁盘数据保留）'
      }
    } else if (!['need_kvm', 'need_docker', 'error', 'checking', 'building', 'starting'].includes(this.phase)) {
      this.phase = 'idle'
      this.message = this.lastImageReady ? '镜像已就绪，可一键创建' : '尚未创建'
    }
    this.emit()
    return this.status()
  }

  async sleep(): Promise<LocalVmStatus> {
    const r = await this.deps.run('docker', ['pause', this.profile.container], { timeout: 30000 })
    this.stopLogWatch()
    if (r.code !== 0) {
      this.set(this.phase, '休眠失败：' + (r.err || r.out).slice(-200))
      return this.status()
    }
    this.lastPaused = true
    this.set('sleeping', '虚拟电脑已休眠（容器已暂停，内存状态保留；点「启动」唤醒）')
    return this.status()
  }

  async stop(): Promise<LocalVmStatus> {
    this.stopLogWatch()
    const c = this.profile.container
    this.set('stopped', '正在关机（向系统发送 ACPI 关机信号，最长约 2 分钟）…')
    if ((await this.containerState()).paused) await this.deps.run('docker', ['unpause', c], { timeout: 30000 })
    await this.deps.run('docker', ['stop', '-t', '120', c], { timeout: 180000 })
    this.lastPaused = false
    this.set('stopped', '虚拟电脑已停止（磁盘数据保留）')
    return this.status()
  }

  /** 删除容器；removeData=true 时同时删除系统磁盘卷（不可恢复） */
  async destroy(removeData = false): Promise<LocalVmStatus> {
    this.stopLogWatch()
    await this.deps.run('docker', ['rm', '-f', this.profile.container], { timeout: 60000 })
    if (removeData && this.profile.volume) await this.deps.run('docker', ['volume', 'rm', '-f', this.profile.volume], { timeout: 60000 })
    this.lastContainerExists = false
    this.lastPaused = false
    this.percent = undefined
    this.progress = ''
    this.lastError = undefined
    this.set('idle', removeData ? '已删除虚拟电脑及其磁盘数据' : '已删除虚拟电脑容器（磁盘卷保留，重新创建时可复用已安装的系统）')
    return this.status()
  }

  async diagnostic(): Promise<Record<string, unknown>> {
    const st = this.status()
    let logsTail = ''
    try {
      if (this.lastDockerRunning && this.lastContainerExists) logsTail = (await this.logs(20)).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-1500)
    } catch {
      /* ignore */
    }
    return {
      os: this.os,
      phase: st.phase,
      message: st.message,
      progress: st.progress,
      image: this.profile.image,
      container: this.profile.container,
      volume: this.profile.volume,
      containerExists: st.containerExists,
      paused: st.paused,
      webPort: st.webPort,
      extraPort: st.extraPort,
      config: st.config,
      preflight: this.lastPreflight ? { ok: this.lastPreflight.ok, items: this.lastPreflight.items.map((i) => ({ id: i.id, ok: i.ok, warn: i.warn, detail: i.detail })) } : null,
      logsTail
    }
  }
}
