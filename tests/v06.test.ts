import { describe, expect, it } from 'vitest'
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
  vmOsFromMachineId,
  VM_PROFILES
} from '../src/shared/vmProfiles'
import { classifyKvmProbeOutput, DockurVmManager, windowsBuildFromRelease, type Runner } from '../src/main/core/dockurVm'
import { parseHostPort, LocalVmManager } from '../src/main/core/localVm'
import { VmRegistry } from '../src/main/core/vms'

const GB = 1024 ** 3

describe('buildDockerRunArgs', () => {
  it('Linux 与 v0.5 参数完全一致（向后兼容）', () => {
    const args = buildDockerRunArgs({ os: 'linux', config: normalizeVmConfig('linux', null), webHostPort: 6080, extraHostPort: 5900, workDir: '/home/u/work', image: 'localhost/assistant-desktop-vm:latest' })
    expect(args).toEqual([
      'run', '-d', '--name', 'assistant-desktop-vm',
      '-p', '127.0.0.1:6080:6080',
      '-p', '127.0.0.1:5900:5900',
      '-v', '/home/u/work:/workspace',
      '-e', 'LANG=zh_CN.UTF-8', '-e', 'LC_ALL=zh_CN.UTF-8', '-e', 'GEOMETRY=1280x800x24',
      '--shm-size=1g', '--restart', 'unless-stopped',
      'localhost/assistant-desktop-vm:latest'
    ])
  })

  it('Linux：传入宿主 uid/gid 时附加 HOST_UID/HOST_GID（不递归 chown 工作目录）', () => {
    const args = buildDockerRunArgs({ os: 'linux', config: normalizeVmConfig('linux', null), webHostPort: 16080, extraHostPort: 15900, workDir: '/w', hostUid: 1000, hostGid: 1000 })
    expect(args.join(' ')).toContain('-e HOST_UID=1000 -e HOST_GID=1000')
    expect(args.join(' ')).toContain('-p 127.0.0.1:16080:6080')
    const root = buildDockerRunArgs({ os: 'linux', config: normalizeVmConfig('linux', null), webHostPort: 6080, workDir: '/w', hostUid: 0 })
    expect(root.join(' ')).not.toContain('HOST_UID')
  })

  it('Windows：按上游 compose 传 KVM / tun / NET_ADMIN、8006、/storage 卷与资源变量', () => {
    const args = buildDockerRunArgs({ os: 'windows', config: normalizeVmConfig('windows', null), webHostPort: 8006, extraHostPort: 13389, workDir: 'C:\\Users\\u\\work' })
    const s = args.join(' ')
    expect(args[0]).toBe('run')
    expect(s).toContain('--name assistant-desktop-win')
    expect(s).toContain('--device /dev/kvm')
    expect(s).toContain('--device /dev/net/tun')
    expect(s).toContain('--cap-add NET_ADMIN')
    expect(s).toContain('-p 127.0.0.1:8006:8006')
    expect(s).toContain('-p 127.0.0.1:13389:3389/tcp')
    expect(s).toContain('-p 127.0.0.1:13389:3389/udp')
    expect(s).toContain('-v assistant-desktop-win-storage:/storage')
    expect(s).toContain('-v C:\\Users\\u\\work:/shared')
    expect(s).toContain('-e VERSION=11')
    expect(s).toContain('-e RAM_SIZE=4G')
    expect(s).toContain('-e CPU_CORES=2')
    expect(s).toContain('-e DISK_SIZE=64G')
    expect(s).toContain('-e LANGUAGE=Chinese')
    expect(s).toContain('--stop-timeout 120')
    expect(args[args.length - 1]).toBe('dockurr/windows')
  })

  it('macOS：宿主 8007 → 容器 8006，VERSION 可选，无 RDP / LANGUAGE', () => {
    const args = buildDockerRunArgs({ os: 'macos', config: normalizeVmConfig('macos', { version: '14', ramGb: 8, cpuCores: 4, diskGb: 128 }), webHostPort: 8007, workDir: '' })
    const s = args.join(' ')
    expect(s).toContain('--name assistant-desktop-mac')
    expect(s).toContain('-p 127.0.0.1:8007:8006')
    expect(s).not.toContain('3389')
    expect(s).not.toContain('LANGUAGE')
    expect(s).not.toContain(':/shared')
    expect(s).toContain('-e VERSION=14')
    expect(s).toContain('-e RAM_SIZE=8G')
    expect(s).toContain('-e CPU_CORES=4')
    expect(s).toContain('-e DISK_SIZE=128G')
    expect(s).toContain('--device /dev/kvm')
    expect(s).toContain('-v assistant-desktop-mac-storage:/storage')
    expect(args[args.length - 1]).toBe('dockurr/macos')
  })

  it('所有端口仅绑定 127.0.0.1', () => {
    for (const os of ['linux', 'windows', 'macos'] as const) {
      const args = buildDockerRunArgs({ os, config: normalizeVmConfig(os, null), webHostPort: 9000, extraHostPort: 9001, workDir: '/w' })
      const ps = args.filter((_, i) => args[i - 1] === '-p')
      expect(ps.length).toBeGreaterThan(0)
      for (const p of ps) expect(p.startsWith('127.0.0.1:')).toBe(true)
    }
  })

  it('三个系统容器名 / 卷 / 首选端口互不相同', () => {
    const names = new Set(Object.values(VM_PROFILES).map((p) => p.container))
    const ports = new Set(Object.values(VM_PROFILES).map((p) => p.webHostPortPreferred))
    const mids = new Set(Object.values(VM_PROFILES).map((p) => p.machineId))
    expect(names.size).toBe(3)
    expect(ports.size).toBe(3)
    expect(mids.size).toBe(3)
    expect(VM_PROFILES.windows.volume).not.toBe(VM_PROFILES.macos.volume)
  })
})

