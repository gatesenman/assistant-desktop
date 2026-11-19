import { startMcp, env, httpJson } from './_mcp.mjs'
async function token() {
  const body = new URLSearchParams({ client_id: env('clientId'), client_secret: env('clientSecret'), refresh_token: env('refreshToken'), grant_type: 'refresh_token' })
  const j = await httpJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  return j.access_token
}
startMcp({
  name: 'gcal',
  tools: [
    { name: 'gcal_list', description: '列出即将开始的日程', inputSchema: { type: 'object', properties: { max: { type: 'number' } } } },
    { name: 'gcal_create', description: '创建日程（RFC3339 时间）', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] } }
  ],
  async call(name, args) {
    const t = await token()
    const cal = env('calendarId', 'primary')
    const h = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
    if (name === 'gcal_list') {
      const j = await httpJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?maxResults=${args.max || 10}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(new Date().toISOString())}`, { headers: h })
      return (j.items || []).map((e) => `${e.start?.dateTime || e.start?.date} — ${e.summary}`).join('\n') || '(无日程)'
    }
    if (name === 'gcal_create') {
      const j = await httpJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`, { method: 'POST', headers: h, body: JSON.stringify({ summary: args.summary, description: args.description, start: { dateTime: args.start }, end: { dateTime: args.end } }) })
      return `已创建 ${j.htmlLink || j.id}`
    }
    throw new Error('未知工具')
  }
})
