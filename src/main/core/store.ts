import { DEFAULT_BUDGET, DEFAULT_PRICES } from './usage'
import type { PriceEntry } from '../../shared/types'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type {
  AppState,
  Assistant,
  ChatMessage,
  ComputerLogEntry,
  McpServerConfig,
  McpServerStatus,
  Routine,
  Settings,
  SettingsPatch,
  TaskInfo,
  ThreadInfo,
  BotFolder,
  RunStyle
} from '../../shared/types'
import { uid } from './util'
import { plainCodec, type SecretCodec } from './secrets'
import { ExperienceStore } from './experience'

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  theme: 'dark',
  accent: '#7c83ff',
  workDir: os.homedir(),
  autoApprove: {
    run_shell: false,
    read_file: true,
    write_file: false,
    list_dir: true,
    web_fetch: true,
    browser_open: true,
    browser_get_text: true,
    browser_screenshot: true,
    browser_click: false,
    browser_type: false,
    browser_state: true,
    browser_click_index: false,
    browser_type_index: false,
    browser_extract: true,
    ask_user: true,
    confirm_plan: true,
    computer_screenshot: true,
    find_text_on_screen: true,
    list_windows: true
  },
  maxToolSteps: 12,
  contextTokens: 24000,
  vision: true,
  closeToTray: true,
  launchAtLogin: false,
  routinesPaused: false,
  browserHeadless: false,
  browserExecutablePath: '',
  mcpServers: [],
  computerEnabled: true,
  trustedMode: false,
  computerMaxSteps: 40,
  minimizeOnComputerUse: true,
  preventSleep: true,
  transcriptionModel: 'whisper-1',
  maxConcurrentAgents: 10,
  proxyMode: 'system',
  proxyUrl: '',
  setupDone: false,
  capabilities: {},
  updateUrl: '',
  autoCheckUpdate: true,
  computerScreenMode: 'auto',
  activeMachineId: 'local',
  vmLastOs: 'linux',
  vmConfigs: {},
  remoteAgentPort: 8787,
  skillsDir: '',
  enabledSkills: [],
  connectors: [],
  channels: [],
  workflows: [],
  machines: [],
  somEnabled: true,
  somScope: 'foreground',
  grounding: { enabled: false, preset: 'main', baseUrl: '', model: '', coordSpace: 'pixel', promptStyle: 'json' },
  prices: DEFAULT_PRICES,
  budget: { ...DEFAULT_BUDGET },
  showUsage: true,
  cnyPerUsd: 7.1,
  linuxVmControl: 'docker',
  browserPersistentProfile: false,
  browserProfileDir: '',
  browserCdpUrl: '',
  browserProfilePerAssistant: true,
  planAutoConfirm: false,
  reflectEveryNSteps: 5
}

/** 合并价格表：内置条目用新版本覆盖（除非用户改过 → 标记 builtin=false），自定义条目保留 */
export function mergePrices(saved: PriceEntry[] | undefined): PriceEntry[] {
  if (!Array.isArray(saved) || !saved.length) return DEFAULT_PRICES.map((p) => ({ ...p }))
  const out: PriceEntry[] = []
  for (const d of DEFAULT_PRICES) {
    const u = saved.find((p) => p.id === d.id)
    out.push(u && !u.builtin ? u : { ...d })
  }
  for (const p of saved) if (!DEFAULT_PRICES.some((d) => d.id === p.id)) out.push(p)
  return out
}

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6']

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

interface PersistedSettings extends Partial<Settings> {
  apiKeyEnc?: string
  groundingApiKeyEnc?: string
}

/** 基于 JSON 文件的本地持久化（保存在 userData 目录） */
export class Store {
  readonly stateFile: string
  private chatDir: string
  private tasksFile: string
  state: { settings: Settings; assistants: Assistant[]; routines: Routine[]; folders: BotFolder[]; threads: ThreadInfo[] }
  tasks: TaskInfo[]
  mcpStatus: McpServerStatus[] = []
  computerLog: ComputerLogEntry[]
  runtime = { computerActive: false, powerBlocker: null as string | null, screenOwner: null as string | null, screenQueue: [] as string[], takeover: null as { assistantId: string; reason?: string; since: number } | null, teachRecording: false }
  private computerLogFile: string
  private computerLogArchiveDir: string
  readonly experience: ExperienceStore
  private chats = new Map<string, ChatMessage[]>()
  /** 加载时是否把明文 Key 迁移为加密存储 */
  migratedApiKey = false

