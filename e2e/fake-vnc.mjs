/**
 * 测试用 VNC（RFB 3.8）服务器：可选 VNC 密码认证、可选 WebSocket（/websockify，模拟 dockur 的 nginx 反代）。
 * 帧缓冲是一块会响应点击的「桌面」：左上角标题栏、若干按钮；点击按钮会把它变绿，键入的字符会记录下来。
 * 仅用于自动化测试（vitest / e2e），不用于生产。
 */
import net from 'net'
import http from 'http'
import crypto from 'crypto'

function desKey(password) {
  const key = Buffer.alloc(8)
  const pw = Buffer.from(password, 'latin1')
  for (let i = 0; i < 8; i++) {
    const c = i < pw.length ? pw[i] : 0
    let r = 0
    for (let b = 0; b < 8; b++) if (c & (1 << b)) r |= 1 << (7 - b)
    key[i] = r
  }
  return key
}

export function makeDesktop(width, height, buttons) {
  const fb = Buffer.alloc(width * height * 4)
  const fill = (x1, y1, x2, y2, [r, g, b]) => {
    for (let y = Math.max(0, y1); y < Math.min(height, y2); y++)
      for (let x = Math.max(0, x1); x < Math.min(width, x2); x++) {
        const o = (y * width + x) * 4
        fb[o] = b
        fb[o + 1] = g
        fb[o + 2] = r
        fb[o + 3] = 255
      }
  }
  const draw = (pressed) => {
    fill(0, 0, width, height, [0, 120, 212]) // Windows 蓝色桌面
    fill(0, height - 40, width, height, [32, 32, 32]) // 任务栏
    fill(8, height - 34, 40, height - 6, [255, 255, 255]) // 开始按钮
    fill(width / 2 - 260, 120, width / 2 + 260, 520, [243, 243, 243]) // 窗口
    fill(width / 2 - 260, 120, width / 2 + 260, 152, [255, 255, 255])
    for (const b of buttons) {
      const on = pressed.has(b.name)
      fill(b.x1 - 2, b.y1 - 2, b.x2 + 2, b.y2 + 2, [90, 90, 90])
      fill(b.x1, b.y1, b.x2, b.y2, on ? [22, 163, 74] : [225, 225, 225])
    }
  }
  return { fb, draw, fill }
}

/**
 * startFakeVnc({ width, height, password, websocket, buttons })
 * 返回 { port, events: [{type:'pointer'|'key'|'click', ...}], typed, pressed, close() }
 */
