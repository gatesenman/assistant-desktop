/**
 * v0.6 虚拟电脑注册表：每个系统一台（Linux / Windows / macOS 可同时存在），
 * 容器名、卷、端口互不冲突。Linux 沿用 v0.5 的 localVm（容器 assistant-desktop-vm）。
 */
import { DockurVmManager, type DockurDeps } from './dockurVm'
import { localVm, type LocalVmManager, type LocalVmStatus, type PreflightResult } from './localVm'
import { summarizePreflight, VM_OS_LIST, vmOsFromMachineId, vmProfile, type KvmProbe, type VmOs, type VmPreflightItem } from '../../shared/vmProfiles'

export type AnyVm = LocalVmManager | DockurVmManager

function e2eKvmOverride(): Partial<DockurDeps> {
  if (process.env.ASSISTANT_E2E !== '1') return {}
  const out: Partial<DockurDeps> = {}
  // 仅 e2e：测试机磁盘较小时覆盖磁盘检测（报告中会注明）
  const diskGb = Number(process.env.ASSISTANT_E2E_DISK_FREE_GB || '')
  if (Number.isFinite(diskGb) && diskGb > 0) out.diskFreeBytes = async () => diskGb * 1024 ** 3
  // 仅 e2e：模拟其它宿主 / KVM 状态，用于截图验证提示文案（文案中会标注「e2e 模拟」）
  if (!process.env.ASSISTANT_E2E_KVM_PROBE) return out
  try {
    const o = JSON.parse(process.env.ASSISTANT_E2E_KVM_PROBE) as { host?: string } & KvmProbe
    return {
      ...out,
      hostPlatform: o.host || process.platform,
      probeKvm: async () => ({ state: o.state, detail: (o.detail || '') + '（e2e 模拟）', windowsBuild: o.windowsBuild })
    }
  } catch {
    return out
  }
}

export class VmRegistry {
  readonly linux: LocalVmManager
  readonly windows: DockurVmManager
  readonly macos: DockurVmManager

  constructor(opts?: { linux?: LocalVmManager; windows?: DockurVmManager; macos?: DockurVmManager }) {
    const over = e2eKvmOverride()
    this.linux = opts?.linux || localVm
    this.windows = opts?.windows || new DockurVmManager('windows', over)
    this.macos = opts?.macos || new DockurVmManager('macos', over)
    for (const os of VM_OS_LIST) {
      const vm = this.get(os)
      vm.reservedPorts = () => this.reservedPortsExcept(os)
    }
  }

  get(os: VmOs): AnyVm {
    return os === 'windows' ? this.windows : os === 'macos' ? this.macos : this.linux
  }

  byMachineId(id: string | undefined | null): AnyVm | null {
    const os = vmOsFromMachineId(id)
    return os ? this.get(os) : null
  }

  /** 其它 VM 已使用的宿主端口（防止多 VM 端口冲突） */
  reservedPortsExcept(os: VmOs): number[] {
    const out: number[] = []
    for (const o of VM_OS_LIST) {
      if (o === os) continue
      out.push(...this.get(o).usedPorts())
    }
    return out
  }

  statuses(): (LocalVmStatus & { os: VmOs })[] {
    return VM_OS_LIST.map((os) => ({ ...this.get(os).status(), os }))
  }

  async refreshAll(): Promise<(LocalVmStatus & { os: VmOs })[]> {
    const out: (LocalVmStatus & { os: VmOs })[] = []
    for (const os of VM_OS_LIST) {
      try {
        out.push({ ...(await this.get(os).refresh()), os })
      } catch (e) {
        out.push({ ...this.get(os).status(), os, error: String((e as Error)?.message || e) })
      }
    }
    return out
  }

  async preflight(os: VmOs, workDir: string, appPath: string): Promise<{ os: VmOs; ok: boolean; summary: string; items: VmPreflightItem[] }> {
    if (os === 'linux') {
      const r: PreflightResult = await this.linux.preflight({ workDir, appPath })
      const items: VmPreflightItem[] = r.items.map((i) => ({ ...i }))
      const s = summarizePreflight('linux', items)
      return { os, ok: r.ok, summary: s.summary, items }
    }
    const vm = this.get(os) as DockurVmManager
    const r = await vm.preflight({ workDir })
    return { os, ok: r.ok, summary: r.summary, items: r.items }
  }

  /** 诊断导出：列出所有 VM */
  async diagnostics(appPath: string, workDir: string): Promise<string> {
    let linux: unknown
    try {
      linux = JSON.parse(await this.linux.diagnosticSummary(appPath, workDir))
    } catch (e) {
      linux = { error: String((e as Error)?.message || e) }
    }
    const others: Record<string, unknown> = {}
    for (const os of ['windows', 'macos'] as const) {
      try {
        const vm = this.get(os) as DockurVmManager
        await vm.refresh().catch(() => undefined)
        others[os] = await vm.diagnostic()
      } catch (e) {
        others[os] = { error: String((e as Error)?.message || e) }
      }
    }
    return JSON.stringify(
      {
        vms: VM_OS_LIST.map((os) => {
          const st = this.get(os).status()
          return { os, title: vmProfile(os).title, container: vmProfile(os).container, phase: st.phase, webPort: st.webPort, containerExists: st.containerExists }
        }),
        linux,
        ...others
      },
      null,
      2
    )
  }
}

export const vms = new VmRegistry()
