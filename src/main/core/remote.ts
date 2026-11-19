/**
 * 远程电脑控制：本机可开 WebSocket 伴侣服务，也可作为客户端连到另一台已安装伴侣的机器。
 * 协议为 JSON 行：{ type, id?, name?, args?, ok?, result?, error? }
 */
import http from 'http'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import type { MachineInfo } from '../../shared/types'
import type { ComputerDeps, Capture } from './computer'

type Msg = { type: string; id?: string; name?: string; args?: any; ok?: boolean; result?: any; error?: string; label?: string; platform?: string; token?: string }

export interface RemotePeer {
  machine: MachineInfo
  send(m: Msg): void
  close(): void
}

function wsAccept(key: string): string {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}

function decodeFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0xf
  const masked = !!(buf[1] & 0x80)
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    off = 10
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < off + maskLen + len) return null
  let payload = buf.subarray(off + maskLen, off + maskLen + len)
  if (masked) {
    const mask = buf.subarray(off, off + 4)
    payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
  }
  return { opcode, payload, rest: buf.subarray(off + maskLen + len) }
}

function encodeFrame(payload: Buffer, opcode = 1): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) header = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** 本机伴侣服务：把本地 ComputerDeps 暴露给已认证的远程客户端 */
export class RemoteAgentServer extends EventEmitter {
  private server: http.Server | null = null
  private peers = new Map<string, { send: (m: Msg) => void; machine: MachineInfo }>()
  constructor(
    private deps: ComputerDeps,
    private getToken: () => string,
    private label = '本机伴侣'
  ) {
    super()
  }
  get listening(): boolean {
    return !!this.server?.listening
  }
  get port(): number {
    return (this.server?.address() as any)?.port || 0
  }
  async start(port: number): Promise<number> {
    if (this.server) return this.port
    this.server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('AssistantDesktop Remote Agent — 请用 WebSocket 连接并发送 auth。\n')
    })
    this.server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key']
      if (!key) return socket.destroy()
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(String(key))}\r\n\r\n`)
      let buf: Buffer = Buffer.alloc(0) as Buffer
      let authed = false
      let peerId = ''
      const send = (m: Msg): void => {
        try {
          socket.write(encodeFrame(Buffer.from(JSON.stringify(m))))
        } catch {
          /* ignore */
        }
      }
      socket.on('data', async (chunk) => {
        buf = Buffer.from(Buffer.concat([buf, chunk]))
        for (;;) {
          const frame = decodeFrame(buf)
          if (!frame) break
          buf = Buffer.from(frame.rest)
          if (frame.opcode === 8) {
            socket.end()
            break
          }
          if (frame.opcode !== 1) continue
          let msg: Msg
          try {
            msg = JSON.parse(frame.payload.toString('utf8'))
          } catch {
            continue
          }
          if (!authed) {
            if (msg.type === 'auth' && msg.token && msg.token === this.getToken()) {
              authed = true
              peerId = 'peer-' + crypto.randomBytes(4).toString('hex')
              const machine: MachineInfo = { id: peerId, label: msg.label || '远程客户端', kind: 'remote', status: 'online', lastSeenAt: Date.now(), platform: msg.platform }
              this.peers.set(peerId, { send, machine })
              send({ type: 'auth_ok', id: peerId, label: this.label, platform: process.platform })
              this.emit('peer', machine)
            } else send({ type: 'auth_fail', error: '口令错误' })
            continue
          }
          if (msg.type === 'ping') {
            send({ type: 'pong', id: msg.id })
            continue
          }
          if (msg.type === 'call' && msg.name) {
            try {
              const result = await this.handleCall(msg.name, msg.args || {})
              send({ type: 'result', id: msg.id, ok: true, result })
            } catch (e: any) {
              send({ type: 'result', id: msg.id, ok: false, error: e?.message || String(e) })
            }
          }
        }
      })
      socket.on('close', () => {
        if (peerId) {
          this.peers.delete(peerId)
          this.emit('peer-gone', peerId)
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      const tryListen = (p: number, left: number): void => {
        const onErr = (e: NodeJS.ErrnoException): void => {
          this.server?.off('listening', onListen)
          if (e.code === 'EADDRINUSE' && left > 0) tryListen(p + 1, left - 1)
          else reject(e)
        }
        const onListen = (): void => {
          this.server?.off('error', onErr)
          resolve()
        }
        this.server!.once('error', onErr)
        this.server!.once('listening', onListen)
        this.server!.listen(p, '0.0.0.0')
      }
      tryListen(port || 8787, 20)
    })
    return this.port
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) || r())
    this.server = null
    this.peers.clear()
  }
  private async handleCall(name: string, args: any): Promise<any> {
    if (name === 'screenshot') {
      const c = await this.deps.capture()
      return { jpeg: c.jpeg.toString('base64'), thumb: c.thumb.toString('base64'), width: c.width, height: c.height, png: c.png?.toString('base64') }
    }
    if (name === 'windows') return (await this.deps.driver()).windows()
    if (name === 'size') return (await this.deps.driver()).size()
    // 通用：把电脑工具名转发到本地 driver / openApp
    const drv = await this.deps.driver()
    switch (name) {
      case 'move':
        await drv.move(args.x, args.y)
        return 'ok'
      case 'click':
        await drv.click(args.button || 'left', !!args.double)
        return 'ok'
      case 'type':
        await drv.type(String(args.text || ''))
        return 'ok'
      case 'keys':
        await drv.keys(args.keys || [])
        return 'ok'
      case 'scroll':
        await drv.scroll(args.direction || 'down', args.amount || 5)
        return 'ok'
      case 'drag':
        await drv.drag(args.fromX, args.fromY, args.toX, args.toY)
        return 'ok'
      case 'focus':
        return drv.focus(String(args.title || ''))
      case 'openApp':
        return this.deps.openApp(String(args.name || ''), args.args || [])
      case 'openUrl':
        await this.deps.openUrl(String(args.url || ''))
        return 'ok'
      default:
        throw new Error('未知远程调用：' + name)
    }
  }
}

/** 作为客户端连接远程伴侣 */
export class RemoteAgentClient extends EventEmitter {
  private socket: import('net').Socket | null = null
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private buf: Buffer = Buffer.alloc(0) as Buffer
  machine: MachineInfo
  constructor(
    private url: string,
    private token: string,
    label?: string
  ) {
    super()
    const u = new URL(url)
    this.machine = { id: 'pending', label: label || u.host, kind: 'remote', status: 'offline', url }
  }
  async connect(): Promise<MachineInfo> {
    const u = new URL(this.url)
    const net = await import('net')
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 8787) })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let httpBuf = Buffer.alloc(0)
      const timer = setTimeout(() => reject(new Error('连接超时')), 10000)
      socket.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      socket.once('connect', () => {
        const key = crypto.randomBytes(16).toString('base64')
        socket.write(
          'GET / HTTP/1.1\r\nHost: ' +
            u.host +
            '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
            key +
            '\r\nSec-WebSocket-Version: 13\r\n\r\n'
        )
      })
      const onHttp = (chunk: Buffer): void => {
        httpBuf = Buffer.concat([httpBuf, chunk])
        const sep = Buffer.from('\r\n\r\n')
        const idx = httpBuf.indexOf(sep)
        if (idx < 0) return
        const head = httpBuf.subarray(0, idx).toString('utf8')
        const rest = httpBuf.subarray(idx + 4)
        socket.off('data', onHttp)
        if (!head.includes('101')) {
          clearTimeout(timer)
          reject(new Error('WebSocket 握手失败: ' + head.split('\r\n')[0]))
          return
        }
        socket.on('data', (c) => this.onFrames(c))
        if (rest.length) this.onFrames(rest)
        clearTimeout(timer)
        this.send({ type: 'auth', token: this.token, label: 'AssistantDesktop', platform: process.platform })
        resolve()
      }
      socket.on('data', onHttp)
    })
    const ack = await this.waitType('auth_ok', 8000)
    this.machine = {
      ...this.machine,
      id: ack.id || crypto.randomBytes(4).toString('hex'),
      status: 'online',
      platform: ack.platform,
      label: ack.label || this.machine.label,
      lastSeenAt: Date.now()
    }
    return this.machine
  }

  private onFrames(chunk: Buffer): void {
    this.buf = Buffer.from(Buffer.concat([this.buf, chunk]))
    for (;;) {
      const frame = decodeFrame(this.buf)
      if (!frame) break
      this.buf = Buffer.from(frame.rest)
      if (frame.opcode !== 1) continue
      let msg: Msg
      try {
        msg = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        continue
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.ok === false) p.reject(new Error(msg.error || '远程错误'))
        else p.resolve(msg)
      }
      this.emit('message', msg)
    }
  }
  private send(m: Msg): void {
    // 客户端帧必须 mask
    const payload = Buffer.from(JSON.stringify(m))
    const mask = crypto.randomBytes(4)
    const len = payload.length
    let header: Buffer
    if (len < 126) header = Buffer.from([0x81, 0x80 | len])
    else {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    }
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
    this.socket?.write(Buffer.concat([header, mask, masked]))
  }
  private waitType(type: string, ms: number): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待 ' + type + ' 超时')), ms)
      const on = (m: Msg): void => {
        if (m.type === type) {
          clearTimeout(t)
          this.off('message', on)
          resolve(m)
        }
        if (m.type === 'auth_fail') {
          clearTimeout(t)
          this.off('message', on)
          reject(new Error(m.error || '认证失败'))
        }
      }
      this.on('message', on)
    })
  }
  call(name: string, args: any = {}): Promise<any> {
    const id = crypto.randomBytes(4).toString('hex')
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (m) => resolve(m.result),
        reject
      })
      this.send({ type: 'call', id, name, args })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('远程调用超时：' + name))
        }
      }, 60000)
    })
  }
  close(): void {
    this.socket?.destroy()
  }
}

/** 把远程客户端包装成 ComputerDeps */
export function remoteComputerDeps(client: RemoteAgentClient): ComputerDeps {
  return {
    settleMs: 800,
    capture: async (): Promise<Capture> => {
      const r = await client.call('screenshot')
      return {
        jpeg: Buffer.from(r.jpeg, 'base64'),
        thumb: Buffer.from(r.thumb, 'base64'),
        width: r.width,
        height: r.height,
        png: r.png ? Buffer.from(r.png, 'base64') : undefined
      }
    },
    driver: async () => ({
      size: () => client.call('size'),
      move: (x, y) => client.call('move', { x, y }),
      click: (button, double) => client.call('click', { button, double }),
      drag: (fromX, fromY, toX, toY) => client.call('drag', { fromX, fromY, toX, toY }),
      scroll: (direction, amount) => client.call('scroll', { direction, amount }),
      type: (text) => client.call('type', { text }),
      keys: (combo) => client.call('keys', { keys: combo }),
      windows: () => client.call('windows'),
      focus: (title) => client.call('focus', { title })
    }),
    openApp: (name, args) => client.call('openApp', { name, args }),
    openUrl: (url) => client.call('openUrl', { url })
  }
}