describe('normalizeVmConfig', () => {
  it('默认值：Windows 4G / 2 核 / 64G / 11 / Chinese', () => {
    expect(normalizeVmConfig('windows', null)).toEqual({ version: '11', ramGb: 4, cpuCores: 2, diskGb: 64, language: 'Chinese' })
    expect(normalizeVmConfig('macos', undefined).version).toBe('15')
  })
  it('非法值回退 / 边界裁剪 / 防注入', () => {
    const c = normalizeVmConfig('windows', { version: '99', ramGb: 999, cpuCores: 0, diskGb: 1, language: 'x; rm -rf /' })
    expect(c.version).toBe('11')
    expect(c.ramGb).toBe(64)
    expect(c.cpuCores).toBe(1)
    expect(c.diskGb).toBe(32)
    expect(c.language).toBe('Chinese')
    expect(normalizeVmConfig('macos', { version: '13' }).version).toBe('13')
  })
})

describe('allocatePort', () => {
  it('首选端口空闲直接使用', async () => {
    expect(await allocatePort([8006, 18006], () => true)).toBe(8006)
  })
  it('首选被占用 → 下一个候选', async () => {
    expect(await allocatePort([8006, 18006], (p) => p !== 8006)).toBe(18006)
  })
  it('跳过其它 VM 预留的端口', async () => {
    expect(await allocatePort([6080, 16080], () => true, [6080])).toBe(16080)
  })
  it('候选都被占用 → 顺延扫描', async () => {
    expect(await allocatePort([8006, 18006], (p) => p > 18010)).toBe(18011)
  })
  it('全部不可用时抛出中文错误', async () => {
    await expect(allocatePort([8006], () => false)).rejects.toThrow(/未找到可用端口/)
  })
})

