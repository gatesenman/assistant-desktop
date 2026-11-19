import { localVm, VM_MACHINE_ID } from './localVm'
import { vms } from './vms'
import { vmOsFromMachineId, vmProfile } from '../../shared/vmProfiles'
/** v0.4 子系统装配：连接器、技能、远程机器、消息通道、编排器 */
import path from 'path'
import fs from 'fs'
import type { AppEvent, ChannelConfig, ConnectorConfig, MachineInfo, OrchestratorJob, Settings, Workflow } from '../../shared/types'
import type { Store } from './store'
import { CONNECTOR_PACKS, ConnectorSecrets, connectorToMcp, testConnector } from './connectors'
import { SkillStore, WorkflowStore, builtinSkillsDir } from './skills'
import { ChannelHub, ChannelSecrets } from './channels'
import { Orchestrator } from './orchestrator'
import { RemoteAgentClient, RemoteAgentServer, remoteComputerDeps } from './remote'
import type { ComputerDeps } from './computer'
import type { McpManager } from './mcp'
import type { SecretCodec } from './secrets'
import { uid } from './util'

export function createV04(opts: {
  userData: string
  appPath: string
  store: Store
  codec: SecretCodec
  mcp: McpManager
  localComputerDeps: ComputerDeps
  emit: (e: AppEvent) => void
  pushState: () => void
  spawnTask: Orchestrator['deps']['spawnTask']
  fetchImpl?: typeof fetch
  /** v0.7：虚拟电脑的 VNC 控制通道（Windows / macOS 必用；Linux 可选） */
  vncDeps?: (os: 'linux' | 'windows' | 'macos') => ComputerDeps
}): any {
  const { store, codec, mcp, emit, pushState } = opts
  const skillsDir = store.settings.skillsDir || path.join(opts.userData, 'skills')
  const skills = new SkillStore(skillsDir, builtinSkillsDir(opts.appPath))
  const workflows = new WorkflowStore(path.join(opts.userData, 'workflows'))
  // seed settings.workflows from disk once
  if (!store.settings.workflows?.length && workflows.list().length) {
    store.updateSettings({ workflows: workflows.list() })
  }
  const connSecrets = new ConnectorSecrets(path.join(opts.userData, 'connector-secrets'), codec)
  const channelSecrets = new ChannelSecrets(path.join(opts.userData, 'channel-secrets'), codec)
  const channels = new ChannelHub(channelSecrets, opts.fetchImpl)
  const orch = new Orchestrator({
    spawnTask: opts.spawnTask,
    onJob: (job) => {
      store.orchestratorJobs = [job, ...store.orchestratorJobs.filter((j) => j.id !== job.id)].slice(0, 50)
      emit({ type: 'orchestrator', job })
      pushState()
    }
  })
  const remoteToken = (): string => {
    const f = path.join(opts.userData, 'remote-token.txt')
    try {
      return codec.decrypt(fs.readFileSync(f, 'utf8'))
    } catch {
      return ''
    }
  }
  const setRemoteToken = (t: string): void => {
    const f = path.join(opts.userData, 'remote-token.txt')
    fs.writeFileSync(f, codec.encrypt(t))
  }
  const remoteServer = new RemoteAgentServer(opts.localComputerDeps, remoteToken, '本机')
  const clients = new Map<string, RemoteAgentClient>()
  const machineLocks = new Map<string, string | null>([['local', null]])

  const connectorsRoot = path.join(opts.appPath, 'connectors')

  const refreshViews = (): void => {
    store.skills = skills.list()
    store.connectorPacks = CONNECTOR_PACKS
    const local: MachineInfo = {
      id: 'local',
      label: '本机',
      kind: 'local',
      status: 'online',
      platform: process.platform,
      lastSeenAt: Date.now()
    }
    const vm: MachineInfo = {
      id: VM_MACHINE_ID,
      label: '本地虚拟电脑',
      kind: 'virtual',
      status: localVm.phase === 'ready' ? 'online' : localVm.phase === 'sleeping' ? 'offline' : 'offline',
      platform: 'linux-docker',
      lastSeenAt: Date.now(),
      error: localVm.lastError
    }
    const extraVms: MachineInfo[] = (['windows', 'macos'] as const)
      .map((os) => ({ os, st: vms.get(os).status() }))
      .filter(({ st }) => st.containerExists || st.phase !== 'idle')
      .map(({ os, st }) => ({
        id: vmProfile(os).machineId,
        label: '虚拟电脑 · ' + vmProfile(os).title,
        kind: 'virtual' as const,
        status: st.phase === 'ready' || st.phase === 'installing' ? ('online' as const) : st.phase === 'error' || st.phase === 'need_kvm' ? ('error' as const) : ('offline' as const),
        platform: os + '-docker',
        lastSeenAt: Date.now(),
        error: st.error
      }))
    const remotes = (store.settings.machines || []).map((m) => {
      const c = clients.get(m.id)
      return { ...m, status: c ? ('online' as const) : m.status || 'offline' }
    })
    store.machinesView = [local, vm, ...extraVms, ...remotes]
    store.orchestratorJobs = orch.list()
    // annotate hasSecrets for UI
    store.state.settings.connectors = (store.settings.connectors || []).map((c) => ({ ...c, hasSecrets: connSecrets.has(c.id) }))
    store.state.settings.channels = (store.settings.channels || []).map((c) => ({ ...c, hasSecrets: channelSecrets.has(c.id) }))
    store.state.settings.remoteAgentTokenSet = !!remoteToken()
  }

  const syncConnectorsToMcp = async (): Promise<void> => {
    const existing = store.settings.mcpServers.filter((s) => !s.id.startsWith('connector:'))
    const packs: typeof existing = []
    for (const c of store.settings.connectors || []) {
      if (!c.enabled) continue
      const secrets = connSecrets.load(c.id)
      const { command, args, env } = connectorToMcp(c, secrets, connectorsRoot)
      packs.push({
        id: 'connector:' + c.id,
        name: `连接器 · ${c.name}`,
        type: 'stdio',
        command,
        args,
        env,
        url: '',
        headers: {},
        enabled: true,
        disabledTools: [],
        autoApprove: false
      })
    }
    store.updateSettings({ mcpServers: [...existing, ...packs] })
    await mcp.sync(store.settings.mcpServers)
  }

  channels.on('message', (msg) => {
    emit({ type: 'channel-message', channelId: msg.channelId, text: msg.text, chatKey: msg.chatKey })
  })

  const getComputerDeps = (): ComputerDeps => {
    const id = store.settings.activeMachineId || 'local'
    if (id === 'local') return opts.localComputerDeps
    if (id === VM_MACHINE_ID || id === 'virtual') {
      if (localVm.phase !== 'ready') {
        // 不回落到本机：VM 未就绪时电脑工具直接报错，避免误操作宿主桌面
        const fail = async (): Promise<never> => {
          throw new Error('本地虚拟电脑（Linux 桌面）未就绪，请先在「电脑」面板启动')
        }
        return { capture: fail, driver: fail, openApp: fail, openUrl: fail, settleMs: 0 }
      }
      if (store.settings.linuxVmControl === 'vnc' && opts.vncDeps) {
        // VNC 鼠标键盘 + docker exec 启动程序 / 读取 AT-SPI
        const base = localVm.createComputerDeps({ textMode: opts.localComputerDeps.textMode, ocr: opts.localComputerDeps.ocr })
        const v = opts.vncDeps('linux')
        return { ...base, capture: v.capture, driver: v.driver, targetLabel: 'Linux 桌面虚拟电脑（VNC）', settleMs: 500 }
      }
      return localVm.createComputerDeps({ textMode: opts.localComputerDeps.textMode, ocr: opts.localComputerDeps.ocr })
    }
    const vmOs = vmOsFromMachineId(id)
    if (vmOs && vmOs !== 'linux') {
      // v0.7：Windows / macOS 通过 QEMU 内置 VNC 控制；VNC 不可用时直接报错，绝不回落到本机
      if (opts.vncDeps) return { ...opts.vncDeps(vmOs), textMode: opts.localComputerDeps.textMode, ocr: opts.localComputerDeps.ocr }
      const msg = `当前选中的是「${vmProfile(vmOs).title}」虚拟电脑：VNC 控制通道不可用。如需自动操作，请切换到 Linux 桌面虚拟电脑或本机。`
      const fail = async (): Promise<never> => {
        throw new Error(msg)
      }
      return { capture: fail, driver: fail, openApp: fail, openUrl: fail, settleMs: 0 }
    }
    const client = clients.get(id)
    if (!client) throw new Error(`远程机器 ${id} 未连接`)
    return remoteComputerDeps(client)
  }

  refreshViews()
  void channels.sync(store.settings.channels || [])

  return {
    skills,
    workflows,
    connSecrets,
    channelSecrets,
    channels,
    orch,
    remoteServer,
    refreshViews,
    syncConnectorsToMcp,
    getComputerDeps,
    clients,
    machineLocks,
    setRemoteToken,
    remoteToken
  }
}

export type V04 = ReturnType<typeof createV04>
