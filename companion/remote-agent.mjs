#!/usr/bin/env node
/**
 * AssistantDesktop 远程电脑伴侣（独立进程，可拷到另一台 Windows/Linux 电脑运行）
 * 用法：ASSISTANT_REMOTE_TOKEN=secret node remote-agent.mjs [port]
 * 然后在主应用「机器」里添加 ws://该电脑IP:端口 与相同口令。
 *
 * 注意：此精简伴侣仅做连通与口令校验演示；完整键鼠/截屏需在装有 AssistantDesktop 的机器上
 * 开启「作为远程伴侣」或使用主程序内置服务。
 */
import http from 'http'
import crypto from 'crypto'
const PORT = Number(process.argv[2] || process.env.PORT || 8787)
const TOKEN = process.env.ASSISTANT_REMOTE_TOKEN || ''
if (!TOKEN) {
  console.error('请设置环境变量 ASSISTANT_REMOTE_TOKEN')
  process.exit(1)
}
const accept = (k) => crypto.createHash('sha1').update(k + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
const server = http.createServer((_q, r) => {
  r.end('AssistantDesktop companion stub. Use WebSocket + auth.\n')
})
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\n\r\n`)
  let buf = Buffer.alloc(0), authed = false
  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj))
    const h = Buffer.from([0x81, payload.length])
    socket.write(Buffer.concat([h, payload]))
  }
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    // 极简：假设小帧
    if (buf.length < 2) return
    const masked = !!(buf[1] & 0x80)
    let len = buf[1] & 0x7f, off = 2
    if (len === 126) { len = buf.readUInt16BE(2); off = 4 }
    if (buf.length < off + (masked ? 4 : 0) + len) return
    let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len)
    if (masked) {
      const mask = buf.subarray(off, off + 4)
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
    }
    buf = Buffer.alloc(0)
    let msg; try { msg = JSON.parse(payload.toString()) } catch { return }
    if (!authed) {
      if (msg.type === 'auth' && msg.token === TOKEN) {
        authed = true
        send({ type: 'auth_ok', id: 'companion', label: require('os').hostname(), platform: process.platform })
        console.log('client authenticated')
      } else send({ type: 'auth_fail', error: '口令错误' })
      return
    }
    if (msg.type === 'call') {
      // stub：无真实键鼠，返回说明
      send({ type: 'result', id: msg.id, ok: false, error: '此独立伴侣为连通性 stub。请在目标电脑运行完整 AssistantDesktop 并开启「作为远程伴侣」以提供截屏与键鼠。' })
    }
  })
})
server.listen(PORT, '0.0.0.0', () => console.log(`Remote companion listening on :${PORT}`))
