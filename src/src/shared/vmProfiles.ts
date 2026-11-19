/**
 * v0.6 多系统本地虚拟电脑：纯数据 + 纯函数（主进程 / 渲染进程 / 单测共用，不依赖 node API）。
 *
 * 上游镜像参数均来自官方 README（2026-10 核对）：
 *  - Windows: https://github.com/dockur/windows  镜像 dockurr/windows
 *    VERSION / RAM_SIZE / CPU_CORES / DISK_SIZE / LANGUAGE；Web 查看器 8006；RDP 3389；存储 /storage；共享目录 /shared
 *    需要 --device /dev/kvm --device /dev/net/tun --cap-add NET_ADMIN，--stop-timeout 120
 *  - macOS: https://github.com/dockur/macos  镜像 dockurr/macos
 *    VERSION(15/14/13/12/11) / RAM_SIZE / CPU_CORES / DISK_SIZE；Web 查看器 8006；VNC 5900；存储 /storage
 *    同样需要 KVM / tun / NET_ADMIN
 *  - Linux: 本应用自带 Ubuntu/XFCE + noVNC 镜像（localhost/assistant-desktop-vm:latest，容器 assistant-desktop-vm，6080/5900）
 */

export type VmOs = 'linux' | 'windows' | 'macos'
export const VM_OS_LIST: VmOs[] = ['linux', 'windows', 'macos']

export interface VmVersionOption {
  value: string
  label: string
}

export interface VmUserConfig {
  version: string
  ramGb: number
  cpuCores: number
  diskGb: number
  /** 仅 Windows：安装语言（上游 LANGUAGE），默认 Chinese */
  language?: string
}

export interface VmProfile {
  os: VmOs
  title: string
  short: string
  icon: string
  /** 机器 id（电脑控制目标） */
  machineId: string
  container: string
  /** 命名卷（Linux 使用绑定挂载的工作目录，不需要卷） */
  volume: string | null
  image: string
  /** 容器内 Web 查看器端口 */
  webInternalPort: number
  /** 首选宿主端口；被占用时自动顺延 */
  webHostPortPreferred: number
  webPortCandidates: number[]
  /** 额外端口（Linux VNC / Windows RDP） */
  extraInternalPort: number | null
  extraPortCandidates: number[]
  extraPortLabel: string
  needsKvm: boolean
  /** 预检磁盘硬要求（GB） */
  diskRequiredGb: number
  /** 资源说明（卡片展示） */
  requirement: string
  versions: VmVersionOption[]
  defaults: VmUserConfig
  licenseNote?: string
  /** 是否支持应用内键鼠自动控制 */
  agentControl: boolean
}

