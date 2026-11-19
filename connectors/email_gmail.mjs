import { startMcp, env, httpJson } from './_mcp.mjs'
async function token() {
  const body = new URLSearchParams({ client_id: env('clientId'), client_secret: env('clientSecret'), refresh_token: env('refreshToken'), grant_type: 'refresh_token' })
  const j = await httpJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  return j.access_token
}
startMcp({
  name: 'gmail',
  tools: [
    { name: 'gmail_list', description: '列出最近邮件', inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } } },
    { name: 'gmail_send', description: '发送邮件', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } }
  ],
  async call(name, args) {
    const t = await token()
    const h = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
    if (name === 'gmail_list') {
      const j = await httpJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${args.max || 10}&q=${encodeURIComponent(args.q || '')}`, { headers: h })
      const lines = []
      for (const m of j.messages || []) {
        const d = await httpJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: h })
        const hdr = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name, x.value]))
        lines.push(`${hdr.Date || ''} | ${hdr.From || ''} | ${hdr.Subject || d.snippet}`)
      }
      return lines.join('\n') || '(无邮件)'
    }
    if (name === 'gmail_send') {
      const raw = Buffer.from(`To: ${args.to}\r\nFrom: ${env('email')}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`).toString('base64url')
      const j = await httpJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: h, body: JSON.stringify({ raw }) })
      return `已发送 id=${j.id}`
    }
    throw new Error('未知工具')
  }
})
