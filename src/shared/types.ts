import type { VmOs, VmPreflightItem, VmUserConfig } from './vmProfiles'
export type { VmOs, VmPreflightItem, VmUserConfig } from './vmProfiles'
export type ThemeMode = 'light' | 'dark' | 'system'

/** 可在设置中配置「自动批准」的内置工具 */
export const APPROVABLE_TOOLS = [
  'run_shell',
  'read_file',
  'write_file',
  'list_dir',
  'web_fetch',
  'browser_open',
  'browser_get_text',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_state',
  'browser_click_index',
  'browser_type_index',
  'browser_extract',
  'ask_user'
] as const

/** 电脑控制工具（可单独设置自动批准；「信任模式」下全部自动批准） */
export const COMPUTER_TOOL_NAMES = [
  'computer_screenshot',
  'find_text_on_screen',
  'list_windows',
  'mouse_move',
  'mouse_click',
  'mouse_double_click',
  'mouse_right_click',
  'mouse_drag',
  'scroll',
  'type_text',
  'key_press',
  'open_app',
  'open_url',
  'focus_window'
] as const

export interface McpServerConfig {
  id: string
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  enabled: boolean
  disabledTools: string[]
  /** 该服务器的工具是否自动批准（默认需要审批） */
  autoApprove: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
  /** 暴露给模型的带命名空间名称 */
  exposedName: string
}

export interface McpServerStatus {
  id: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: McpToolInfo[]
}

export interface Settings {
  baseUrl: string
  /** 仅主进程内存中保存明文；发给渲染进程时恒为空 */
  apiKey: string
  /** 渲染进程用：是否已配置 API Key */
  apiKeySet?: boolean
  model: string
  temperature: number
  theme: ThemeMode
  accent: string
  workDir: string
  autoApprove: Record<string, boolean>
  maxToolSteps: number
  /** 上下文 token 预算（估算） */
  contextTokens: number
  /** 是否把截图/图片发送给模型（视觉模型） */
  vision: boolean
  closeToTray: boolean
  launchAtLogin: boolean
  routinesPaused: boolean
  browserHeadless: boolean
  browserExecutablePath: string
  mcpServers: McpServerConfig[]
  /** 是否向模型提供电脑控制工具 */
  computerEnabled: boolean
  /** 信任模式：自动批准所有电脑控制操作（用于无人值守） */
  trustedMode: boolean
  /** 电脑控制会话的最大步数 */
  computerMaxSteps: number
  /** 控制电脑时最小化主窗口 */
  minimizeOnComputerUse: boolean
  /** 有任务/定时任务时阻止系统休眠 */
  preventSleep: boolean
  /** 语音转写模型（/audio/transcriptions） */
  transcriptionModel: string
  /** 后台并行智能体（子任务 / 委派任务）的最大并发数 */
  maxConcurrentAgents: number
  /** 网络代理：跟随系统 / 直连 / 自定义（HTTP、HTTPS、SOCKS5） */
  proxyMode: ProxyMode
  /** 自定义代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080 */
  proxyUrl: string
  /** 首次启动向导是否已完成（连接并测试过模型） */
  setupDone: boolean
  /** 模型能力检测结果缓存，键为 baseUrl|model */
  capabilities: Record<string, ModelCapabilities>
  /** 更新检查地址（返回 latest.json） */
  updateUrl: string
  /** 启动时自动检查更新 */
  autoCheckUpdate: boolean
  /** 电脑控制的屏幕感知方式：auto=按模型能力自动选择；image=发送截图；text=OCR 文字描述（适合不能看图的模型） */
  computerScreenMode: 'auto' | 'image' | 'text'
  /** 当前电脑控制目标机器 id（local 或远程） */
  activeMachineId: string
  /** v0.6：上次选择的虚拟电脑系统 */
  vmLastOs?: VmOs
  /** v0.6：各系统虚拟电脑配置（版本 / 内存 / CPU / 磁盘） */
  vmConfigs?: Partial<Record<VmOs, VmUserConfig>>
  /** 远程电脑伴侣监听端口（本机作为服务器时） */
  remoteAgentPort: number
  /** 远程电脑伴侣共享口令（加密存储于 secrets 表；此处仅标记） */
  remoteAgentTokenSet?: boolean
  /** 技能根目录（空=userData/skills） */
  skillsDir: string
  /** 已启用的技能 id 列表；空表示全部内置 + 用户技能 */
  enabledSkills: string[]
  /** 连接器配置（密钥分离存储） */
  connectors: ConnectorConfig[]
  /** 消息通道 */
  channels: ChannelConfig[]
  /** 保存的工作流 */
  workflows: Workflow[]
  /** 已知远程机器（不含本机） */
  machines: MachineInfo[]
  /** v0.7：截图上绘制编号（Set-of-Mark），并读取无障碍控件树 */
  somEnabled: boolean
  /** v0.7：读取控件树的范围：前台窗口 / 前台窗口 + 任务栏 */
  somScope: 'foreground' | 'desktop'
  /** v0.7：grounding（定位）模型 */
  grounding: GroundingSettings
  /** 仅主进程内存；发给渲染进程时恒为空 */
  groundingApiKey?: string
  groundingApiKeySet?: boolean
  /** v0.7：价格表（每百万 token） */
  prices: PriceEntry[]
  /** v0.7：预算 */
  budget: BudgetSettings
  /** v0.7：在每条回复下显示用量 */
  showUsage: boolean
  /** v0.7：美元 → 人民币换算（仅用于显示） */
  cnyPerUsd: number
  /** v0.7：Linux 虚拟电脑的控制通道：docker（xdotool）或 vnc */
  linuxVmControl: 'docker' | 'vnc'
  /** v0.8：浏览器使用持久化 profile（保留登录态） */
  browserPersistentProfile: boolean
  /** v0.8：持久化 profile 根目录（空=userData/browser-profiles） */
  browserProfileDir: string
  /** v0.8：通过 CDP 连接已打开的 Chrome，例如 http://127.0.0.1:9222 */
  browserCdpUrl: string
  /** v0.8：每个助手单独 profile 子目录 */
  browserProfilePerAssistant: boolean
  /** v0.8：电脑操控计划卡片自动确认（跳过人工点确认） */
  planAutoConfirm: boolean
  /** v0.8：每 N 步做一次截图反思校验（0=关闭） */
  reflectEveryNSteps: number
}