export const VM_PROFILES: Record<VmOs, VmProfile> = {
  linux: {
    os: 'linux',
    title: 'Linux 桌面',
    short: 'Ubuntu 24.04 + XFCE，中文字体、Firefox、工作目录挂载；智能体可直接键鼠控制。',
    icon: 'ubuntu-fill',
    machineId: 'vm-local',
    container: 'assistant-desktop-vm',
    volume: null,
    image: 'localhost/assistant-desktop-vm:latest',
    webInternalPort: 6080,
    webHostPortPreferred: 6080,
    webPortCandidates: [6080, 16080, 26080, 36080],
    extraInternalPort: 5900,
    extraPortCandidates: [5900, 15900, 25900, 35900],
    extraPortLabel: 'VNC',
    needsKvm: false,
    diskRequiredGb: 5,
    requirement: '约 2 GB 内存 · 磁盘 ≥5 GB · 无需 KVM',
    versions: [{ value: 'ubuntu-24.04-xfce', label: 'Ubuntu 24.04 · XFCE' }],
    defaults: { version: 'ubuntu-24.04-xfce', ramGb: 2, cpuCores: 2, diskGb: 10 },
    agentControl: true
  },
  windows: {
    os: 'windows',
    title: 'Windows 桌面',
    short: '开源 dockur/windows：首次启动自动下载并无人值守安装 Windows，浏览器内查看桌面。',
    icon: 'windows-fill',
    machineId: 'vm-windows',
    container: 'assistant-desktop-win',
    volume: 'assistant-desktop-win-storage',
    image: 'dockurr/windows',
    webInternalPort: 8006,
    webHostPortPreferred: 8006,
    webPortCandidates: [8006, 18006, 28006, 38006],
    extraInternalPort: 3389,
    // 宿主 Windows 自身常占用 3389，故 RDP 映射从 13389 起
    extraPortCandidates: [13389, 23389, 33389],
    extraPortLabel: 'RDP',
    needsKvm: true,
    diskRequiredGb: 70,
    requirement: '4 GB 内存 · 2 核 · 磁盘 ≥70 GB · 需要 KVM',
    versions: [
      { value: '11', label: 'Windows 11 专业版' },
      { value: '11l', label: 'Windows 11 LTSC' },
      { value: '11e', label: 'Windows 11 企业版' },
      { value: '10', label: 'Windows 10 专业版' },
      { value: '10l', label: 'Windows 10 LTSC' },
      { value: '10e', label: 'Windows 10 企业版' },
      { value: '2025', label: 'Windows Server 2025' },
      { value: '2022', label: 'Windows Server 2022' },
      { value: '2019', label: 'Windows Server 2019' },
      { value: 'tiny11', label: 'Tiny11（精简）' }
    ],
    defaults: { version: '11', ramGb: 4, cpuCores: 2, diskGb: 64, language: 'Chinese' },
    // v0.7：通过 QEMU 内置 VNC（Web 端口 /websockify）自动键鼠
    agentControl: true
  },
  macos: {
    os: 'macos',
    title: 'macOS 桌面',
    short: '开源 dockur/macos：自动下载恢复镜像，在浏览器内完成安装（需手动抹盘 + 重装一次）。',
    icon: 'apple-fill',
    machineId: 'vm-macos',
    container: 'assistant-desktop-mac',
    volume: 'assistant-desktop-mac-storage',
    image: 'dockurr/macos',
    webInternalPort: 8006,
    webHostPortPreferred: 8007,
    webPortCandidates: [8007, 18007, 28007, 38007],
    extraInternalPort: null,
    extraPortCandidates: [],
    extraPortLabel: '',
    needsKvm: true,
    diskRequiredGb: 70,
    requirement: '4 GB 内存 · 2 核 · 磁盘 ≥70 GB · 需要 KVM + AVX2',
    versions: [
      { value: '15', label: 'macOS 15 Sequoia' },
      { value: '14', label: 'macOS 14 Sonoma' },
      { value: '13', label: 'macOS 13 Ventura' },
      { value: '12', label: 'macOS 12 Monterey' },
      { value: '11', label: 'macOS 11 Big Sur' }
    ],
    defaults: { version: '15', ramGb: 4, cpuCores: 2, diskGb: 64 },
    licenseNote: 'Apple 许可协议仅允许在 Apple 硬件上运行 macOS，请自行判断是否使用。',
    agentControl: true
  }
}

export function vmProfile(os: VmOs): VmProfile {
  return VM_PROFILES[os] || VM_PROFILES.linux
}

export function isVmOs(v: unknown): v is VmOs {
  return v === 'linux' || v === 'windows' || v === 'macos'
}

export function vmOsFromMachineId(id: string | undefined | null): VmOs | null {
  if (!id) return null
  if (id === 'vm-local' || id === 'virtual') return 'linux'
  for (const os of VM_OS_LIST) if (VM_PROFILES[os].machineId === id) return os
  return null
}

const clampInt = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, v))
}

