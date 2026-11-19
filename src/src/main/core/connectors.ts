import type { ConnectorConfig, ConnectorPack, TestResult } from '../../shared/types'
import type { SecretCodec } from './secrets'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

export const CONNECTOR_PACKS: ConnectorPack[] = [
  {
    id: 'email_imap',
    name: '邮箱（IMAP / SMTP）',
    description: '用邮箱账号密码或应用专用密码收发邮件。适合网易、QQ、企业邮箱等。',
    icon: 'mail-line',
    fields: [
      { key: 'email', label: '邮箱地址', placeholder: 'you@example.com' },
      { key: 'password', label: '密码 / 应用专用密码', secret: true },
      { key: 'imapHost', label: 'IMAP 主机', placeholder: 'imap.example.com' },
      { key: 'imapPort', label: 'IMAP 端口', placeholder: '993' },
      { key: 'smtpHost', label: 'SMTP 主机', placeholder: 'smtp.example.com' },
      { key: 'smtpPort', label: 'SMTP 端口', placeholder: '465' }
    ]
  },
  {
    id: 'email_gmail',
    name: 'Gmail（OAuth 刷新令牌）',
    description: '粘贴 Google OAuth 客户端与 refresh_token。可用 gmail.googleapis.com。',
    icon: 'google-line',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true },
      { key: 'email', label: '邮箱地址', placeholder: 'you@gmail.com' }
    ],
    docsUrl: 'https://developers.google.com/gmail/api/quickstart'
  },
  {
    id: 'calendar_google',
    name: 'Google 日历',
    description: '用 OAuth 刷新令牌读写 Google Calendar。',
    icon: 'calendar-line',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true },
      { key: 'calendarId', label: '日历 ID', placeholder: 'primary' }
    ]
  },
  {
    id: 'calendar_ms',
    name: 'Microsoft 日历',
    description: '用 Azure 应用与 refresh_token 访问 Outlook 日历（Graph API）。',
    icon: 'calendar-check-line',
    fields: [
      { key: 'tenantId', label: 'Tenant ID', placeholder: 'common' },
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true }
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Bot User OAuth Token（xoxb-…），可发消息、列频道、搜历史。',
    icon: 'slack-line',
    fields: [
      { key: 'botToken', label: 'Bot Token', secret: true, placeholder: 'xoxb-…' },
      { key: 'defaultChannel', label: '默认频道', placeholder: '#general' }
    ]
  },
  {
    id: 'telegram',
    name: 'Telegram Bot',
    description: '从 @BotFather 获取的 bot token，用于连接器工具与消息通道。',
    icon: 'telegram-line',
    fields: [{ key: 'botToken', label: 'Bot Token', secret: true, placeholder: '123456:ABC…' }]
  }
]

export class ConnectorSecrets {
  constructor(
    private dir: string,
    private codec: SecretCodec
  ) {
    fs.mkdirSync(dir, { recursive: true })
  }
  private file(id: string): string {
    return path.join(this.dir, id + '.json')
  }
  save(id: string, secrets: Record<string, string>): void {
    const enc: Record<string, string> = {}
    for (const [k, v] of Object.entries(secrets)) if (v) enc[k] = this.codec.encrypt(v)
    fs.writeFileSync(this.file(id), JSON.stringify(enc))
  }
  load(id: string): Record<string, string> {
    try {
      const enc = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Record<string, string>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(enc)) out[k] = this.codec.decrypt(v)
      return out
    } catch {
      return {}
    }
  }
  has(id: string): boolean {
    return fs.existsSync(this.file(id))
  }
  remove(id: string): void {
    try {
      fs.unlinkSync(this.file(id))
    } catch {
      /* ignore */
    }
  }
}

/** 把连接器配置转成内置 MCP stdio 服务器配置 */
export function connectorToMcp(
  c: ConnectorConfig,
  secrets: Record<string, string>,
  connectorsRoot: string
): { command: string; args: string[]; env: Record<string, string> } {
  const script = path.join(connectorsRoot, `${c.kind}.mjs`)
  const env: Record<string, string> = { ...c.config, ...secrets, CONNECTOR_KIND: c.kind }
  return { command: process.execPath, args: [script], env }
}

export async function testConnector(kind: string, config: Record<string, string>, secrets: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TestResult> {
  try {
    if (kind === 'slack') {
      const token = secrets.botToken || config.botToken
      if (!token) return { ok: false, message: '缺少 Bot Token' }
      const r = await fetchImpl('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${token}` } })
      const j = (await r.json()) as any
      return j.ok ? { ok: true, message: `已连接 Slack 团队「${j.team}」，用户 ${j.user}` } : { ok: false, message: j.error || '认证失败' }
    }
    if (kind === 'telegram') {
      const token = secrets.botToken || config.botToken
      if (!token) return { ok: false, message: '缺少 Bot Token' }
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`)
      const j = (await r.json()) as any
      return j.ok ? { ok: true, message: `Bot @${j.result.username} 可用` } : { ok: false, message: j.description || '认证失败' }
    }
    if (kind === 'email_imap') {
      const host = config.imapHost
      const port = Number(config.imapPort || 993)
      if (!host || !secrets.password) return { ok: false, message: '请填写 IMAP 主机与密码' }
      // 轻量 TCP 探测（真正登录在 MCP 工具里）
      await new Promise<void>((resolve, reject) => {
        const net = require('net') as typeof import('net')
        const tls = require('tls') as typeof import('tls')
        const sock = port === 993 ? tls.connect({ host, port, servername: host }, () => { sock.end(); resolve() }) : net.connect({ host, port }, () => { sock.end(); resolve() })
        sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('连接超时')) })
        sock.on('error', reject)
      })
      return { ok: true, message: `已连通 ${host}:${port}（账号 ${config.email || '未填'}）` }
    }
    if (kind === 'email_gmail' || kind === 'calendar_google') {
      const { clientId, clientSecret, refreshToken } = { ...config, ...secrets } as any
      if (!clientId || !clientSecret || !refreshToken) return { ok: false, message: '请填写 Client ID / Secret / Refresh Token' }
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
      const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
      const j = (await r.json()) as any
      return j.access_token ? { ok: true, message: 'OAuth 刷新令牌有效，已拿到 access_token' } : { ok: false, message: j.error_description || j.error || '刷新失败' }
    }
    if (kind === 'calendar_ms') {
      const { tenantId = 'common', clientId, clientSecret, refreshToken } = { ...config, ...secrets } as any
      if (!clientId || !clientSecret || !refreshToken) return { ok: false, message: '请填写 Azure 应用与 Refresh Token' }
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
      const r = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
      const j = (await r.json()) as any
      return j.access_token ? { ok: true, message: 'Microsoft OAuth 刷新令牌有效' } : { ok: false, message: j.error_description || j.error || '刷新失败' }
    }
    return { ok: false, message: '未知连接器类型' }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}

/** 生成临时 env 文件供 MCP 子进程使用（避免命令行泄露） */
export function writeEnvFile(dir: string, id: string, env: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, id + '.env.json')
  fs.writeFileSync(f, JSON.stringify(env))
  return f
}

export function spawnProbe(_cmd: string): boolean {
  return true
}