  constructor(
    private dir: string,
    private codec: SecretCodec = plainCodec
  ) {
    this.stateFile = path.join(dir, 'state.json')
    this.chatDir = path.join(dir, 'chats')
    this.tasksFile = path.join(dir, 'tasks.json')
    this.computerLogFile = path.join(dir, 'computer-log.json')
    this.computerLogArchiveDir = path.join(dir, 'computer-log-archive')
    this.experience = new ExperienceStore(dir)
    fs.mkdirSync(this.chatDir, { recursive: true })
    fs.mkdirSync(this.computerLogArchiveDir, { recursive: true })
    const loaded = readJson<{ settings?: PersistedSettings; assistants?: Assistant[]; routines?: Routine[]; folders?: BotFolder[]; threads?: ThreadInfo[] }>(this.stateFile, {})
    const ls = loaded.settings || {}
    let apiKey = ''
    let needSave = false
    if (ls.apiKeyEnc) {
      try {
        apiKey = this.codec.decrypt(ls.apiKeyEnc)
      } catch {
        apiKey = ''
      }
    } else if (ls.apiKey) {
      apiKey = ls.apiKey
      if (this.codec.available()) {
        this.migratedApiKey = true
        needSave = true
      }
    }
    let groundingApiKey = ''
    if (ls.groundingApiKeyEnc) {
      try {
        groundingApiKey = this.codec.decrypt(ls.groundingApiKeyEnc)
      } catch {
        groundingApiKey = ''
      }
    } else if (ls.groundingApiKey) groundingApiKey = ls.groundingApiKey
    const { apiKeyEnc: _enc, groundingApiKeyEnc: _genc, ...rest } = ls
    void _enc
    void _genc
    this.state = {
      settings: {
        ...DEFAULT_SETTINGS,
        ...rest,
        apiKey,
        apiKeySet: undefined,
        groundingApiKey,
        groundingApiKeySet: undefined,
        grounding: { ...DEFAULT_SETTINGS.grounding, ...(ls.grounding || {}) },
        budget: { ...DEFAULT_BUDGET, ...(ls.budget || {}) },
        // 内置价格以新版本为准，用户自定义条目保留
        prices: mergePrices(ls.prices),
        autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...(ls.autoApprove || {}) },
        mcpServers: ls.mcpServers || [],
        capabilities: ls.capabilities || {},
        // 老版本升级：已经配置过密钥（或本地模型）的视为已完成首次设置
        setupDone: ls.setupDone ?? !!(apiKey || (ls.baseUrl && /localhost|127\.0\.0\.1/.test(ls.baseUrl)))
      },
      assistants: loaded.assistants || [],
      routines: loaded.routines || [],
      folders: loaded.folders || [],
      threads: loaded.threads || []
    }
    this.tasks = readJson<TaskInfo[]>(this.tasksFile, [])
    this.computerLog = readJson<ComputerLogEntry[]>(this.computerLogFile, [])
    for (const t of this.tasks)
      if (t.status === 'running' || t.status === 'queued') {
        t.status = 'cancelled'
        t.error = '应用退出时任务被中断'
      }
    if (this.state.assistants.length === 0) {
      this.createAssistant('小助手', '你是一个友好、高效的个人 AI 助手，回答使用简体中文。')
    } else if (needSave) this.save()
  }

  get encryptionAvailable(): boolean {
    return this.codec.available()
  }
  get encryptionBackend(): string {
    return this.codec.backend()
  }

  save(): void {
    const { apiKey, apiKeySet: _s, groundingApiKey, groundingApiKeySet: _gs, ...rest } = this.state.settings
    void _s
    void _gs
    const settings: PersistedSettings = { ...rest }
    if (apiKey) {
      if (this.codec.available()) settings.apiKeyEnc = this.codec.encrypt(apiKey)
      else settings.apiKey = apiKey
    }
    if (groundingApiKey) {
      if (this.codec.available()) settings.groundingApiKeyEnc = this.codec.encrypt(groundingApiKey)
      else settings.groundingApiKey = groundingApiKey
    }
    writeJsonAtomic(this.stateFile, { ...this.state, settings })
  }

  /** 运行时视图（由主进程填充） */
  skills: AppState['skills'] = []
  machinesView: AppState['machines'] = []
  orchestratorJobs: AppState['orchestratorJobs'] = []
  connectorPacks: AppState['connectorPacks'] = []

  /** 发给渲染进程的状态（不含明文密钥） */
  publicState(): AppState {
    return {
      settings: {
        ...this.state.settings,
        apiKey: '',
        apiKeySet: !!this.state.settings.apiKey,
        groundingApiKey: '',
        groundingApiKeySet: !!this.state.settings.groundingApiKey
      },
      assistants: this.state.assistants,
      routines: this.state.routines,
      mcpStatus: this.mcpStatus,
      security: { encryptionAvailable: this.codec.available(), backend: this.codec.backend() },
      skills: this.skills,
      machines: this.machinesView,
      orchestratorJobs: this.orchestratorJobs,
      connectorPacks: this.connectorPacks,
      folders: this.state.folders,
      threads: this.state.threads,
      computerPreview: this.computerPreview,
      localVm: this.localVmStatus,
      vms: this.vmsStatus,
      previews: Object.fromEntries(this.state.assistants.map((a) => [a.id, this.preview(a.id)])),
      runtime: { ...this.runtime }
    }
  }

  computerPreview: AppState['computerPreview'] = null
  localVmStatus: AppState['localVm'] = null
  vmsStatus: AppState['vms'] = []

  /** 侧边栏用的最后一条消息预览 */
  preview(assistantId: string): { text: string; at: number } {
    const msgs = this.getMessages(assistantId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'tool') continue
      const text = (m.content || (m.toolCalls?.length ? `[${m.toolCalls[m.toolCalls.length - 1].name}]` : '') || (m.images?.length ? '[图片]' : ''))
        .replace(/```[\s\S]*?```/g, '[代码]')
        .replace(/[#*_`>|-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) return { text: text.slice(0, 60), at: m.createdAt }
    }
    return { text: '', at: 0 }
  }

  addComputerLog(e: ComputerLogEntry): void {
    this.computerLog.push(e)
    // 内存保留最近 2000 条；超出则按 runId 归档到磁盘，不再死卡 300
    if (this.computerLog.length > 2000) {
      this.archiveOldLogs()
    }
    writeJsonAtomic(this.computerLogFile, this.computerLog)
  }

  /** 把较早的日志按 runId 归档，内存只留最近若干条 */
  private archiveOldLogs(): void {
    const keep = 800
    if (this.computerLog.length <= keep) return
    const old = this.computerLog.slice(0, this.computerLog.length - keep)
    this.computerLog = this.computerLog.slice(-keep)
    const byRun = new Map<string, ComputerLogEntry[]>()
    for (const e of old) {
      const k = e.runId || e.taskId || `day-${new Date(e.at).toISOString().slice(0, 10)}`
      if (!byRun.has(k)) byRun.set(k, [])
      byRun.get(k)!.push(e)
    }
    for (const [k, entries] of byRun) {
      const safe = k.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
      const file = path.join(this.computerLogArchiveDir, `${safe}-${entries[0].at}.json`)
      try {
        writeJsonAtomic(file, entries)
      } catch {
        /* ignore */
      }
    }
  }

  listArchivedLogFiles(): string[] {
    try {
      return fs.readdirSync(this.computerLogArchiveDir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
  }

  clearComputerLog(): void {
    this.computerLog = []
    writeJsonAtomic(this.computerLogFile, this.computerLog)
  }

  get settings(): Settings {
    return this.state.settings
  }

  updateSettings(patch: SettingsPatch): void {
    const { apiKeySet: _s, groundingApiKeySet: _gs, ...p } = patch
    void _s
    void _gs
    const next: Settings = {
      ...this.state.settings,
      ...p,
      autoApprove: { ...this.state.settings.autoApprove, ...(p.autoApprove || {}) }
    }
    if (p.apiKey === undefined) next.apiKey = this.state.settings.apiKey
    if (p.groundingApiKey === undefined) next.groundingApiKey = this.state.settings.groundingApiKey
    if (p.grounding) next.grounding = { ...this.state.settings.grounding, ...p.grounding }
    if (p.budget) next.budget = { ...this.state.settings.budget, ...p.budget }
    this.state.settings = next
    this.save()
  }

  upsertMcpServer(cfg: McpServerConfig): void {
    const list = this.state.settings.mcpServers
    const i = list.findIndex((s) => s.id === cfg.id)
    if (i >= 0) list[i] = cfg
    else list.push(cfg)
    this.save()
  }

  deleteMcpServer(id: string): void {
    this.state.settings.mcpServers = this.state.settings.mcpServers.filter((s) => s.id !== id)
    this.save()
  }

  getAssistant(id: string): Assistant | undefined {
    return this.state.assistants.find((a) => a.id === id)
  }

  createAssistant(name: string, systemPrompt = ''): Assistant {
    const a: Assistant = {
      id: uid(),
      name: name.trim() || '新助手',
      systemPrompt,
      color: COLORS[this.state.assistants.length % COLORS.length],
      memory: [],
      createdAt: Date.now(),
      computerMode: 'this',
      computerEnabled: true,
      runStyle: 'ask',
      pinned: false,
      hidden: false
    }
    this.state.assistants.push(a)
    this.save()
    return a
  }

  updateAssistant(id: string, patch: Partial<Assistant>): void {
    const a = this.getAssistant(id)
    if (!a) throw new Error('助手不存在')
    Object.assign(a, { ...patch, id })
    this.save()
  }

  deleteAssistant(id: string): void {
    this.state.assistants = this.state.assistants.filter((a) => a.id !== id)
    this.state.routines = this.state.routines.filter((r) => r.assistantId !== id)
    this.tasks = this.tasks.filter((t) => t.assistantId !== id)
    this.saveTasks()
    this.chats.delete(id)
    try {
      fs.unlinkSync(this.chatFile(id))
    } catch {
      /* ignore */
    }
    this.save()
  }

  addMemory(assistantId: string, text: string): void {
    const a = this.getAssistant(assistantId)
    if (!a) throw new Error('助手不存在')
    a.memory.push({ id: uid(), text: text.trim(), createdAt: Date.now() })
    this.save()
  }

  private chatKey(assistantId: string, threadId?: string | null): string {
    const a = this.getAssistant(assistantId)
    const tid = threadId || a?.activeThreadId
    return tid ? `${assistantId}__${tid}` : assistantId
  }

  private chatFile(id: string): string {
    return path.join(this.chatDir, `${id.replace(/[^a-zA-Z0-9-_]/g, '')}.json`)
  }

  getMessages(assistantId: string): ChatMessage[] {
    const key = this.chatKey(assistantId)
    let msgs = this.chats.get(key)
    if (!msgs) {
      msgs = readJson<ChatMessage[]>(this.chatFile(key), [])
      for (const m of msgs) {
        if (m.streaming) m.streaming = false
        for (const tc of m.toolCalls || [])
          if (tc.status === 'awaiting' || tc.status === 'running') {
            tc.status = 'cancelled'
            tc.result = tc.result || '已取消（应用重启）'
          }
      }
      this.chats.set(key, msgs)
    }
    return msgs
  }

  saveMessages(assistantId: string): void {
    const key = this.chatKey(assistantId)
    writeJsonAtomic(this.chatFile(key), this.getMessages(assistantId))
  }

  listThreads(assistantId: string): ThreadInfo[] {
    return this.state.threads.filter((t) => t.assistantId === assistantId && !t.hidden).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  createThread(assistantId: string, title = '新对话'): ThreadInfo {
    this.saveMessages(assistantId)
    const t: ThreadInfo = { id: uid(), assistantId, title: title.trim() || '新对话', createdAt: Date.now(), updatedAt: Date.now() }
    this.state.threads.push(t)
    const a = this.getAssistant(assistantId)
    if (a) a.activeThreadId = t.id
    this.save()
    return t
  }

  switchThread(assistantId: string, threadId: string): void {
    const a = this.getAssistant(assistantId)
    if (!a) throw new Error('助手不存在')
    if (threadId && !this.state.threads.some((t) => t.id === threadId && t.assistantId === assistantId)) throw new Error('线程不存在')
    // 先落盘当前线程
    this.saveMessages(assistantId)
    a.activeThreadId = threadId || undefined
    this.save()
  }

  duplicateAssistant(id: string): Assistant {
    const src = this.getAssistant(id)
    if (!src) throw new Error('助手不存在')
    const copy = this.createAssistant(src.name + ' 副本', src.systemPrompt)
    Object.assign(copy, {
      model: src.model,
      workDir: src.workDir,
      computerMode: src.computerMode,
      computerEnabled: src.computerEnabled,
      runStyle: src.runStyle,
      folderId: src.folderId,
      memory: src.memory.map((m) => ({ ...m, id: uid() }))
    })
    this.save()
    return copy
  }

  clearMessages(assistantId: string): void {
    this.chats.set(this.chatKey(assistantId), [])
    this.saveMessages(assistantId)
  }

  saveTasks(): void {
    // 每个助手最多保留最近 30 个任务
    const keep: TaskInfo[] = []
    const count = new Map<string, number>()
    for (const t of [...this.tasks].sort((a, b) => b.createdAt - a.createdAt)) {
      const n = count.get(t.assistantId) || 0
      if (t.status === 'running' || t.status === 'queued' || n < 30) keep.push(t)
      count.set(t.assistantId, n + 1)
    }
    this.tasks = keep.sort((a, b) => a.createdAt - b.createdAt)
    writeJsonAtomic(this.tasksFile, this.tasks)
  }

  createRoutine(r: Omit<Routine, 'id' | 'createdAt'>): Routine {
    const routine: Routine = { ...r, id: uid(), createdAt: Date.now() }
    this.state.routines.push(routine)
    this.save()
    return routine
  }

  updateRoutine(id: string, patch: Partial<Routine>): void {
    const r = this.state.routines.find((x) => x.id === id)
    if (!r) throw new Error('定时任务不存在')
    Object.assign(r, { ...patch, id })
    this.save()
  }

  deleteRoutine(id: string): void {
    this.state.routines = this.state.routines.filter((r) => r.id !== id)
    this.save()
  }

  renameThread(threadId: string, title: string): void {
    const t = this.state.threads.find((x) => x.id === threadId)
    if (!t) throw new Error('线程不存在')
    t.title = title.trim() || t.title
    t.updatedAt = Date.now()
    this.save()
  }

  deleteThread(threadId: string): void {
    const t = this.state.threads.find((x) => x.id === threadId)
    if (!t) throw new Error('线程不存在')
    t.hidden = true
    const a = this.getAssistant(t.assistantId)
    if (a?.activeThreadId === threadId) a.activeThreadId = undefined
    this.save()
  }

  pinAssistant(id: string, pinned: boolean): void {
    this.updateAssistant(id, { pinned })
  }

  hideAssistant(id: string, hidden: boolean): void {
    this.updateAssistant(id, { hidden })
  }

  listFolders(): BotFolder[] {
    return [...this.state.folders]
  }

  saveFolder(f: Partial<BotFolder> & { name: string }): BotFolder {
    if (f.id) {
      const cur = this.state.folders.find((x) => x.id === f.id)
      if (!cur) throw new Error('文件夹不存在')
      cur.name = f.name.trim() || cur.name
      this.save()
      return cur
    }
    const folder: BotFolder = { id: uid(), name: f.name.trim() || '文件夹', createdAt: Date.now() }
    this.state.folders.push(folder)
    this.save()
    return folder
  }

  deleteFolder(id: string): void {
    this.state.folders = this.state.folders.filter((f) => f.id !== id)
    for (const a of this.state.assistants) if (a.folderId === id) a.folderId = null
    this.save()
  }

  moveAssistantToFolder(assistantId: string, folderId: string | null): void {
    this.updateAssistant(assistantId, { folderId })
  }

  setRunStyle(assistantId: string, style: RunStyle): void {
    this.updateAssistant(assistantId, { runStyle: style })
  }

  setComputerPreview(thumb: string | null, machineId = 'local'): void {
    this.computerPreview = thumb ? { thumb, at: Date.now(), machineId } : null
  }
}