/** 合并用户配置与默认值，并做边界校验 */
export function normalizeVmConfig(os: VmOs, cfg?: Partial<VmUserConfig> | null): VmUserConfig {
  const p = vmProfile(os)
  const d = p.defaults
  const version = cfg?.version && p.versions.some((v) => v.value === cfg.version) ? cfg.version : d.version
  const out: VmUserConfig = {
    version,
    ramGb: clampInt(cfg?.ramGb, 2, 64, d.ramGb),
    cpuCores: clampInt(cfg?.cpuCores, 1, 32, d.cpuCores),
    diskGb: clampInt(cfg?.diskGb, os === 'linux' ? 5 : 32, 1024, d.diskGb)
  }
  if (os === 'windows') {
    const lang = String(cfg?.language ?? d.language ?? 'Chinese').trim()
    out.language = /^[A-Za-z][A-Za-z -]{1,30}$/.test(lang) ? lang : 'Chinese'
  }
  return out
}

export interface VmRunSpec {
  os: VmOs
  config: VmUserConfig
  webHostPort: number
  extraHostPort?: number | null
  /** 宿主工作目录（Linux → /workspace，Windows/macOS → /shared） */
  workDir: string
  /** 镜像覆盖（测试 / 私有镜像源） */
  image?: string
  /** Linux 桌面：宿主 uid/gid（Linux/macOS 宿主），让容器内 desk 用户可读写挂载目录而不改其属主 */
  hostUid?: number
  hostGid?: number
}

/**
 * 纯函数：构造 `docker run` 参数（不含 "docker" 本身）。
 * Linux 与 v0.5 完全一致（向后兼容）；Windows/macOS 遵循 dockur 上游 compose：
 *   devices /dev/kvm + /dev/net/tun、cap_add NET_ADMIN、/storage 卷、stop_grace_period 2m。
 * 所有端口仅绑定 127.0.0.1。
 */
export function buildDockerRunArgs(spec: VmRunSpec): string[] {
  const p = vmProfile(spec.os)
  const image = spec.image || p.image
  if (spec.os === 'linux') {
    const args = ['run', '-d', '--name', p.container, '-p', `127.0.0.1:${spec.webHostPort}:6080`]
    if (spec.extraHostPort) args.push('-p', `127.0.0.1:${spec.extraHostPort}:5900`)
    args.push(
      '-v',
      `${spec.workDir}:/workspace`,
      '-e',
      'LANG=zh_CN.UTF-8',
      '-e',
      'LC_ALL=zh_CN.UTF-8',
      '-e',
      'GEOMETRY=1280x800x24'
    )
    if (spec.hostUid !== undefined && spec.hostUid > 0) args.push('-e', `HOST_UID=${spec.hostUid}`)
    if (spec.hostGid !== undefined && spec.hostGid > 0) args.push('-e', `HOST_GID=${spec.hostGid}`)
    args.push(
      '--shm-size=1g',
      '--restart',
      'unless-stopped',
      image
    )
    return args
  }
  const c = spec.config
  const args = [
    'run',
    '-d',
    '--name',
    p.container,
    '--device',
    '/dev/kvm',
    '--device',
    '/dev/net/tun',
    '--cap-add',
    'NET_ADMIN',
    '-p',
    `127.0.0.1:${spec.webHostPort}:${p.webInternalPort}`
  ]
  if (spec.extraHostPort && p.extraInternalPort) {
    args.push('-p', `127.0.0.1:${spec.extraHostPort}:${p.extraInternalPort}/tcp`)
    args.push('-p', `127.0.0.1:${spec.extraHostPort}:${p.extraInternalPort}/udp`)
  }
  args.push('-v', `${p.volume}:/storage`)
  if (spec.workDir) args.push('-v', `${spec.workDir}:/shared`)
  args.push(
    '-e',
    `VERSION=${c.version}`,
    '-e',
    `RAM_SIZE=${c.ramGb}G`,
    '-e',
    `CPU_CORES=${c.cpuCores}`,
    '-e',
    `DISK_SIZE=${c.diskGb}G`
  )
  if (spec.os === 'windows' && c.language) args.push('-e', `LANGUAGE=${c.language}`)
  args.push('--stop-timeout', '120', '--restart', 'unless-stopped', image)
  return args
}

