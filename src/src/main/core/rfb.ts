/**
 * v0.7 最小 RFB（VNC）客户端：用于直接控制本地虚拟电脑（dockur Windows/macOS 的 QEMU VNC、
 * Linux 虚拟电脑的 x11vnc），截取帧缓冲、发送鼠标/键盘事件，不需要在虚拟机里装任何东西。
 *
 * 实现 RFC 6143：ProtocolVersion 3.3/3.7/3.8，安全类型 None(1) / VNC 认证(2)，
 * SetPixelFormat（32bpp 小端 BGRX），编码 Raw(0) + CopyRect(1) + DesktopSize 伪编码(-223)。
 * 传输层可以是 TCP（host:5900）或 WebSocket（websockify / QEMU 内置 websocket，子协议 binary）。
 */
import { desEcb } from './des'
import net from 'net'
import crypto from 'crypto'
import { EventEmitter } from 'events'

export interface RfbTransport {
  write(b: Buffer): void
  onData(cb: (b: Buffer) => void): void
  onClose(cb: (err?: Error) => void): void
  close(): void
}

/** 按需读取字节的队列（把流式数据切成协议字段） */
export class ByteQueue {
  private chunks: Buffer[] = []
  private len = 0
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  private closedErr: Error | null = null

  push(b: Buffer): void {
    if (!b.length) return
    this.chunks.push(b)
    this.len += b.length
    this.pump()
  }

  close(err: Error): void {
    this.closedErr = err
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.reject(err)
    }
  }

  get available(): number {
    return this.len
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0)
    let out: Buffer
    if (this.chunks[0].length >= n) {
      out = this.chunks[0].subarray(0, n)
      if (this.chunks[0].length === n) this.chunks.shift()
      else this.chunks[0] = this.chunks[0].subarray(n)
    } else {
      out = Buffer.allocUnsafe(n)
      let off = 0
      while (off < n) {
        const c = this.chunks[0]
        const k = Math.min(c.length, n - off)
        c.copy(out, off, 0, k)
        off += k
        if (k === c.length) this.chunks.shift()
        else this.chunks[0] = c.subarray(k)
      }
    }
    this.len -= n
    return out
  }

  private pump(): void {
    if (this.waiter && this.len >= this.waiter.n) {
      const w = this.waiter
      this.waiter = null
      w.resolve(this.take(w.n))
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.len >= n) return Promise.resolve(this.take(n))
    if (this.closedErr) return Promise.reject(this.closedErr)
    if (this.waiter) return Promise.reject(new Error('ByteQueue: 并发读取'))
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject }
    })
  }
}

/* ------------------------------ 传输层 ------------------------------ */

export function tcpTransport(host: string, port: number, timeoutMs = 8000): Promise<RfbTransport> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port })
    s.setNoDelay(true)
    const t = setTimeout(() => {
      s.destroy()
      reject(new Error(`连接 VNC ${host}:${port} 超时`))
    }, timeoutMs)
    s.once('error', (e) => {
      clearTimeout(t)
      reject(new Error(`无法连接 VNC ${host}:${port}：${(e as any).code || e.message}`))
    })
    s.once('connect', () => {
      clearTimeout(t)
      s.removeAllListeners('error')
      resolve({
        write: (b) => void s.write(b),
        onData: (cb) => void s.on('data', cb),
        onClose: (cb) => {
          s.on('error', (e) => cb(e))
          s.on('close', () => cb())
        },
        close: () => s.destroy()
      })
    })
  })
}

/** WebSocket 帧编码（客户端 → 服务器必须加掩码） */
export function wsEncodeFrame(payload: Buffer, opcode = 2, mask = true): Buffer {
  const len = payload.length
  const head: number[] = [0x80 | opcode]
  const m = mask ? 0x80 : 0
  if (len < 126) head.push(m | len)
  else if (len < 65536) head.push(m | 126, (len >> 8) & 255, len & 255)
  else {
    head.push(m | 127, 0, 0, 0, 0)
    head.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255)
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload])
  const key = crypto.randomBytes(4)
  const out = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3]
  return Buffer.concat([Buffer.from(head), key, out])
}