export type ProxyMode = 'system' | 'direct' | 'custom'

export type CapabilityState = 'yes' | 'no' | 'unknown'

export interface ModelCapabilities {
  model: string
  baseUrl: string
  chat: boolean
  tools: CapabilityState
  vision: CapabilityState
  /** 各项检测的说明（错误信息等） */
  notes: string[]
  checkedAt: number
  latencyMs?: number
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  errorKind?: string
  capabilities?: ModelCapabilities
}

export interface UpdateInfo {
  ok: boolean
  current: string
  latest?: string
  available: boolean
  notes?: string
  url?: string
  message: string
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  model: string
  keyUrl?: string
  needsProxy?: boolean
  noKey?: boolean
  envKey?: string
}

export interface ComputerLogEntry {
  id: string
  assistantId: string
  taskId?: string
  /** v0.8：同一次电脑操控运行的分组 id */
  runId?: string
  tool: string
  args: string
  ok: boolean
  error?: string
  at: number
  thumb?: string
  /** v0.8：模型思考摘要 */
  reasoning?: string
}

export interface RuntimeInfo {
  computerActive: boolean
  powerBlocker: string | null
  /** 当前占用屏幕（电脑控制锁）的运行，以及排队等待者 */
  screenOwner?: string | null
  screenQueue?: string[]
  /** v0.8：接管状态 */
  takeover?: { assistantId: string; reason?: string; since: number } | null
  /** v0.8：示教录制中 */
  teachRecording?: boolean
}

export interface MemoryItem {
  id: string
  text: string
  createdAt: number
}

export type ComputerTargetMode = 'this' | 'remote' | 'virtual' | 'off'
/** Ask=每步审批倾向；Auto=信任/自动批准（仍受全局 trustedMode 与单工具设置约束） */
export type RunStyle = 'ask' | 'auto'

export interface BotFolder {
  id: string
  name: string
  createdAt: number
}

export interface ThreadInfo {
  id: string
  assistantId: string
  title: string
  createdAt: number
  updatedAt: number
  /** 归档/隐藏 */
  hidden?: boolean
}