/** 查看器 URL（Linux 为 noVNC vnc.html；dockur 为根路径） */
export function viewerUrl(os: VmOs, port: number): string {
  if (os === 'linux') return `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=scale`
  return `http://127.0.0.1:${port}/`
}

/**
 * 端口分配：按候选顺序挑选第一个空闲且未被其它 VM 预留的端口；
 * 候选都不可用时从 base+1 顺延扫描（最多 200 个）。
 */
export async function allocatePort(
  candidates: number[],
  isFree: (port: number) => Promise<boolean> | boolean,
  reserved: Iterable<number> = []
): Promise<number> {
  const taken = new Set(reserved)
  for (const c of candidates) {
    if (taken.has(c)) continue
    if (await isFree(c)) return c
  }
  const base = candidates[candidates.length - 1] ?? 20000
  for (let p = base + 1; p < base + 200 && p < 65535; p++) {
    if (taken.has(p)) continue
    if (await isFree(p)) return p
  }
  throw new Error('未找到可用端口：' + candidates.join('/') + ' 均被占用')
}

/* ----------------------------- 预检（纯函数） ----------------------------- */

export type KvmState = 'ok' | 'missing' | 'no_permission' | 'unsupported_host' | 'unknown'

export interface KvmProbe {
  state: KvmState
  detail?: string
  /** Windows 宿主：系统 build 号（<22000 为 Windows 10） */
  windowsBuild?: number
}

export interface VmPreflightItem {
  id: string
  ok: boolean
  warn?: boolean
  label: string
  detail: string
  fix?: string[]
}

/** KVM 预检项：给出清晰中文原因 + 修复步骤（不出现晦涩错误） */
export function kvmPreflightItem(os: VmOs, hostPlatform: string, probe: KvmProbe): VmPreflightItem | null {
  const p = vmProfile(os)
  if (!p.needsKvm) return null
  const name = p.title.replace(' 桌面', '')
  const label = 'KVM 硬件虚拟化'
  if (probe.state === 'ok') {
    return { id: 'kvm', ok: true, label, detail: '已检测到 /dev/kvm，可加速运行 ' + name + (probe.detail ? '（' + probe.detail + '）' : '') }
  }
  if (probe.state === 'unknown' && hostPlatform !== 'darwin') {
    return {
      id: 'kvm',
      ok: true,
      warn: true,
      label,
      detail: `暂时无法确认 KVM 是否可用${probe.detail ? '（' + probe.detail + '）' : ''}；启动后若容器报告 KVM 不可用，会在此给出修复步骤。`
    }
  }
  if (hostPlatform === 'darwin') {
    return {
      id: 'kvm',
      ok: false,
      label,
      detail: `Mac 上的 Docker Desktop 不向容器提供 KVM，无法运行 ${name} 虚拟电脑（上游 dockur 明确不支持）。`,
      fix: ['请改用 Linux 桌面虚拟电脑；', `或在一台装有 Linux（支持 KVM）或 Windows 11 + WSL2 的电脑上运行 ${name} 虚拟电脑。`]
    }
  }
  if (hostPlatform === 'win32') {
    const win10 = probe.windowsBuild !== undefined && probe.windowsBuild > 0 && probe.windowsBuild < 22000
    const fix = [
      '1. 系统需为 Windows 11（Windows 10 的 Docker Desktop 不向容器提供 KVM）；',
      '2. 在 BIOS/UEFI 中开启 Intel VT-x / AMD-V（虚拟化技术）；',
      '3. 管理员 PowerShell 执行：wsl --update，然后 wsl --shutdown；',
      '4. 在 %UserProfile%\\.wslconfig 中写入：[wsl2] 换行 nestedVirtualization=true；',
      '5. Docker Desktop → Settings → General 勾选「Use the WSL 2 based engine」，然后重启 Docker Desktop；',
      '6. 验证：PowerShell 执行 docker run --rm --device /dev/kvm alpine ls -l /dev/kvm，能列出设备即可；',
      '7. 若本机本身是云主机/虚拟机，需云厂商开启「嵌套虚拟化」。'
    ]
    return {
      id: 'kvm',
      ok: false,
      label,
      detail: win10
        ? `检测到 Windows 10（build ${probe.windowsBuild}）：Docker Desktop 在 Windows 10 上无法向容器提供 KVM，${name} 虚拟电脑需要 Windows 11 + WSL2 嵌套虚拟化。`
        : `Docker 容器内无法访问 /dev/kvm：${name} 虚拟电脑需要 WSL2 嵌套虚拟化（KVM）。${probe.detail ? '（' + probe.detail + '）' : ''}`,
      fix
    }
  }
  // linux host
  if (probe.state === 'no_permission') {
    return {
      id: 'kvm',
      ok: false,
      label,
      detail: '/dev/kvm 存在，但当前用户无访问权限。',
      fix: ['执行：sudo usermod -aG kvm $USER，然后注销重新登录；', '验证：ls -l /dev/kvm，确认属组为 kvm 且可读写。']
    }
  }
  return {
    id: 'kvm',
    ok: false,
    label,
    detail: `未检测到 /dev/kvm：${name} 虚拟电脑需要硬件虚拟化（KVM）。${probe.detail ? '（' + probe.detail + '）' : ''}`,
    fix: [
      '1. 在 BIOS/UEFI 中开启 Intel VT-x / AMD-V；',
      '2. 加载内核模块：sudo modprobe kvm_intel 或 sudo modprobe kvm_amd；',
      '3. 验证：sudo apt install cpu-checker && sudo kvm-ok，应显示 KVM acceleration can be used；',
      '4. 若本机是云主机/虚拟机，需开启嵌套虚拟化；',
      '5. Linux 上请使用 Docker Engine（Docker Desktop for Linux 不向容器提供 KVM）。'
    ]
  }
}