describe('预检文案（按系统 / 宿主）', () => {
  it('Linux 桌面不需要 KVM', () => {
    expect(kvmPreflightItem('linux', 'win32', { state: 'missing' })).toBeNull()
  })
  it('Windows 宿主 + Windows 10：明确说明需要 Windows 11 + WSL2', () => {
    const it = kvmPreflightItem('windows', 'win32', { state: 'missing', windowsBuild: 19045 })!
    expect(it.ok).toBe(false)
    expect(it.detail).toMatch(/Windows 10/)
    expect(it.detail).toMatch(/Windows 11/)
    expect(it.fix!.join('\n')).toMatch(/nestedVirtualization=true/)
  })
  it('Windows 宿主 + Windows 11 缺 KVM：给出 WSL2 嵌套虚拟化修复步骤', () => {
    const it = kvmPreflightItem('macos', 'win32', { state: 'missing', windowsBuild: 22631 })!
    expect(it.ok).toBe(false)
    expect(it.detail).toMatch(/WSL2 嵌套虚拟化/)
    expect(it.detail).toMatch(/macOS/)
    const fix = it.fix!.join('\n')
    expect(fix).toMatch(/BIOS/)
    expect(fix).toMatch(/wsl --update/)
    expect(fix).toMatch(/\.wslconfig/)
    expect(fix).toMatch(/docker run --rm --device \/dev\/kvm/)
  })
  it('Mac 宿主：说明 Docker Desktop 不提供 KVM', () => {
    const it = kvmPreflightItem('windows', 'darwin', { state: 'unsupported_host' })!
    expect(it.ok).toBe(false)
    expect(it.detail).toMatch(/不向容器提供 KVM/)
  })
  it('Linux 宿主：无权限 → usermod；缺失 → modprobe / kvm-ok', () => {
    expect(kvmPreflightItem('windows', 'linux', { state: 'no_permission' })!.fix!.join('')).toMatch(/usermod -aG kvm/)
    const m = kvmPreflightItem('macos', 'linux', { state: 'missing' })!
    expect(m.fix!.join('')).toMatch(/modprobe/)
    expect(m.fix!.join('')).toMatch(/kvm-ok/)
  })
  it('KVM 正常 / 未知', () => {
    expect(kvmPreflightItem('windows', 'linux', { state: 'ok' })!.ok).toBe(true)
    const u = kvmPreflightItem('windows', 'win32', { state: 'unknown', detail: 'Docker 未运行' })!
    expect(u.ok).toBe(true)
    expect(u.warn).toBe(true)
  })
  it('磁盘要求：Linux 5G / Windows 70G / macOS 70G', () => {
    expect(diskPreflightItem('linux', 40 * GB).ok).toBe(true)
    expect(diskPreflightItem('windows', 40 * GB).ok).toBe(false)
    expect(diskPreflightItem('windows', 40 * GB).detail).toMatch(/70 GB/)
    expect(diskPreflightItem('macos', 200 * GB).ok).toBe(true)
    expect(diskPreflightItem('linux', 3 * GB).ok).toBe(false)
    expect(diskPreflightItem('windows', null).warn).toBe(true)
  })
  it('端口冲突 → 自动改用并提示', () => {
    const it = portPreflightItem('windows', 8006, 18006)
    expect(it.ok).toBe(true)
    expect(it.warn).toBe(true)
    expect(it.detail).toMatch(/自动改用 18006/)
    expect(portPreflightItem('macos', 8007, 8007).detail).toBe('空闲可用')
  })
  it('summarizePreflight 带系统名与修复步骤', () => {
    const s = summarizePreflight('windows', [
      { id: 'docker', ok: true, label: 'Docker', detail: 'ok' },
      kvmPreflightItem('windows', 'linux', { state: 'missing' })!
    ])
    expect(s.ok).toBe(false)
    expect(s.summary).toMatch(/【Windows 桌面】预检未通过/)
    expect(s.summary).toMatch(/modprobe/)
  })
})

describe('dockur 日志 / KVM 探测解析', () => {
  it('下载进度百分比', () => {
    const p = parseDockurProgress('\x1b[1;34m❯ \x1b[1;36mDownloading Windows 11 Pro...\x1b[0m\n  1200K ........  37% 5.1M 2m')
    expect(p.stage).toBe('downloading')
    expect(p.percent).toBe(37)
    expect(p.zh).toMatch(/37%/)
  })
  it('启动成功', () => {
    expect(parseDockurProgress('❯ Booting Windows using QEMU v9\n❯ Windows started successfully, visit http://127.0.0.1:8006/ to view the screen...').stage).toBe('ready')
  })
  it('KVM 错误', () => {
    const p = parseDockurProgress('❯ ERROR: KVM acceleration is not available (device file missing), this will cause the machine to run about 10 times slower.')
    expect(p.stage).toBe('error')
    expect(p.zh).toMatch(/KVM/)
  })
  it('Booting 阶段提示首次安装耗时', () => {
    expect(parseDockurProgress('❯ Booting macOS using QEMU').zh).toMatch(/首次会自动安装/)
  })
  it('parseDockurMsgHtml（上游 msg.html 进度）', () => {
    expect(parseDockurMsgHtml('<p>Downloading Windows 11... (37.5%)</p>')).toEqual({ text: 'Downloading Windows 11...', percent: 37 })
    expect(parseDockurMsgHtml('Booting Windows')).toEqual({ text: 'Booting Windows' })
    expect(parseDockurMsgHtml('')).toBeNull()
  })
  it('classifyKvmProbeOutput', () => {
    expect(classifyKvmProbeOutput(0, 'kvm-ok').state).toBe('ok')
    expect(classifyKvmProbeOutput(125, 'docker: Error response from daemon: error gathering device information while adding custom device "/dev/kvm": no such file or directory.').state).toBe('missing')
    expect(classifyKvmProbeOutput(0, 'kvm-missing').state).toBe('missing')
    expect(classifyKvmProbeOutput(125, 'Unable to find image alpine:3 locally ... i/o timeout').state).toBe('unknown')
  })
  it('windowsBuildFromRelease / parseHostPort / viewerUrl / machineId', () => {
    expect(windowsBuildFromRelease('10.0.22631')).toBe(22631)
    expect(windowsBuildFromRelease('unknown')).toBeUndefined()
    expect(parseHostPort('{"8006/tcp":[{"HostIp":"127.0.0.1","HostPort":"18006"}]}', 8006)).toBe(18006)
    expect(parseHostPort('{}', 8006)).toBeNull()
    expect(viewerUrl('linux', 6080)).toContain('/vnc.html')
    expect(viewerUrl('windows', 8006)).toBe('http://127.0.0.1:8006/')
    expect(vmOsFromMachineId('vm-local')).toBe('linux')
    expect(vmOsFromMachineId('vm-windows')).toBe('windows')
    expect(vmOsFromMachineId('vm-macos')).toBe('macos')
    expect(vmOsFromMachineId('local')).toBeNull()
  })
})

