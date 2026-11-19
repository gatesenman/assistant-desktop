/**
 * 消息通道：Telegram（长轮询）、Slack（events 需公网，这里用 RTM 简化为主动拉取 + 发送）、
 * 微信本地桥（HTTP webhook stub，用户自己用其他工具把消息 POST 进来）。
 */
import http from 'http'
import { EventEmitter } from 'events'
import type { ChannelConfig } from '../../shared/types'
import type { SecretCodec } from './secrets'
import fs from 'fs'
import path from 'path'

export interface InboundMessage {
  channelId: string
  chatKey: string
  text: string
  sender?: string
  raw?: unknown
}

export interface OutboundDraft {
  id: string
  channelId: string
  chatKey: string
  text: string
  createdAt: number
}

export class ChannelSecrets {
  constructor(private dir: string, private codec: SecretCodec) {
    fs.mkdirSync(dir, { recursive: true })
  }
  private f(id: string): string {
    return path.join(this.dir, id + '.json')
  }
  save(id: string, secrets: Record<string, string>): void {
    const enc: Record<string, string> = {}
    for (const [k, v] of Object.entries(secrets)) if (v) enc[k] = this.codec.encrypt(v)
    fs.writeFileSync(this.f(id), JSON.stringify(enc))
  }
  load(id: string): Record<string, string> {
    try {
      const enc = JSON.parse(fs.readFileSync(this.f(id), 'utf8'))
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(enc)) out[k] = this.codec.decrypt(v as string)
      return out
    } catch {
      return {}
    }
  }
  remove(id: string): void {
    try {
      fs.unlinkSync(this.f(id))
    } catch {
      /* */
    }
  }
  has(id: string): boolean {
    return fs.existsSync(this.f(id))
  }
}