export function startFakeVnc(opts = {}) {
  const width = opts.width || 1024
  const height = opts.height || 768
  const buttons = opts.buttons || [
    { name: 'OK', x1: 412, y1: 420, x2: 512, y2: 460 },
    { name: 'Cancel', x1: 532, y1: 420, x2: 632, y2: 460 }
  ]
  const pressed = new Set()
  const desk = makeDesktop(width, height, buttons)
  desk.draw(pressed)
  const events = []
  const state = { typed: '', clicks: [], lastMask: 0, connections: 0 }
  const sockets = new Set()

  function serve(write, onData, onClose) {
    state.connections++
    let buf = Buffer.alloc(0)
    let stage = 'version'
    let challenge = null
    const pending = []
    write(Buffer.from('RFB 003.008\n', 'latin1'))
    const sendUpdate = () => {
      desk.draw(pressed)
      const head = Buffer.alloc(4 + 12)
      head[0] = 0
      head.writeUInt16BE(1, 2)
      head.writeUInt16BE(0, 4)
      head.writeUInt16BE(0, 6)
      head.writeUInt16BE(width, 8)
      head.writeUInt16BE(height, 10)
      head.writeInt32BE(0, 12)
      write(Buffer.concat([head, desk.fb]))
    }
    onData((d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (stage === 'version') {
          if (buf.length < 12) return
          buf = buf.subarray(12)
          write(opts.password ? Buffer.from([1, 2]) : Buffer.from([1, 1]))
          stage = 'sectype'
        } else if (stage === 'sectype') {
          if (buf.length < 1) return
          const t = buf[0]
          buf = buf.subarray(1)
          if (t === 2) {
            challenge = crypto.randomBytes(16)
            write(challenge)
            stage = 'auth'
          } else {
            write(Buffer.from([0, 0, 0, 0]))
            stage = 'clientinit'
          }
        } else if (stage === 'auth') {
          if (buf.length < 16) return
          const resp = buf.subarray(0, 16)
          buf = buf.subarray(16)
          let exp
          if (opts.desEcb) exp = opts.desEcb(desKey(opts.password), challenge)
          else {
            const c = crypto.createCipheriv('des-ecb', desKey(opts.password), null)
            c.setAutoPadding(false)
            exp = Buffer.concat([c.update(challenge), c.final()])
          }
          if (exp.equals(resp)) {
            write(Buffer.from([0, 0, 0, 0]))
            stage = 'clientinit'
          } else {
            const reason = Buffer.from('Authentication failed')
            const b = Buffer.alloc(8)
            b.writeUInt32BE(1, 0)
            b.writeUInt32BE(reason.length, 4)
            write(Buffer.concat([b, reason]))
            stage = 'dead'
          }
        } else if (stage === 'clientinit') {
          if (buf.length < 1) return
          buf = buf.subarray(1)
          const name = Buffer.from(opts.name || 'Fake QEMU (assistant-desktop-test)')
          const init = Buffer.alloc(24)
          init.writeUInt16BE(width, 0)
          init.writeUInt16BE(height, 2)
          // 服务器原生像素格式：32bpp little endian BGRX
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4)
          init.writeUInt32BE(name.length, 20)
          write(Buffer.concat([init, name]))
          stage = 'normal'
        } else if (stage === 'normal') {
          if (buf.length < 1) return
          const t = buf[0]
          let need = 0
          if (t === 0) need = 20
          else if (t === 2) {
            if (buf.length < 4) return
            need = 4 + buf.readUInt16BE(2) * 4
          } else if (t === 3) need = 10
          else if (t === 4) need = 8
          else if (t === 5) need = 6
          else if (t === 6) {
            if (buf.length < 8) return
            need = 8 + buf.readUInt32BE(4)
          } else {
            stage = 'dead'
            return
          }
          if (buf.length < need) return
          const m = buf.subarray(0, need)
          buf = buf.subarray(need)
          if (t === 3) sendUpdate()
          else if (t === 4) {
            const down = m[1] === 1
            const ks = m.readUInt32BE(4)
            events.push({ type: 'key', down, keysym: ks })
            if (down && ks >= 0x20 && ks <= 0x7e) state.typed += String.fromCharCode(ks)
            if (down && ks === 0xff0d) state.typed += '\n'
          } else if (t === 5) {
            const mask = m[1]
            const x = m.readUInt16BE(2)
            const y = m.readUInt16BE(4)
            events.push({ type: 'pointer', mask, x, y })
            if ((state.lastMask & 1) === 0 && (mask & 1) === 1) {
              state.clicks.push({ x, y })
              const hit = buttons.find((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2)
              events.push({ type: 'click', x, y, button: hit?.name || null })
              if (hit) pressed.add(hit.name)
            }
            state.lastMask = mask
          }
        } else return
      }
    })
    onClose(() => {})
    void pending
  }

  let server
  if (opts.websocket) {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body>fake dockur web viewer</body></html>')
    })
    server.on('upgrade', (req, sock) => {
      sockets.add(sock)
      const key = req.headers['sec-websocket-key']
      if (!String(req.url || '').startsWith('/websockify') || !key) {
        sock.destroy()
        return
      }
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      const proto = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((s) => s.trim())
        .includes('binary')
        ? 'Sec-WebSocket-Protocol: binary\r\n'
        : ''
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`)
      const write = (payload) => {
        const len = payload.length
        let head
        if (len < 126) head = Buffer.from([0x82, len])
        else if (len < 65536) {
          head = Buffer.alloc(4)
          head[0] = 0x82
          head[1] = 126
          head.writeUInt16BE(len, 2)
        } else {
          head = Buffer.alloc(10)
          head[0] = 0x82
          head[1] = 127
          head.writeUInt32BE(0, 2)
          head.writeUInt32BE(len, 6)
        }
        sock.write(Buffer.concat([head, payload]))
      }
      let wbuf = Buffer.alloc(0)
      let dataCb = () => {}
      sock.on('data', (d) => {
        wbuf = Buffer.concat([wbuf, d])
        for (;;) {
          if (wbuf.length < 2) return
          const op = wbuf[0] & 15
          const masked = (wbuf[1] & 128) !== 0
          let len = wbuf[1] & 127
          let off = 2
          if (len === 126) {
            if (wbuf.length < 4) return
            len = wbuf.readUInt16BE(2)
            off = 4
          } else if (len === 127) {
            if (wbuf.length < 10) return
            len = wbuf.readUInt32BE(6)
            off = 10
          }
          const mlen = masked ? 4 : 0
          if (wbuf.length < off + mlen + len) return
          const mask = masked ? wbuf.subarray(off, off + 4) : null
          const p = Buffer.from(wbuf.subarray(off + mlen, off + mlen + len))
          if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3]
          wbuf = wbuf.subarray(off + mlen + len)
          if (op === 8) {
            sock.end()
            return
          }
          if (op === 9) {
            sock.write(Buffer.from([0x8a, 0]))
            continue
          }
          if (op === 2 || op === 0) dataCb(p)
        }
      })
      serve(write, (cb) => (dataCb = cb), (cb) => sock.on('close', cb))
    })
  } else {
    server = net.createServer((sock) => {
      sockets.add(sock)
      serve((b) => sock.write(b), (cb) => sock.on('data', cb), (cb) => sock.on('close', cb))
    })
  }
  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        events,
        state,
        pressed,
        buttons,
        width,
        height,
        /** 当前帧缓冲（RGBA，便于测试保存截图） */
        rgba: () => {
          desk.draw(pressed)
          const out = Buffer.alloc(width * height * 4)
          for (let i = 0; i < width * height; i++) {
            out[i * 4] = desk.fb[i * 4 + 2]
            out[i * 4 + 1] = desk.fb[i * 4 + 1]
            out[i * 4 + 2] = desk.fb[i * 4]
            out[i * 4 + 3] = 255
          }
          return out
        },
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          })
      })
    })
  })
}

// 命令行：node e2e/fake-vnc.mjs [port] [ws]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 0)
  startFakeVnc({ port, websocket: process.argv[3] === 'ws' }).then((s) => console.log('fake vnc on', s.port))
}