/** 从缓冲区解出一个完整帧；不完整返回 null */
export function wsDecodeFrame(buf: Buffer): { fin: boolean; opcode: number; payload: Buffer; size: number } | null {
  if (buf.length < 2) return null
  const fin = !!(buf[0] & 0x80)
  const opcode = buf[0] & 0x0f
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
  const mlen = masked ? 4 : 0
  if (buf.length < off + mlen + len) return null
  let payload = buf.subarray(off + mlen, off + mlen + len)
  if (masked) {
    const key = buf.subarray(off, off + 4)
    const p = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) p[i] = payload[i] ^ key[i & 3]
    payload = p
  }
  return { fin, opcode, payload, size: off + mlen + len }
}

/** 连接 websockify / QEMU websocket（ws://host:port/path），子协议 binary */
export function wsTransport(url: string, timeoutMs = 8000): Promise<RfbTransport> {
  const u = new URL(url)
  if (u.protocol !== 'ws:') return Promise.reject(new Error('仅支持 ws:// 地址（本机虚拟电脑）'))
  const port = Number(u.port || 80)
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: u.hostname, port })
    s.setNoDelay(true)
    const key = crypto.randomBytes(16).toString('base64')
    let handshake = Buffer.alloc(0)
    let upgraded = false
    let buf: Buffer = Buffer.alloc(0)
    let frag: Buffer[] = []
    let dataCb: (b: Buffer) => void = () => {}
    const closeCbs: ((e?: Error) => void)[] = []
    const t = setTimeout(() => {
      s.destroy()
      reject(new Error(`连接 ${url} 超时`))
    }, timeoutMs)
    s.once('error', (e) => {
      if (!upgraded) {
        clearTimeout(t)
        reject(new Error(`无法连接 ${url}：${(e as any).code || e.message}`))
      }
    })
    s.on('connect', () => {
      s.write(
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nOrigin: http://${u.host}\r\n\r\n`
      )
    })
    const onFrames = (): void => {
      for (;;) {
        const f = wsDecodeFrame(buf)
        if (!f) return
        buf = buf.subarray(f.size)
        if (f.opcode === 8) {
          s.end()
          return
        }
        if (f.opcode === 9) {
          s.write(wsEncodeFrame(f.payload, 10))
          continue
        }
        if (f.opcode === 10) continue
        if (f.opcode === 0 || f.opcode === 1 || f.opcode === 2) {
          frag.push(f.opcode === 1 ? Buffer.from(f.payload.toString('latin1'), 'base64') : f.payload)
          if (f.fin) {
            const all = frag.length === 1 ? frag[0] : Buffer.concat(frag)
            frag = []
            dataCb(all)
          }
        }
      }
    }
    s.on('data', (d: Buffer) => {
      if (upgraded) {
        buf = buf.length ? Buffer.concat([buf, d]) : d
        onFrames()
        return
      }
      handshake = Buffer.concat([handshake, d])
      const idx = handshake.indexOf('\r\n\r\n')
      if (idx < 0) return
      const head = handshake.subarray(0, idx).toString('latin1')
      const status = Number(head.split(' ')[1])
      if (status !== 101) {
        clearTimeout(t)
        s.destroy()
        reject(new Error(`WebSocket 握手失败（HTTP ${status || '?'}）：${url}`))
        return
      }
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      if (!new RegExp(`sec-websocket-accept:\\s*${accept.replace(/[+/=]/g, (c) => '\\' + c)}`, 'i').test(head)) {
        clearTimeout(t)
        s.destroy()
        reject(new Error('WebSocket 握手校验失败'))
        return
      }
      upgraded = true
      clearTimeout(t)
      buf = handshake.subarray(idx + 4)
      s.on('error', (e) => closeCbs.forEach((cb) => cb(e)))
      s.on('close', () => closeCbs.forEach((cb) => cb()))
      resolve({
        write: (b) => void s.write(wsEncodeFrame(b, 2)),
        onData: (cb) => {
          dataCb = cb
          if (buf.length) onFrames()
        },
        onClose: (cb) => void closeCbs.push(cb),
        close: () => {
          try {
            s.write(wsEncodeFrame(Buffer.alloc(0), 8))
          } catch {
            /* ignore */
          }
          s.destroy()
        }
      })
    })
  })
}

