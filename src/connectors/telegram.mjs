import { startMcp, env, httpJson } from './_mcp.mjs'
const token = () => env('botToken')
const api = (m, body) => httpJson(`https://api.telegram.org/bot${token()}/${m}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
startMcp({
  name: 'telegram-connector',
  tools: [
    { name: 'telegram_send', description: '向 Telegram chat_id 发送文本', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } },
    { name: 'telegram_get_me', description: '查看 Bot 信息', inputSchema: { type: 'object', properties: {} } }
  ],
  async call(name, args) {
    if (!token()) return { __error: true, message: '未配置 botToken' }
    if (name === 'telegram_get_me') { const j = await api('getMe'); return j.result }
    if (name === 'telegram_send') { const j = await api('sendMessage', { chat_id: args.chat_id, text: args.text }); return `已发送 message_id=${j.result?.message_id}` }
    throw new Error('未知工具')
  }
})