/** 假 docker：记录调用，按脚本返回 */
function fakeDocker(opts: { exists?: boolean; running?: boolean; paused?: boolean; image?: boolean }) {
  const calls: string[][] = []
  const state = { exists: !!opts.exists, running: !!opts.running, paused: !!opts.paused }
  const run: Runner = async (_cmd, args) => {
    calls.push(args)
    const a = args.join(' ')
    if (a.startsWith('inspect -f {{.State.Running}} {{.State.Paused}}')) {
      return state.exists ? { code: 0, out: `${state.running} ${state.paused}`, err: '' } : { code: 1, out: '', err: 'No such object' }
    }
    if (a.startsWith('inspect -f {{json .HostConfig.PortBindings}}')) {
      return state.exists ? { code: 0, out: '{"8006/tcp":[{"HostIp":"127.0.0.1","HostPort":"18006"}]}', err: '' } : { code: 1, out: '', err: '' }
    }
    if (a.startsWith('inspect')) return state.exists ? { code: 0, out: 'abc', err: '' } : { code: 1, out: '', err: '' }
    if (a.startsWith('image inspect')) return { code: opts.image ? 0 : 1, out: '', err: '' }
    if (a.startsWith('logs')) return { code: 0, out: '❯ Booting Windows using QEMU', err: '' }
    if (args[0] === 'run' && args.includes('--name')) {
      state.exists = true
      state.running = true
    }
    if (args[0] === 'start') state.running = true
    if (args[0] === 'unpause') state.paused = false
    return { code: 0, out: '', err: '' }
  }
  return { run, calls, state }
}

const okDeps = (run: Runner) => ({
  run,
  detectDocker: async () => ({ installed: true, running: true, detail: 'Docker 27' }),
  portFree: async () => true,
  diskFreeBytes: async () => 500 * GB,
  hostPlatform: 'linux',
  probeKvm: async () => ({ state: 'ok' as const })
})