/* ------------------------------ VNC 认证 ------------------------------ */

/** VNC 认证：口令（最多 8 字节）每个字节位序反转后作为 DES 密钥加密 16 字节挑战 */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8)
  const pw = Buffer.from(password, 'latin1')
  for (let i = 0; i < 8; i++) {
    const c = i < pw.length ? pw[i] : 0
    let r = 0
    for (let b = 0; b < 8; b++) if (c & (1 << b)) r |= 1 << (7 - b)
    key[i] = r
  }
  try {
    const c = crypto.createCipheriv('des-ecb', key, null)
    c.setAutoPadding(false)
    return Buffer.concat([c.update(challenge), c.final()])
  } catch {
    // OpenSSL 3 默认不提供 DES：改用内置的纯 JS 实现
    return desEcb(key, challenge)
  }
}

/* ------------------------------ 客户端 ------------------------------ */

export interface PixelFormat {
  bpp: number
  depth: number
  bigEndian: boolean
  trueColor: boolean
  redMax: number
  greenMax: number
  blueMax: number
  redShift: number
  greenShift: number
  blueShift: number
}

export function encodePixelFormat(pf: PixelFormat): Buffer {
  const b = Buffer.alloc(16)
  b[0] = pf.bpp
  b[1] = pf.depth
  b[2] = pf.bigEndian ? 1 : 0
  b[3] = pf.trueColor ? 1 : 0
  b.writeUInt16BE(pf.redMax, 4)
  b.writeUInt16BE(pf.greenMax, 6)
  b.writeUInt16BE(pf.blueMax, 8)
  b[10] = pf.redShift
  b[11] = pf.greenShift
  b[12] = pf.blueShift
  return b
}

export function decodePixelFormat(b: Buffer): PixelFormat {
  return {
    bpp: b[0],
    depth: b[1],
    bigEndian: !!b[2],
    trueColor: !!b[3],
    redMax: b.readUInt16BE(4),
    greenMax: b.readUInt16BE(6),
    blueMax: b.readUInt16BE(8),
    redShift: b[10],
    greenShift: b[11],
    blueShift: b[12]
  }
}

/** 我们要求的像素格式：32bpp 小端，R<<16|G<<8|B → 内存中 B,G,R,X（即 BGRA，可直接给 nativeImage） */
export const BGRX: PixelFormat = { bpp: 32, depth: 24, bigEndian: false, trueColor: true, redMax: 255, greenMax: 255, blueMax: 255, redShift: 16, greenShift: 8, blueShift: 0 }

export const ENC_RAW = 0
export const ENC_COPYRECT = 1
export const ENC_DESKTOPSIZE = -223