export interface Assistant {
  id: string
  name: string
  systemPrompt: string
  model?: string
  color: string
  memory: MemoryItem[]
  createdAt: number
  /** 该助手工具默认工作目录（空=全局 workDir） */
  workDir?: string
  /** 电脑控制偏好：本机 / 远程 / 关闭 */
  computerMode?: ComputerTargetMode
  /** v0.6：computerMode=virtual 时使用的虚拟电脑系统（默认 linux） */
  vmOs?: VmOs
  /** 远程机器 id（computerMode=remote 时） */
  remoteMachineId?: string
  /** 是否允许电脑控制（预览与授权分离） */
  computerEnabled?: boolean
  pinned?: boolean
  hidden?: boolean
  folderId?: string | null
  /** 默认 Ask 或 Auto */
  runStyle?: RunStyle
  /** 当前活动线程；空表示默认主线程（兼容旧数据） */
  activeThreadId?: string
}

export type ToolCallStatus = 'awaiting' | 'awaiting_input' | 'running' | 'done' | 'error' | 'denied' | 'cancelled'

export interface ToolCallRecord {
  id: string
  name: string
  arguments: string
  status: ToolCallStatus
  result?: string
  images?: string[]
  startedAt?: number
  finishedAt?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  toolCalls?: ToolCallRecord[]
  toolCallId?: string
  createdAt: number
  streaming?: boolean
  error?: string
  stopped?: boolean
  stopReason?: string
  /** 推理模型的思考过程 */
  reasoning?: string
  /** 正在自动重试等临时提示 */
  notice?: string
  errorKind?: string
  /** 出错后可点击「重试」 */
  retryable?: boolean
  source?: 'routine' | 'task'
  routineName?: string
  taskId?: string
  /** v0.7：本条回复的 token 用量与费用 */
  usage?: MessageUsage
  /** v0.8：计划卡片（电脑操控前） */
  plan?: { text: string; status: 'pending' | 'confirmed' | 'rejected' | 'edited' }
  /** v0.8：ask_user 问题 */
  askUser?: { question: string; answer?: string }
}