describe('DockurVmManager（假 docker）', () => {
  it('Docker 缺失：预检失败并给出 need_docker，不调用 docker run', async () => {
    const f = fakeDocker({})
    const vm = new DockurVmManager('windows', { ...okDeps(f.run), detectDocker: async () => ({ installed: false, running: false, detail: '未找到 docker 命令' }), probeKvm: async () => ({ state: 'unknown' as const }) })
    const s = await vm.start({ workDir: '' })
    expect(s.phase).toBe('need_docker')
    expect(f.calls.some((c) => c[0] === 'run')).toBe(false)
    vm.stopLogWatch()
  })
  it('KVM 缺失：need_kvm + 中文修复步骤', async () => {
    const f = fakeDocker({})
    const vm = new DockurVmManager('macos', { ...okDeps(f.run), hostPlatform: 'win32', probeKvm: async () => ({ state: 'missing' as const, windowsBuild: 22631 }) })
    const s = await vm.start({ workDir: '' })
    expect(s.phase).toBe('need_kvm')
    expect(s.message).toMatch(/nestedVirtualization/)
    expect(s.preflight?.items.find((i) => i.id === 'kvm')?.ok).toBe(false)
    vm.stopLogWatch()
  })
  it('全新创建：pull → volume create → docker run（参数来自纯函数）', async () => {
    const f = fakeDocker({ image: false })
    const vm = new DockurVmManager('windows', okDeps(f.run))
    const s = await vm.start({ workDir: '', config: { version: '10', ramGb: 6 } })
    vm.stopLogWatch()
    expect(f.calls.some((c) => c[0] === 'pull' && c[1] === 'dockurr/windows')).toBe(true)
    expect(f.calls.some((c) => c.join(' ') === 'volume create assistant-desktop-win-storage')).toBe(true)
    const runArgs = f.calls.find((c) => c[0] === 'run' && c.includes('--name'))!
    expect(runArgs.join(' ')).toContain('-e VERSION=10')
    expect(runArgs.join(' ')).toContain('-e RAM_SIZE=6G')
    expect(['installing', 'ready']).toContain(s.phase)
    expect(s.desktopUrl).toBe('http://127.0.0.1:8006/')
  })
  it('已停止的容器：docker start，不重建、不重复 pull', async () => {
    const f = fakeDocker({ exists: true, running: false, image: true })
    const vm = new DockurVmManager('windows', okDeps(f.run))
    await vm.start({ workDir: '' })
    vm.stopLogWatch()
    expect(f.calls.some((c) => c[0] === 'start')).toBe(true)
    expect(f.calls.some((c) => c[0] === 'run' && c.includes('--name'))).toBe(false)
    expect(vm.webPort).toBe(18006) // 从已有容器恢复端口
  })
  it('休眠中的容器：unpause 唤醒', async () => {
    const f = fakeDocker({ exists: true, running: true, paused: true, image: true })
    const vm = new DockurVmManager('macos', okDeps(f.run))
    await vm.start({ workDir: '' })
    vm.stopLogWatch()
    expect(f.calls.some((c) => c[0] === 'unpause')).toBe(true)
  })
  it('强制重建：重新 pull 并重建容器（卷保留）', async () => {
    const f = fakeDocker({ exists: true, running: true, image: true })
    const vm = new DockurVmManager('windows', okDeps(f.run))
    await vm.start({ workDir: '', forceRebuild: true })
    vm.stopLogWatch()
    expect(f.calls.some((c) => c[0] === 'pull')).toBe(true)
    expect(f.calls.some((c) => c.join(' ') === 'rm -f assistant-desktop-win')).toBe(true)
    expect(f.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false)
  })
  it('删除：removeData=true 时同时删除磁盘卷', async () => {
    const f = fakeDocker({ exists: true, image: true })
    const vm = new DockurVmManager('windows', okDeps(f.run))
    await vm.destroy(true)
    expect(f.calls.some((c) => c.join(' ') === 'volume rm -f assistant-desktop-win-storage')).toBe(true)
    const f2 = fakeDocker({ exists: true, image: true })
    const vm2 = new DockurVmManager('macos', okDeps(f2.run))
    await vm2.destroy(false)
    expect(f2.calls.some((c) => c[0] === 'volume')).toBe(false)
  })
  it('预检：首选端口被占用时自动挑选', async () => {
    const f = fakeDocker({})
    const vm = new DockurVmManager('windows', { ...okDeps(f.run), portFree: async (p: number) => p !== 8006 })
    const r = await vm.preflight({ workDir: '' })
    expect(r.webPort).toBe(18006)
    expect(r.items.find((i) => i.id === 'port')!.detail).toMatch(/自动改用 18006/)
  })
  it('预检：磁盘不足 70G 硬挡', async () => {
    const f = fakeDocker({})
    const vm = new DockurVmManager('macos', { ...okDeps(f.run), diskFreeBytes: async () => 20 * GB })
    const r = await vm.preflight({ workDir: '' })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/70 GB/)
  })
})

describe('VmRegistry 多 VM 共存', () => {
  it('其它 VM 已用端口会被预留', async () => {
    const f = fakeDocker({})
    const linux = new LocalVmManager()
    const win = new DockurVmManager('windows', okDeps(f.run))
    const mac = new DockurVmManager('macos', okDeps(f.run))
    const reg = new VmRegistry({ linux, windows: win, macos: mac })
    win.lastContainerExists = true
    win.webPort = 8007 // 假设 Windows 占用了 8007
    expect(reg.reservedPortsExcept('macos')).toContain(8007)
    const r = await mac.preflight({ workDir: '' })
    expect(r.webPort).not.toBe(8007)
    expect(reg.statuses().map((s) => s.os)).toEqual(['linux', 'windows', 'macos'])
    expect(reg.byMachineId('vm-macos')).toBe(mac)
  })
})