export const msg = {
  setPixelFormat: (pf: PixelFormat): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0]), encodePixelFormat(pf)]),
  setEncodings: (encs: number[]): Buffer => {
    const b = Buffer.alloc(4 + encs.length * 4)
    b[0] = 2
    b.writeUInt16BE(encs.length, 2)
    encs.forEach((e, i) => b.writeInt32BE(e, 4 + i * 4))
    return b
  },
  fbUpdateRequest: (incremental: boolean, x: number, y: number, w: number, h: number): Buffer => {
    const b = Buffer.alloc(10)
    b[0] = 3
    b[1] = incremental ? 1 : 0
    b.writeUInt16BE(x, 2)
    b.writeUInt16BE(y, 4)
    b.writeUInt16BE(w, 6)
    b.writeUInt16BE(h, 8)
    return b
  },
  key: (down: boolean, keysym: number): Buffer => {
    const b = Buffer.alloc(8)
    b[0] = 4
    b[1] = down ? 1 : 0
    b.writeUInt32BE(keysym >>> 0, 4)
    return b
  },
  pointer: (mask: number, x: number, y: number): Buffer => {
    const b = Buffer.alloc(6)
    b[0] = 5
    b[1] = mask & 255
    b.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(x))), 2)
    b.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(y))), 4)
    return b
  },
  clientCutText: (text: string): Buffer => {
    const t = Buffer.from(text, 'latin1')
    const b = Buffer.alloc(8 + t.length)
    b[0] = 6
    b.writeUInt32BE(t.length, 4)
    t.copy(b, 8)
    return b
  }
}

export interface RfbOptions {
  password?: string
  /** 连接超时 */
  timeoutMs?: number
  shared?: boolean
}

/**
 * RFB 客户端。帧缓冲固定为 BGRA（alpha=255），可直接 nativeImage.createFromBitmap。
 * 事件：update（一次 FramebufferUpdate 处理完）、resize、close、bell、cuttext
 */
export class RfbClient extends EventEmitter {
  width = 0
  height = 0
  name = ''
  version = ''
  fb: Buffer = Buffer.alloc(0)
  closed = false
  private q = new ByteQueue()
  private buttons = 0
  private updates = 0

  constructor(private t: RfbTransport) {
    super()
    t.onData((b) => this.q.push(b))
    t.onClose((err) => {
      this.closed = true
      this.q.close(err || new Error('VNC 连接已关闭'))
      this.emit('close', err)
    })
  }