/** 磁盘预检项（按系统不同要求） */
export function diskPreflightItem(os: VmOs, freeBytes: number | null | undefined): VmPreflightItem {
  const need = vmProfile(os).diskRequiredGb
  const label = '磁盘剩余空间'
  if (freeBytes === null || freeBytes === undefined || !Number.isFinite(freeBytes)) {
    return { id: 'disk', ok: true, warn: true, label, detail: `未能检测磁盘剩余空间（${vmProfile(os).title} 建议 ≥${need} GB，已跳过硬挡）` }
  }
  const gb = freeBytes / 1024 ** 3
  const txt = gb.toFixed(1) + ' GB'
  if (gb < need) {
    return {
      id: 'disk',
      ok: false,
      label,
      detail: `磁盘剩余约 ${txt}，${vmProfile(os).title} 需要至少 ${need} GB`,
      fix: ['清理磁盘或在 Docker Desktop → Settings → Resources 中把磁盘镜像移到更大的分区。']
    }
  }
  if (gb < need * 1.3) return { id: 'disk', ok: true, warn: true, label, detail: `磁盘剩余约 ${txt}（略低于推荐的 ${Math.ceil(need * 1.3)} GB）` }
  return { id: 'disk', ok: true, label, detail: `磁盘剩余约 ${txt}（需要 ≥${need} GB）` }
}

/** 端口预检项：首选端口被占用时说明自动改用的端口 */
export function portPreflightItem(os: VmOs, preferred: number, chosen: number | null, ownedByUs = false): VmPreflightItem {
  const label = `查看器端口 ${preferred}`
  if (ownedByUs) return { id: 'port', ok: true, label, detail: '已被本虚拟电脑容器使用' }
  if (chosen === null) return { id: 'port', ok: true, warn: true, label, detail: '未能检测端口占用（已跳过硬挡）' }
  if (chosen === preferred) return { id: 'port', ok: true, label, detail: '空闲可用' }
  return { id: 'port', ok: true, warn: true, label, detail: `端口 ${preferred} 已被占用，将自动改用 ${chosen}` }
}

