// 极简 MCP stdio 帮助函数（连接器共用）
import readline from 'readline'
export function startMcp({ name, tools, call }) {
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const { id, method, params } = msg
    if (id === undefined) return
    try {
      if (method === 'initialize')
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name, version: '0.4.0' } } })
      if (method === 'notifications/initialized' || method === 'ping') return id != null && send({ jsonrpc: '2.0', id, result: {} })
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } })
      if (method === 'tools/call') {
        const r = await call(params?.name, params?.arguments || {})
        const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !!r?.__error } })
      }
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e?.message || e) }], isError: true } })
    }
  })
}
export const env = (k, d = '') => process.env[k] || d
export async function httpJson(url, opts = {}) {
  const r = await fetch(url, opts)
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch { j = { raw: t } }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${typeof j === 'object' ? JSON.stringify(j).slice(0, 300) : t.slice(0, 300)}`)
  return j
}