  static async connect(transport: RfbTransport, opts: RfbOptions = {}): Promise<RfbClient> {
    const c = new RfbClient(transport)
    const timeout = opts.timeoutMs ?? 10000
    let timer: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        c.handshake(opts),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('VNC 握手超时（虚拟机可能还在启动）')), timeout)
        })
      ])
    } catch (e) {
      transport.close()
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
    void c.messageLoop()
    return c
  }

  private async handshake(opts: RfbOptions): Promise<void> {
    const ver = (await this.q.read(12)).toString('latin1')
    const m = ver.match(/^RFB (\d{3})\.(\d{3})\n$/)
    if (!m) throw new Error('不是 VNC 服务器（协议头异常）：' + JSON.stringify(ver))
    const minor = Number(m[1]) > 3 ? 8 : Math.min(8, Number(m[2]))
    const use = minor >= 8 ? 8 : minor >= 7 ? 7 : 3
    this.version = `3.${use}`
    this.t.write(Buffer.from(`RFB 003.00${use}\n`, 'latin1'))
    let secType: number
    if (use === 3) {
      secType = (await this.q.read(4)).readUInt32BE(0)
      if (secType === 0) throw new Error('VNC 服务器拒绝连接：' + (await this.readReason()))
    } else {
      const n = (await this.q.read(1))[0]
      if (n === 0) throw new Error('VNC 服务器拒绝连接：' + (await this.readReason()))
      const types = [...(await this.q.read(n))]
      if (types.includes(1)) secType = 1
      else if (types.includes(2)) secType = 2
      else throw new Error(`VNC 服务器只支持本应用不支持的认证方式（${types.join(',')}）`)
      this.t.write(Buffer.from([secType]))
    }
    if (secType === 2) {
      if (opts.password === undefined) throw new Error('VNC 服务器需要密码')
      const ch = await this.q.read(16)
      this.t.write(vncAuthResponse(ch, opts.password))
    }
    if (secType === 2 || use === 8) {
      const r = (await this.q.read(4)).readUInt32BE(0)
      if (r !== 0) throw new Error('VNC 认证失败：' + (use === 8 ? await this.readReason() : '密码错误'))
    }
    this.t.write(Buffer.from([opts.shared === false ? 0 : 1]))
    const init = await this.q.read(24)
    this.width = init.readUInt16BE(0)
    this.height = init.readUInt16BE(2)
    const nameLen = init.readUInt32BE(20)
    this.name = (await this.q.read(nameLen)).toString('utf8')
    this.fb = Buffer.alloc(this.width * this.height * 4, 0)
    for (let i = 3; i < this.fb.length; i += 4) this.fb[i] = 255
    this.t.write(msg.setPixelFormat(BGRX))
    this.t.write(msg.setEncodings([ENC_RAW, ENC_COPYRECT, ENC_DESKTOPSIZE]))
  }

  private async readReason(): Promise<string> {
    const n = (await this.q.read(4)).readUInt32BE(0)
    return (await this.q.read(Math.min(n, 4096))).toString('utf8')
  }

  private resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.fb = Buffer.alloc(w * h * 4, 0)
    for (let i = 3; i < this.fb.length; i += 4) this.fb[i] = 255
    this.emit('resize', { width: w, height: h })
  }

  private async messageLoop(): Promise<void> {
    try {
      for (;;) {
        const type = (await this.q.read(1))[0]
        if (type === 0) await this.readUpdate()
        else if (type === 1) {
          const h = await this.q.read(5)
          await this.q.read(h.readUInt16BE(3) * 6)
        } else if (type === 2) this.emit('bell')
        else if (type === 3) {
          const h = await this.q.read(7)
          const text = (await this.q.read(h.readUInt32BE(3))).toString('latin1')
          this.emit('cuttext', text)
        } else throw new Error('未知的 VNC 服务器消息类型 ' + type)
      }
    } catch (e: any) {
      if (!this.closed) {
        this.closed = true
        this.t.close()
        this.emit('close', e)
      }
    }
  }

  private async readUpdate(): Promise<void> {
    const h = await this.q.read(3)
    const n = h.readUInt16BE(1)
    for (let i = 0; i < n; i++) {
      const r = await this.q.read(12)
      const x = r.readUInt16BE(0)
      const y = r.readUInt16BE(2)
      const w = r.readUInt16BE(4)
      const hh = r.readUInt16BE(6)
      const enc = r.readInt32BE(8)
      if (enc === ENC_RAW) {
        const data = await this.q.read(w * hh * 4)
        this.blitRaw(x, y, w, hh, data)
      } else if (enc === ENC_COPYRECT) {
        const s = await this.q.read(4)
        this.copyRect(s.readUInt16BE(0), s.readUInt16BE(2), x, y, w, hh)
      } else if (enc === ENC_DESKTOPSIZE) {
        this.resize(w, hh)
      } else {
        throw new Error('VNC 服务器使用了未协商的编码 ' + enc)
      }
    }
    this.updates++
    this.emit('update', this.updates)
  }

  private blitRaw(x: number, y: number, w: number, h: number, data: Buffer): void {
    const W = this.width
    for (let row = 0; row < h; row++) {
      const yy = y + row
      if (yy >= this.height) break
      const src = row * w * 4
      const dst = (yy * W + x) * 4
      const cw = Math.min(w, W - x)
      if (cw <= 0) break
      data.copy(this.fb, dst, src, src + cw * 4)
      for (let k = dst + 3; k < dst + cw * 4; k += 4) this.fb[k] = 255
    }
  }

  private copyRect(sx: number, sy: number, dx: number, dy: number, w: number, h: number): void {
    const W = this.width
    const tmp = Buffer.allocUnsafe(w * h * 4)
    for (let row = 0; row < h; row++) this.fb.copy(tmp, row * w * 4, ((sy + row) * W + sx) * 4, ((sy + row) * W + sx + w) * 4)
    for (let row = 0; row < h; row++) tmp.copy(this.fb, ((dy + row) * W + dx) * 4, row * w * 4, (row + 1) * w * 4)
  }

  /** 请求一次完整帧并等待处理完成，返回 BGRA 帧缓冲副本 */
  async snapshot(timeoutMs = 8000): Promise<{ width: number; height: number; bgra: Buffer }> {
    if (this.closed) throw new Error('VNC 连接已断开')
    const before = this.updates
    const done = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup()
        reject(new Error('VNC 截屏超时'))
      }, timeoutMs)
      const onUp = (n: number): void => {
        if (n > before) {
          cleanup()
          resolve()
        }
      }
      const onClose = (e?: Error): void => {
        cleanup()
        reject(e || new Error('VNC 连接已断开'))
      }
      const cleanup = (): void => {
        clearTimeout(t)
        this.off('update', onUp)
        this.off('close', onClose)
      }
      this.on('update', onUp)
      this.on('close', onClose)
    })
    this.t.write(msg.fbUpdateRequest(false, 0, 0, this.width, this.height))
    await done
    return { width: this.width, height: this.height, bgra: Buffer.from(this.fb) }
  }

  pointer(x: number, y: number, mask = this.buttons): void {
    this.buttons = mask
    this.t.write(msg.pointer(mask, Math.min(this.width - 1, x), Math.min(this.height - 1, y)))
  }

  key(keysym: number, down: boolean): void {
    this.t.write(msg.key(down, keysym))
  }

  close(): void {
    this.closed = true
    this.t.close()
  }
}

