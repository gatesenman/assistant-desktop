import { startMcp, env, httpJson } from './_mcp.mjs'
const token = () => env('botToken')
const auth = () => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' })
startMcp({
  name: 'slack-connector',
  tools: [
    { name: 'slack_post_message', description: '向 Slack 频道发送消息', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
    { name: 'slack_list_channels', description: '列出可见频道', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'slack_search', description: '搜索消息（需要 search:read）', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }
  ],
  async call(name, args) {
    if (!token()) return { __error: true, message: '未配置 botToken' }
    if (name === 'slack_post_message') {
      const j = await httpJson('https://slack.com/api/chat.postMessage', { method: 'POST', headers: auth(), body: JSON.stringify({ channel: args.channel || env('defaultChannel'), text: args.text }) })
      if (!j.ok) throw new Error(j.error)
      return `已发送到 ${j.channel}（ts=${j.ts}）`
    }
    if (name === 'slack_list_channels') {
      const j = await httpJson('https://slack.com/api/conversations.list?limit=' + (args.limit || 50), { headers: auth() })
      if (!j.ok) throw new Error(j.error)
      return (j.channels || []).map((c) => `#${c.name} (${c.id})`).join('\n') || '(无频道)'
    }
    if (name === 'slack_search') {
      const j = await httpJson('https://slack.com/api/search.messages?query=' + encodeURIComponent(args.query), { headers: auth() })
      if (!j.ok) throw new Error(j.error)
      return (j.messages?.matches || []).slice(0, 10).map((m) => `[${m.username}] ${m.text}`).join('\n') || '(无结果)'
    }
    throw new Error('未知工具')
  }
})