export interface Routine {
  id: string
  assistantId: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  lastRunAt?: number
  lastStatus?: 'ok' | 'error'
  lastError?: string
  /** 无人值守：自动批准该定时任务中的所有操作（含电脑控制） */
  unattended?: boolean
  createdAt: number
  /** v0.7：最近一次运行的用量 */
  lastUsage?: MessageUsage
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TaskInfo {
  id: string
  assistantId: string
  title: string
  prompt: string
  status: TaskStatus
  result?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  messages: ChatMessage[]
  autoApproveAll?: boolean
  /** 委派任务：发起委派的协调者助手 */
  parentAssistantId?: string
  /** 同一次委派的任务组 */
  groupId?: string
  /** v0.7：任务累计用量 */
  usage?: MessageUsage
}

export interface SecurityInfo {
  encryptionAvailable: boolean
  backend: string
}

export interface AppState {
  settings: Settings
  assistants: Assistant[]
  routines: Routine[]
  mcpStatus: McpServerStatus[]
  security: SecurityInfo
  previews: Record<string, { text: string; at: number }>
  runtime: RuntimeInfo
  skills: SkillMeta[]
  machines: MachineInfo[]
  orchestratorJobs: OrchestratorJob[]
  connectorPacks: ConnectorPack[]
  folders: BotFolder[]
  threads: ThreadInfo[]
  /** 最近一次电脑截图（供右侧面板预览，不含权限） */
  computerPreview?: { thumb: string; at: number; machineId: string } | null
  localVm?: LocalVmStatus | null
  /** v0.6：所有系统的虚拟电脑状态 */
  vms?: VmStatus[]
}

export type AppEvent =
  | { type: 'message-upsert'; assistantId: string; message: ChatMessage }
  | { type: 'message-delta'; assistantId: string; messageId: string; delta: string }
  | { type: 'run-state'; assistantId: string; running: boolean }
  | { type: 'state-changed'; state: AppState }
  | { type: 'messages-reset'; assistantId: string }
  | { type: 'navigate'; assistantId: string }
  | { type: 'task-upsert'; task: TaskInfo }
  | { type: 'computer-log'; entry: ComputerLogEntry }
  | { type: 'runtime'; runtime: RuntimeInfo }
  | { type: 'orchestrator'; job: OrchestratorJob }
  | { type: 'channel-message'; channelId: string; text: string; chatKey: string }
  | { type: 'machine'; machine: MachineInfo }
  | { type: 'computer-preview'; thumb: string; at: number; machineId: string }
  | { type: 'local-vm'; status: LocalVmStatus }
  | { type: 'vms'; list: VmStatus[] }
  | { type: 'usage'; today: UsageBucket; total: UsageBucket }
  | { type: 'takeover'; assistantId: string; active: boolean; reason?: string }
  | { type: 'teach'; recording: boolean; sessionId?: string }
  | { type: 'ask-user'; assistantId: string; callId: string; question: string }
  | { type: 'plan'; assistantId: string; messageId: string; text: string; status: string }

export interface TestResult {
  ok: boolean
  message: string
}

export interface SettingsPatch extends Partial<Omit<Settings, 'autoApprove'>> {
  autoApprove?: Record<string, boolean>
}

export interface Api {
  getState(): Promise<AppState>
  saveSettings(patch: SettingsPatch): Promise<AppState>
  createAssistant(name: string): Promise<Assistant>
  updateAssistant(id: string, patch: Partial<Assistant>): Promise<AppState>
  deleteAssistant(id: string): Promise<AppState>
  getMessages(assistantId: string): Promise<ChatMessage[]>
  clearMessages(assistantId: string): Promise<void>
  isRunning(assistantId: string): Promise<boolean>
  sendMessage(assistantId: string, text: string, images: string[]): Promise<void>
  stop(assistantId: string): Promise<void>
  respondTool(callId: string, approved: boolean): Promise<void>
  createRoutine(r: Omit<Routine, 'id' | 'createdAt'>): Promise<AppState>
  updateRoutine(id: string, patch: Partial<Routine>): Promise<AppState>
  deleteRoutine(id: string): Promise<AppState>
  runRoutineNow(id: string): Promise<void>
  validateCron(expr: string): Promise<boolean>
  testConnection(): Promise<TestResult>
  /** 用给定配置（不保存）测试连接并检测能力 */
  testModel(cfg: { baseUrl: string; apiKey?: string; model: string; useSavedKey?: boolean }): Promise<ConnectionTestResult>
  /** 检测当前模型能力（工具调用 / 图片） */
  checkCapabilities(force?: boolean): Promise<ConnectionTestResult>
  testProxy(cfg: { proxyMode: ProxyMode; proxyUrl: string }): Promise<TestResult>
  getSetupDefaults(): Promise<{ presets: ProviderPreset[]; env: { id: string; envKey: string }[] }>
  retryLast(assistantId: string): Promise<void>
  checkUpdate(): Promise<UpdateInfo>
  exportLogs(): Promise<{ ok: boolean; path: string; message: string }>
  getVersion(): Promise<string>
  openExternal(url: string): Promise<void>
  listTasks(): Promise<TaskInfo[]>
  cancelTask(id: string): Promise<void>
  clearFinishedTasks(assistantId: string): Promise<TaskInfo[]>
  saveMcpServer(cfg: McpServerConfig): Promise<AppState>
  deleteMcpServer(id: string): Promise<AppState>
  refreshMcpServer(id: string): Promise<AppState>
  installBrowser(): Promise<TestResult>
  getComputerLog(): Promise<ComputerLogEntry[]>
  clearComputerLog(): Promise<void>
  emergencyStop(): Promise<void>
  transcribe(audioBase64: string, mime: string): Promise<{ ok: boolean; text: string }>
  // —— v0.4 ——
  listConnectorPacks(): Promise<ConnectorPack[]>
  saveConnector(cfg: ConnectorConfig & { secrets?: Record<string, string> }): Promise<AppState>
  deleteConnector(id: string): Promise<AppState>
  testConnector(id: string): Promise<TestResult>
  listSkills(): Promise<SkillMeta[]>
  readSkill(id: string): Promise<{ meta: SkillMeta; body: string }>
  saveSkill(id: string, body: string, meta?: Partial<SkillMeta>): Promise<SkillMeta>
  deleteSkill(id: string): Promise<void>
  listWorkflows(): Promise<Workflow[]>
  saveWorkflow(w: Workflow): Promise<Workflow>
  deleteWorkflow(id: string): Promise<void>
  runWorkflow(id: string, assistantId: string, inputs?: Record<string, string>): Promise<{ jobId: string }>
  listMachines(): Promise<MachineInfo[]>
  saveMachine(m: Partial<MachineInfo> & { label: string; url?: string; token?: string }): Promise<MachineInfo>
  deleteMachine(id: string): Promise<void>
  setActiveMachine(id: string): Promise<AppState>
  startRemoteAgentServer(): Promise<TestResult>
  stopRemoteAgentServer(): Promise<void>
  saveChannel(cfg: ChannelConfig & { secrets?: Record<string, string> }): Promise<AppState>
  deleteChannel(id: string): Promise<AppState>
  testChannel(id: string): Promise<TestResult>
  approveChannelSend(draftId: string, approved: boolean): Promise<void>
  createOrchestratorJob(assistantId: string, goal: string, nodes?: Partial<OrchestratorNode>[]): Promise<OrchestratorJob>
  pauseOrchestrator(id: string): Promise<void>
  resumeOrchestrator(id: string): Promise<void>
  cancelOrchestrator(id: string): Promise<void>
  listOrchestratorJobs(): Promise<OrchestratorJob[]>
  listThreads(assistantId: string): Promise<ThreadInfo[]>
  createThread(assistantId: string, title?: string): Promise<ThreadInfo>
  switchThread(assistantId: string, threadId: string): Promise<AppState>
  renameThread(threadId: string, title: string): Promise<AppState>
  deleteThread(threadId: string): Promise<AppState>
  pinAssistant(id: string, pinned: boolean): Promise<AppState>
  hideAssistant(id: string, hidden: boolean): Promise<AppState>
  duplicateAssistant(id: string): Promise<Assistant>
  listFolders(): Promise<BotFolder[]>
  saveFolder(f: Partial<BotFolder> & { name: string }): Promise<BotFolder>
  deleteFolder(id: string): Promise<void>
  moveAssistantToFolder(assistantId: string, folderId: string | null): Promise<AppState>
  setRunStyle(assistantId: string, style: RunStyle): Promise<AppState>
  captureComputerPreview(): Promise<{ thumb: string; at: number } | null>
  localVmStatus(): Promise<LocalVmStatus>
  localVmStart(assistantId?: string, opts?: { forceRebuild?: boolean }): Promise<LocalVmStatus>
  localVmStop(): Promise<LocalVmStatus>
  localVmOpenDesktop(): Promise<{ ok: boolean; url?: string; message: string }>
  localVmTryStartDocker(): Promise<LocalVmStatus>
  localVmRebuild(assistantId?: string): Promise<LocalVmStatus>
  /** v0.6 多系统虚拟电脑 */
  vmList(): Promise<VmStatus[]>
  vmPreflight(os: VmOs, assistantId?: string): Promise<VmPreflightResult>
  vmStart(os: VmOs, assistantId?: string, opts?: { forceRebuild?: boolean; config?: Partial<VmUserConfig> }): Promise<VmStatus>
  vmSleep(os: VmOs): Promise<VmStatus>
  vmStop(os: VmOs): Promise<VmStatus>
  vmDelete(os: VmOs, removeData?: boolean): Promise<VmStatus>
  vmOpenInBrowser(os: VmOs): Promise<{ ok: boolean; url?: string; message: string }>
  vmSaveConfig(os: VmOs, config?: Partial<VmUserConfig>): Promise<AppState>
  vmSetActive(os: VmOs | null, assistantId?: string): Promise<AppState>
  vmLogs(os: VmOs): Promise<string>
  /** v0.7 */
  getUsage(): Promise<UsageView>
  saveBudget(b: Partial<BudgetSettings>): Promise<UsageView>
  savePrices(prices: PriceEntry[]): Promise<UsageView>
  resetPrices(): Promise<UsageView>
  clearUsage(): Promise<UsageView>
  resumeBudget(assistantId: string): Promise<void>
  saveGrounding(g: Partial<GroundingSettings> & { apiKey?: string }): Promise<AppState>
  testGrounding(g?: Partial<GroundingSettings> & { apiKey?: string }): Promise<TestResult & { x?: number; y?: number; expected?: { x: number; y: number }; raw?: string; ms?: number; image?: string }>
  computerSenseStatus(): Promise<ComputerSenseStatus>
  previewMarks(): Promise<{ ok: boolean; message: string; image?: string; list?: string; count?: number; engine?: string }>
  /** v0.8 */
  takeover(assistantId: string, reason?: string): Promise<void>
  handback(assistantId: string, note?: string): Promise<void>
  respondAskUser(callId: string, answer: string | null): Promise<void>
  confirmPlan(messageId: string, action: 'confirm' | 'reject' | 'edit', text?: string): Promise<void>
  exportComputerReplay(opts: { runId?: string; format?: 'gif' | 'mp4' }): Promise<{ ok: boolean; path?: string; message: string }>
  startTeach(title: string, assistantId?: string): Promise<{ ok: boolean; id?: string; message: string }>
  stopTeach(saveSkill?: boolean): Promise<{ ok: boolean; id?: string; skillId?: string; message: string; path?: string }>
  recordTeachEvent(ev: { kind: string; x?: number; y?: number; text?: string; key?: string; target?: string; role?: string; name?: string }): Promise<void>
  listExperience(): Promise<{ id: string; app: string; keywords: string[]; summary: string; steps: number; success: boolean; createdAt: number }[]>
  onEvent(cb: (ev: AppEvent) => void): () => void
}

/* ===================== v0.4 连接器 / 技能 / 远程 / 通道 / 编排 ===================== */

export type ConnectorKind = 'email_imap' | 'email_gmail' | 'calendar_google' | 'calendar_ms' | 'slack' | 'telegram'

export interface ConnectorSecretField {
  key: string
  label: string
  secret?: boolean
  placeholder?: string
  help?: string
}

export interface ConnectorPack {
  id: ConnectorKind
  name: string
  description: string
  icon: string
  fields: ConnectorSecretField[]
  docsUrl?: string
}

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectorConfig {
  id: string
  kind: ConnectorKind
  name: string
  enabled: boolean
  /** 非敏感配置 */
  config: Record<string, string>
  /** 敏感字段已加密保存的标记（渲染进程只看 hasSecrets） */
  hasSecrets?: boolean
  status: ConnectorStatus
  error?: string
  lastOkAt?: number
  createdAt: number
}

export interface SkillMeta {
  id: string
  name: string
  description: string
  /** 相对 skills 目录的路径 */
  path: string
  builtin: boolean
  triggers?: string[]
  tools?: string[]
}

export interface WorkflowStep {
  id: string
  title: string
  /** skill:xxx / tool:xxx / prompt */
  kind: 'skill' | 'tool' | 'prompt'
  ref: string
  input?: string
  /** 依赖的前置步骤 id */
  dependsOn?: string[]
}

export interface Workflow {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  createdAt: number
  updatedAt: number
}

export type MachineKind = 'local' | 'remote' | 'virtual'
export type MachineStatus = 'online' | 'offline' | 'busy' | 'error'

export interface LocalVmStatus {
  phase: 'idle' | 'checking' | 'need_docker' | 'need_kvm' | 'building' | 'starting' | 'configuring' | 'installing' | 'ready' | 'sleeping' | 'stopped' | 'error'
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
  /** v0.6：多系统虚拟电脑 */
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

export type VmStatus = LocalVmStatus & { os: VmOs }
export interface VmPreflightResult {
  os: VmOs
  ok: boolean
  summary: string
  items: VmPreflightItem[]
}

export interface MachineInfo {
  id: string
  label: string
  kind: MachineKind
  platform?: string
  status: MachineStatus
  /** 远程：对端地址 ws://host:port */
  url?: string
  lastSeenAt?: number
  error?: string
}

export type ChannelKind = 'telegram' | 'slack' | 'wechat_bridge'

export interface ChannelConfig {
  id: string
  kind: ChannelKind
  name: string
  enabled: boolean
  /** 绑定到哪个助手 */
  assistantId: string
  config: Record<string, string>
  hasSecrets?: boolean
  status: ConnectorStatus
  error?: string
  /** 通道消息默认是否需要批准后才外发 */
  requireApproval: boolean
  createdAt: number
}

export type OrchestratorNodeStatus = 'pending' | 'ready' | 'running' | 'done' | 'error' | 'cancelled' | 'paused'

export interface OrchestratorNode {
  id: string
  title: string
  prompt: string
  status: OrchestratorNodeStatus
  priority: number
  dependsOn: string[]
  attempts: number
  maxAttempts: number
  result?: string
  error?: string
  taskId?: string
  startedAt?: number
  finishedAt?: number
}

export interface OrchestratorJob {
  id: string
  assistantId: string
  title: string
  goal: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  nodes: OrchestratorNode[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/* ===================== v0.7 用量 / 费用 / grounding ===================== */

export interface UsageNumbers {
  input: number
  output: number
  /** 输入中命中缓存的 token */
  cacheHit: number
  /** 推理 token（包含在 output 中） */
  reasoning?: number
  /** 没有拿到服务商 usage，按本地估算 */
  estimated?: boolean
}

export interface PriceTier {
  /** 每 1M 输入 token（缓存未命中） */
  input: number
  /** 每 1M 输入 token（缓存命中）；缺省按 input 计 */
  cacheHit?: number
  /** 每 1M 输出 token */
  output: number
}

export interface PriceEntry {
  id: string
  /** 显示名 */
  label: string
  /** Base URL 包含该子串才匹配（空=任意服务商） */
  provider: string
  /** 模型名：精确或以 * 结尾的前缀通配，多个用逗号分隔 */
  models: string
  currency: 'USD' | 'CNY'
  /** 低谷 / 默认价格 */
  price: PriceTier
  /** 高峰价格与高峰时段（UTC，周一到周五） */
  peak?: PriceTier & { utcHours: [number, number][]; weekdaysOnly?: boolean }
  note?: string
  builtin?: boolean
}

export interface UsageBucket extends UsageNumbers {
  cost: number
  calls: number
  unpricedCalls: number
}

export interface UsageSummary {
  days: Record<string, UsageBucket>
  byModel: Record<string, UsageBucket>
  byAssistant: Record<string, UsageBucket>
  byRoutine: Record<string, UsageBucket>
  byTask: Record<string, UsageBucket>
  total: UsageBucket
}

export interface BudgetSettings {
  /** 单个任务（一轮对话 / 一个后台任务 / 一次定时任务）上限，美元；0 = 不限 */
  perTaskUsd: number
  /** 每天上限，美元；0 = 不限 */
  perDayUsd: number
  /** 单个任务 token 上限（输入+输出）；0 = 不限。适合没有价格的本地模型 */
  perTaskTokens: number
}

/** 一条回复 / 一个任务的用量（含费用，美元） */
export interface MessageUsage extends UsageNumbers {
  cost: number
  /** 是否找到了价格（没找到时 cost=0，界面显示「未定价」） */
  priced: boolean
  model: string
  /** 模型调用次数（一轮里每次工具往返都算一次） */
  calls: number
  /** 是否有调用处于高峰价时段 */
  peak?: boolean
}

export type GroundingPresetId = 'main' | 'uitars15-vllm' | 'uitars15-openrouter' | 'uitars-v1' | 'fara7b' | 'custom'

export interface GroundingSettings {
  /** 关闭时 click_target 只按元素列表匹配 */
  enabled: boolean
  preset: GroundingPresetId
  baseUrl: string
  model: string
  /** 坐标格式：smart_resize（UI-TARS-1.5 / Fara）、relative1000（UI-TARS v1）、pixel（截图像素） */
  coordSpace: 'smart_resize' | 'relative1000' | 'pixel'
  promptStyle: 'uitars' | 'fara' | 'json'
}

export interface UsageView {
  summary: UsageSummary
  days: { day: string; bucket: UsageBucket }[]
  today: UsageBucket
  prices: PriceEntry[]
  budget: BudgetSettings
  /** 当前因预算暂停的助手 */
  paused: { assistantId: string; message: string; at: number }[]
  recent: { at: number; model: string; kind: string; input: number; output: number; cacheHit: number; cost: number; priced: boolean; assistantId?: string; routineId?: string; taskId?: string }[]
}

export interface ComputerSenseStatus {
  /** 无障碍引擎：uia / atspi / none */
  engine: string
  available: boolean
  detail: string
  lastMs?: number
  lastCount?: number
  lastError?: string
}