/* ------------------------------ 键位映射 ------------------------------ */

export const KEYSYMS: Record<string, number> = {
  backspace: 0xff08,
  tab: 0xff09,
  enter: 0xff0d,
  return: 0xff0d,
  esc: 0xff1b,
  escape: 0xff1b,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  option: 0xffe9,
  meta: 0xffe7,
  cmd: 0xffeb,
  command: 0xffeb,
  win: 0xffeb,
  super: 0xffeb,
  capslock: 0xffe5,
  space: 0x20,
  printscreen: 0xff61,
  menu: 0xff67,
  minus: 0x2d,
  equal: 0x3d,
  comma: 0x2c,
  period: 0x2e,
  slash: 0x2f
}

/** 美式键盘上需要 Shift 的字符 */
const SHIFTED = new Set(Array.from('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ'))

export function keysymForName(name: string): number {
  const k = name.trim().toLowerCase()
  if (KEYSYMS[k] !== undefined) return KEYSYMS[k]
  const f = k.match(/^f([1-9]|1[0-9]|2[0-4])$/)
  if (f) return 0xffbe + Number(f[1]) - 1
  if (k.length === 1) return keysymForChar(k)
  throw new Error(`不支持的按键：${name}`)
}

/** 字符 → keysym（Latin-1 直接对应；其它 Unicode 用 0x01000000 + 码点） */
export function keysymForChar(ch: string): number {
  const cp = ch.codePointAt(0) || 0
  if (ch === '\n') return 0xff0d
  if (ch === '\t') return 0xff09
  if (ch === '\b') return 0xff08
  if (cp >= 0x20 && cp <= 0xff) return cp
  return 0x01000000 + cp
}

export function needsShift(ch: string): boolean {
  return SHIFTED.has(ch)
}

/** 文字 → 按键序列（[keysym, down]），大写和符号自动加 Shift */
export function textToKeyEvents(text: string): [number, boolean][] {
  const out: [number, boolean][] = []
  for (const ch of Array.from(text)) {
    const ks = keysymForChar(ch)
    const sh = needsShift(ch)
    if (sh) out.push([0xffe1, true])
    out.push([ks, true], [ks, false])
    if (sh) out.push([0xffe1, false])
  }
  return out
}

/** 组合键 → 按下顺序 + 逆序抬起 */
export function comboToKeyEvents(combo: string[]): [number, boolean][] {
  const syms = combo.map(keysymForName)
  return [...syms.map((s): [number, boolean] => [s, true]), ...[...syms].reverse().map((s): [number, boolean] => [s, false])]
}

/** 鼠标按钮掩码 */
export const BUTTON_MASK = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64 }
