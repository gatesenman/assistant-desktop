import { startMcp, env, httpJson } from './_mcp.mjs'
async function token() {
  const tenant = env('tenantId', 'common')
  const body = new URLSearchParams({ client_id: env('clientId'), client_secret: env('clientSecret'), refresh_token: env('refreshToken'), grant_type: 'refresh_token', scope: 'https://graph.microsoft.com/.default offline_access' })
  const j = await httpJson(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  return j.access_token
}
startMcp({
  name: 'mscal',
  tools: [
    { name: 'mscal_list', description: '列出 Outlook 即将开始的日程', inputSchema: { type: 'object', properties: { max: { type: 'number' } } } },
    { name: 'mscal_create', description: '创建 Outlook 日程', inputSchema: { type: 'object', properties: { subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'start', 'end'] } }
  ],
  async call(name, args) {
    const t = await token()
    const h = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
    if (name === 'mscal_list') {
      const j = await httpJson(`https://graph.microsoft.com/v1.0/me/calendarview?startdatetime=${encodeURIComponent(new Date().toISOString())}&enddatetime=${encodeURIComponent(new Date(Date.now()+7*864e5).toISOString())}&$top=${args.max || 10}`, { headers: h })
      return (j.value || []).map((e) => `${e.start?.dateTime} — ${e.subject}`).join('\n') || '(无日程)'
    }
    if (name === 'mscal_create') {
      const j = await httpJson('https://graph.microsoft.com/v1.0/me/events', { method: 'POST', headers: h, body: JSON.stringify({ subject: args.subject, body: { contentType: 'text', content: args.body || '' }, start: { dateTime: args.start, timeZone: 'UTC' }, end: { dateTime: args.end, timeZone: 'UTC' } }) })
      return `已创建 ${j.id}`
    }
    throw new Error('未知工具')
  }
})
