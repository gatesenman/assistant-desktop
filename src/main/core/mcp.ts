import { spawn, type ChildProcess } from 'child_process'
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '../../shared/types'
import type { ToolDef } from './llm'
import type { ToolResult } from './browser'
import { truncate } from './util'

/** MCP 协议版本（客户端首选） */
export const MCP_PROTOCOL_VERSION = '2025-03-26'

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

interface Transport {
  onMessage: (m: JsonRpcMessage) => void
  onClose: (reason: string) => void
  start(): Promise<void>
  send(m: JsonRpcMessage): Promise<void>
  close(): Promise<void>
}

/** stdio 传输：每行一个 JSON-RPC 消息 */
export class StdioTransport implements Transport {
  onMessage: (m: JsonRpcMessage) => void = () => {}
  onClose: (reason: string) => void = () => {}
  private child: ChildProcess | null = null
  private stderr = ''
  private closed = false

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
    private cwd?: string
  ) {}

  async start(): Promise<void> {
    const isWin = process.platform === 'win32'
    const child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWin // Windows 下允许 npx/uvx 等 .cmd
    })
    this.child = child
    let buf = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          this.onMessage(JSON.parse(line))
        } catch {
          /* 非 JSON 输出（日志）忽略 */
        }
      }
    })
    child.stderr!.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', (e) => reject(new Error(`无法启动 MCP 进程：${e.message}`)))
      child.once('spawn', () => resolve())
    })
    child.on('exit', (code, sig) => {
      if (this.closed) return
      this.closed = true
      this.onClose(`进程已退出（code=${code ?? sig}）${this.stderr ? '\n' + this.stderr.trim().slice(-800) : ''}`)
    })
  }

  async send(m: JsonRpcMessage): Promise<void> {
    if (!this.child?.stdin?.writable) throw new Error('MCP 进程不可写')
    this.child.stdin.write(JSON.stringify(m) + '\n')
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      this.child?.stdin?.end()
      this.child?.kill()
    } catch {
      /* ignore */
    }
  }
}

/** Streamable HTTP 传输：POST JSON-RPC，响应为 JSON 或 SSE */
export class HttpTransport implements Transport {
  onMessage: (m: JsonRpcMessage) => void = () => {}
  onClose: (reason: string) => void = () => {}
  private sessionId: string | null = null
  protocolVersion: string | null = null

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private fetchImpl: typeof fetch = fetch
  ) {}

  async start(): Promise<void> {}

  async send(m: JsonRpcMessage): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion
    const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(m) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 202 || res.status === 204) return
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`MCP HTTP ${res.status}: ${t.slice(0, 300)}`)
    }
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/event-stream') && res.body) {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const dec = new TextDecoder()
      let buf = ''
      let data: string[] = []
      const flush = (): void => {
        if (data.length) {
          try {
            this.dispatch(JSON.parse(data.join('\n')))
          } catch {
            /* ignore */
          }
        }
        data = []
      }
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        buf += dec.decode(r.value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line === '') flush()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
      }
      flush()
    } else {
      const text = await res.text()
      if (text.trim()) this.dispatch(JSON.parse(text))
    }
  }

  private dispatch(v: JsonRpcMessage | JsonRpcMessage[]): void {
    if (Array.isArray(v)) v.forEach((x) => this.onMessage(x))
    else this.onMessage(v)
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    try {
      await this.fetchImpl(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, ...this.headers } })
    } catch {
      /* ignore */
    }
  }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** 最小 MCP 客户端：initialize / tools/list / tools/call */
export class McpClient {
  private nextId = 1
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  serverInfo: any = null
  onClose: (reason: string) => void = () => {}

  constructor(private transport: Transport) {
    transport.onMessage = (m) => this.handle(m)
    transport.onClose = (reason) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
      }
      this.pending.clear()
      this.onClose(reason)
    }
  }

  private handle(m: JsonRpcMessage): void {
    if (m.id !== undefined && m.id !== null && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(new Error(`MCP 错误 ${m.error.code}: ${m.error.message}`))
      else p.resolve(m.result)
      return
    }
    if (m.method && m.id !== undefined && m.id !== null) {
      // 服务器 → 客户端请求（如 ping）
      const reply: JsonRpcMessage =
        m.method === 'ping'
          ? { jsonrpc: '2.0', id: m.id, result: {} }
          : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `不支持的方法 ${m.method}` } }
      void this.transport.send(reply).catch(() => {})
    }
  }

  request(method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      })
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  async connect(): Promise<void> {
    await this.transport.start()
    const r = await this.request(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'assistant-desktop', version: '0.2.0' } },
      30000
    )
    this.serverInfo = r?.serverInfo
    if (this.transport instanceof HttpTransport) this.transport.protocolVersion = r?.protocolVersion || MCP_PROTOCOL_VERSION
    await this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {})
      tools.push(...(r?.tools || []))
      cursor = r?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120000): Promise<ToolResult> {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs)
    const texts: string[] = []
    const images: string[] = []
    for (const c of r?.content || []) {
      if (c.type === 'text') texts.push(c.text)
      else if (c.type === 'image' && c.data) images.push(`data:${c.mimeType || 'image/png'};base64,${c.data}`)
      else if (c.type === 'resource') texts.push(c.resource?.text ?? `[资源] ${c.resource?.uri ?? ''}`)
      else texts.push(JSON.stringify(c))
    }
    if (!texts.length && r?.structuredContent) texts.push(JSON.stringify(r.structuredContent))
    const text = truncate(texts.join('\n') || '(无文本输出)', 50000)
    if (r?.isError) throw new Error(text)
    return { text, images: images.length ? images : undefined }
  }

  close(): Promise<void> {
    return this.transport.close()
  }
}