export class ChannelHub extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>()
  private offsets = new Map<string, number>()
  private drafts = new Map<string, OutboundDraft>()
  private bridge: http.Server | null = null
  private bridgePort = 0

  constructor(
    private secrets: ChannelSecrets,
    private fetchImpl: typeof fetch = fetch
  ) {
    super()
  }

  getDraft(id: string): OutboundDraft | undefined {
    return this.drafts.get(id)
  }

  /** 启动/刷新所有已启用通道 */
  async sync(channels: ChannelConfig[]): Promise<void> {
    const enabled = new Set(channels.filter((c) => c.enabled).map((c) => c.id))
    for (const [id, t] of this.timers) {
      if (!enabled.has(id)) {
        clearInterval(t)
        this.timers.delete(id)
      }
    }
    for (const c of channels) {
      if (!c.enabled) continue
      if (c.kind === 'telegram' && !this.timers.has(c.id)) this.startTelegram(c)
      if (c.kind === 'slack' && !this.timers.has(c.id)) this.startSlackPoll(c)
      if (c.kind === 'wechat_bridge') await this.ensureBridge()
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearInterval(t)
    this.timers.clear()
    this.bridge?.close()
    this.bridge = null
  }

  private startTelegram(c: ChannelConfig): void {
    const tick = async (): Promise<void> => {
      try {
        const token = this.secrets.load(c.id).botToken || c.config.botToken
        if (!token) return
        const offset = this.offsets.get(c.id) || 0
        const r = await this.fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}`)
        const j = (await r.json()) as any
        if (!j.ok) throw new Error(j.description || 'getUpdates 失败')
        for (const u of j.result || []) {
          this.offsets.set(c.id, u.update_id + 1)
          const m = u.message
          if (!m?.text) continue
          this.emit('message', {
            channelId: c.id,
            chatKey: String(m.chat.id),
            text: m.text,
            sender: m.from?.username || m.from?.first_name,
            raw: m
          } satisfies InboundMessage)
        }
      } catch (e: any) {
        this.emit('error', c.id, e?.message || String(e))
      }
    }
    void tick()
    this.timers.set(c.id, setInterval(() => void tick(), 3000))
  }

  /** Slack：无公网 URL 时用 conversations.history 轮询默认频道（简化） */
  private startSlackPoll(c: ChannelConfig): void {
    const seen = new Set<string>()
    const tick = async (): Promise<void> => {
      try {
        const token = this.secrets.load(c.id).botToken || c.config.botToken
        const channel = c.config.defaultChannel || c.config.channelId
        if (!token || !channel) return
        // 若是 #name，尝试 conversations.list 解析（缓存到 config 由用户填 channelId 更稳）
        let ch = channel
        if (ch.startsWith('#')) {
          const list = (await (await this.fetchImpl('https://slack.com/api/conversations.list?limit=200', { headers: { Authorization: `Bearer ${token}` } })).json()) as any
          const found = (list.channels || []).find((x: any) => x.name === ch.slice(1))
          if (found) ch = found.id
        }
        const j = (await (
          await this.fetchImpl(`https://slack.com/api/conversations.history?channel=${ch}&limit=5`, { headers: { Authorization: `Bearer ${token}` } })
        ).json()) as any
        if (!j.ok) throw new Error(j.error)
        for (const m of [...(j.messages || [])].reverse()) {
          if (!m.text || m.bot_id || seen.has(m.ts)) continue
          seen.add(m.ts)
          if (seen.size > 200) seen.clear()
          this.emit('message', { channelId: c.id, chatKey: ch, text: m.text, sender: m.user, raw: m } satisfies InboundMessage)
        }
      } catch (e: any) {
        this.emit('error', c.id, e?.message || String(e))
      }
    }
    void tick()
    this.timers.set(c.id, setInterval(() => void tick(), 5000))
  }

  async ensureBridge(port = 8791): Promise<number> {
    if (this.bridge) return this.bridgePort
    this.bridge = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200)
        return res.end('ok')
      }
      if (req.method === 'POST' && (req.url === '/wechat' || req.url?.startsWith('/wechat?'))) {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        let body: any = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          body = { text: Buffer.concat(chunks).toString('utf8') }
        }
        const channelId = String(body.channelId || 'wechat-bridge')
        const text = String(body.text || body.Content || '')
        const chatKey = String(body.chatKey || body.FromUserName || 'wechat')
        if (text) this.emit('message', { channelId, chatKey, text, sender: body.sender, raw: body } satisfies InboundMessage)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      res.writeHead(404)
      res.end('POST /wechat  JSON {channelId,chatKey,text}')
    })
    await new Promise<void>((resolve, reject) => {
      const tryListen = (p: number, left: number): void => {
        const onErr = (e: NodeJS.ErrnoException): void => {
          this.bridge?.off('listening', onOk)
          if (e.code === 'EADDRINUSE' && left > 0) {
            this.bridge?.removeAllListeners('error')
            tryListen(p + 1, left - 1)
          } else reject(e)
        }
        const onOk = (): void => {
          this.bridge?.off('error', onErr)
          resolve()
        }
        this.bridge!.once('error', onErr)
        this.bridge!.once('listening', onOk)
        this.bridge!.listen(p, '127.0.0.1')
      }
      tryListen(port, 30)
    })
    this.bridgePort = (this.bridge.address() as any).port
    return this.bridgePort
  }

  get wechatBridgePort(): number {
    return this.bridgePort
  }

  /** 发送：若通道要求审批则进入草稿队列 */
  async send(c: ChannelConfig, chatKey: string, text: string, opts: { force?: boolean; trusted?: boolean } = {}): Promise<{ sent: boolean; draftId?: string; detail?: string }> {
    if (c.requireApproval && !opts.force && !opts.trusted) {
      const id = 'draft-' + Date.now().toString(36)
      this.drafts.set(id, { id, channelId: c.id, chatKey, text, createdAt: Date.now() })
      this.emit('draft', this.drafts.get(id))
      return { sent: false, draftId: id, detail: '已生成外发草稿，等待批准' }
    }
    return { sent: true, detail: await this.deliver(c, chatKey, text) }
  }

  async respondDraft(draftId: string, approved: boolean): Promise<string> {
    const d = this.drafts.get(draftId)
    if (!d) throw new Error('草稿不存在')
    this.drafts.delete(draftId)
    if (!approved) return '已拒绝发送'
    // 调用方需提供 channel 配置；这里返回特殊标记由上层处理
    return JSON.stringify({ __send: d })
  }

  async deliver(c: ChannelConfig, chatKey: string, text: string): Promise<string> {
    const sec = this.secrets.load(c.id)
    if (c.kind === 'telegram') {
      const token = sec.botToken || c.config.botToken
      const r = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatKey, text })
      })
      const j = (await r.json()) as any
      if (!j.ok) throw new Error(j.description || '发送失败')
      return `Telegram 已发送 message_id=${j.result.message_id}`
    }
    if (c.kind === 'slack') {
      const token = sec.botToken || c.config.botToken
      const r = await this.fetchImpl('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: chatKey, text })
      })
      const j = (await r.json()) as any
      if (!j.ok) throw new Error(j.error || '发送失败')
      return `Slack 已发送 ts=${j.ts}`
    }
    if (c.kind === 'wechat_bridge') {
      // DIY：把出站消息写到 userData 队列，供外部桥读取
      this.emit('wechat-out', { chatKey, text, at: Date.now() })
      return '已写入微信桥出站队列（需外部 DIY 桥拉取）'
    }
    throw new Error('未知通道类型')
  }
}