export function summarizePreflight(os: VmOs, items: VmPreflightItem[]): { ok: boolean; summary: string } {
  const hardFail = items.some((i) => !i.ok)
  const lines = items.map((i) => {
    const head = `${i.ok ? (i.warn ? '⚠' : '✓') : '✗'} ${i.label}：${i.detail}`
    return i.fix && !i.ok ? head + '\n   ' + i.fix.join('\n   ') : head
  })
  const t = vmProfile(os).title
  return {
    ok: !hardFail,
    summary: (hardFail ? `【${t}】预检未通过，请先处理下列问题：\n` : `【${t}】预检通过：\n`) + lines.join('\n')
  }
}

/* --------------------------- dockur 日志进度解析 --------------------------- */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

export interface DockurProgress {
  stage: 'pulling' | 'downloading' | 'extracting' | 'installing' | 'booting' | 'ready' | 'error' | 'unknown'
  percent?: number
  line: string
  zh: string
}

/**
 * 解析 dockur 写给 Web 查看器的状态文件 /run/shm/msg.html（形如 "Downloading Windows 11... (37.5%)"）。
 * 与上游 web/js/script.js 的 parseProgress 规则一致。
 */
export function parseDockurMsgHtml(html: string): { text: string; percent?: number } | null {
  if (!html || !html.trim()) return null
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  const m = text.match(/\s*\((\d+(?:\.\d+)?)%\)\s*$/)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 0 && n <= 100) return { text: text.slice(0, m.index).trim(), percent: Math.floor(n) }
  }
  return { text }
}

/** 解析 dockur 容器日志的最后状态（info 行以「❯」开头；错误为「❯ ERROR: …」） */
export function parseDockurProgress(logs: string): DockurProgress {
  const lines = logs
    .replace(ANSI, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)
  let pct: number | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    const m = l.match(/(\d{1,3})%/)
    if (m && pct === undefined && !/^❯/.test(l)) {
      const n = parseInt(m[1], 10)
      if (n >= 0 && n <= 100) pct = n
    }
    const msg = l.replace(/^❯\s*/, '')
    if (!/^❯/.test(l)) continue
    if (/^ERROR:/i.test(msg)) {
      const kvm = /kvm/i.test(msg)
      return { stage: 'error', line: msg, zh: kvm ? '容器报告 KVM 不可用：' + msg.replace(/^ERROR:\s*/i, '') : '容器报错：' + msg.replace(/^ERROR:\s*/i, '') }
    }
    if (/started successfully/i.test(msg)) return { stage: 'ready', line: msg, zh: '系统已启动，可打开桌面' }
    if (/^Booting/i.test(msg)) return { stage: 'booting', line: msg, zh: '正在启动虚拟机…（首次会自动安装系统，可能需要 10–40 分钟）' }
    if (/^Downloading/i.test(msg)) return { stage: 'downloading', percent: pct, line: msg, zh: '正在下载系统镜像' + (pct !== undefined ? ` ${pct}%` : '…') }
    if (/^Extracting/i.test(msg)) return { stage: 'extracting', percent: pct, line: msg, zh: '正在解压系统镜像' + (pct !== undefined ? ` ${pct}%` : '…') }
    if (/^(Building|Adding drivers|Preparing|Detect)/i.test(msg)) return { stage: 'installing', line: msg, zh: '正在准备安装介质：' + msg }
    return { stage: 'unknown', line: msg, zh: msg }
  }
  return { stage: 'unknown', line: lines[lines.length - 1] || '', zh: lines.length ? lines[lines.length - 1].slice(0, 160) : '等待容器输出…' }
}