export function slugify(name: string, id: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
  return s || 's' + id.replace(/[^a-z0-9]/gi, '').slice(0, 6)
}

export function exposedToolName(slug: string, tool: string): string {
  return `mcp__${slug}__${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64)
}

interface Conn {
  cfg: McpServerConfig
  client: McpClient | null
  status: McpServerStatus
  tools: McpTool[]
}

/** 管理所有 MCP 连接，并把工具以命名空间名称暴露给模型 */
export class McpManager {
  private conns = new Map<string, Conn>()
  private nameMap = new Map<string, { serverId: string; tool: string }>()

  constructor(
    private onStatus: (statuses: McpServerStatus[]) => void,
    private createTransport: (cfg: McpServerConfig) => Transport = (cfg) =>
      cfg.type === 'http' ? new HttpTransport(cfg.url, cfg.headers || {}) : new StdioTransport(cfg.command, cfg.args || [], cfg.env || {})
  ) {}

  statuses(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => c.status)
  }

  private emit(): void {
    this.rebuildNames()
    this.onStatus(this.statuses())
  }

  private rebuildNames(): void {
    this.nameMap.clear()
    const used = new Set<string>()
    for (const c of this.conns.values()) {
      let slug = slugify(c.cfg.name, c.cfg.id)
      if (used.has(slug)) slug = `${slug}_${c.cfg.id.replace(/[^a-z0-9]/gi, '').slice(0, 4)}`
      used.add(slug)
      c.status.tools = c.tools.map((t) => {
        const exposedName = exposedToolName(slug, t.name)
        this.nameMap.set(exposedName, { serverId: c.cfg.id, tool: t.name })
        return { name: t.name, description: t.description, exposedName }
      })
    }
  }

  /** 根据配置同步连接（新增/删除/启用/停用） */
  async sync(configs: McpServerConfig[]): Promise<void> {
    const ids = new Set(configs.map((c) => c.id))
    for (const [id, c] of this.conns) {
      if (!ids.has(id)) {
        await c.client?.close()
        this.conns.delete(id)
      }
    }
    const jobs: Promise<void>[] = []
    for (const cfg of configs) {
      const c = this.conns.get(cfg.id)
      const changed = c && JSON.stringify(transportKey(c.cfg)) !== JSON.stringify(transportKey(cfg))
      if (c) c.cfg = cfg
      if (!cfg.enabled) {
        if (c?.client) await c.client.close()
        this.conns.set(cfg.id, { cfg, client: null, tools: [], status: { id: cfg.id, status: 'disconnected', tools: [] } })
      } else if (!c || changed || c.status.status === 'disconnected') {
        jobs.push(this.connect(cfg))
      }
    }
    this.emit()
    await Promise.all(jobs)
  }

  async connect(cfg: McpServerConfig): Promise<void> {
    const old = this.conns.get(cfg.id)
    if (old?.client) await old.client.close().catch(() => {})
    const conn: Conn = { cfg, client: null, tools: [], status: { id: cfg.id, status: 'connecting', tools: [] } }
    this.conns.set(cfg.id, conn)
    this.emit()
    try {
      const client = new McpClient(this.createTransport(cfg))
      client.onClose = (reason) => {
        if (this.conns.get(cfg.id) !== conn) return
        conn.client = null
        conn.tools = []
        conn.status = { id: cfg.id, status: 'error', error: reason, tools: [] }
        this.emit()
      }
      await client.connect()
      conn.client = client
      conn.tools = await client.listTools()
      conn.status = { id: cfg.id, status: 'connected', tools: [] }
    } catch (e: any) {
      conn.status = { id: cfg.id, status: 'error', error: e?.message || String(e), tools: [] }
    }
    if (this.conns.get(cfg.id) === conn) this.emit()
  }

  toolDefs(): ToolDef[] {
    const defs: ToolDef[] = []
    for (const c of this.conns.values()) {
      if (!c.cfg.enabled || c.status.status !== 'connected') continue
      for (const t of c.tools) {
        if (c.cfg.disabledTools?.includes(t.name)) continue
        const info = c.status.tools.find((x) => x.name === t.name)
        if (!info) continue
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : {}
        if (!schema.type) schema.type = 'object'
        if (schema.type === 'object' && !schema.properties) schema.properties = {}
        defs.push({
          type: 'function',
          function: { name: info.exposedName, description: `[MCP:${c.cfg.name}] ${t.description || t.name}`.slice(0, 1000), parameters: schema }
        })
      }
    }
    return defs
  }

  resolve(exposedName: string): { cfg: McpServerConfig; tool: string } | null {
    const m = this.nameMap.get(exposedName)
    if (!m) return null
    const c = this.conns.get(m.serverId)
    return c ? { cfg: c.cfg, tool: m.tool } : null
  }

  async call(exposedName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const m = this.nameMap.get(exposedName)
    if (!m) throw new Error(`未知 MCP 工具：${exposedName}`)
    const c = this.conns.get(m.serverId)
    if (!c?.client) throw new Error(`MCP 服务器「${c?.cfg.name ?? m.serverId}」未连接`)
    if (c.cfg.disabledTools?.includes(m.tool)) throw new Error('该工具已被禁用')
    return c.client.callTool(m.tool, args)
  }

  async closeAll(): Promise<void> {
    for (const c of this.conns.values()) await c.client?.close().catch(() => {})
    this.conns.clear()
  }
}

function transportKey(c: McpServerConfig): unknown {
  return c.type === 'http' ? [c.type, c.url, c.headers] : [c.type, c.command, c.args, c.env]
}
