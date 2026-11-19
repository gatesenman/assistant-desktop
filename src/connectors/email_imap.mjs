import { startMcp, env } from './_mcp.mjs'
import net from 'net'
import tls from 'tls'

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }, () => resolve(s)) : net.connect({ host, port }, () => resolve(s))
    s.setEncoding('utf8')
    s.on('error', reject)
  })
}
async function imapCmd(socket, tag, cmd, expect = 'OK') {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d) => {
      buf += d
      if (buf.includes(`\n${tag} `) || buf.includes(`\r\n${tag} `)) {
        socket.off('data', onData)
        if (!buf.includes(`${tag} ${expect}`) && !buf.includes(`${tag} OK`)) reject(new Error(buf.slice(-400)))
        else resolve(buf)
      }
    }
    socket.on('data', onData)
    socket.write(`${tag} ${cmd}\r\n`)
    setTimeout(() => { socket.off('data', onData); reject(new Error('IMAP 超时')) }, 20000)
  })
}
async function withImap(fn) {
  const host = env('imapHost'), port = Number(env('imapPort', '993')), user = env('email'), pass = env('password')
  if (!host || !user || !pass) throw new Error('缺少 IMAP 配置')
  const s = await connect(host, port, port === 993)
  await new Promise((r) => s.once('data', r))
  await imapCmd(s, 'a1', `LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`)
  try { return await fn(s) } finally { try { s.write('a9 LOGOUT\r\n'); s.end() } catch {} }
}

startMcp({
  name: 'email-imap',
  tools: [
    { name: 'email_list', description: '列出收件箱最近邮件（主题/发件人/日期）', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, mailbox: { type: 'string' } } } },
    { name: 'email_read', description: '读取指定序号邮件正文摘要', inputSchema: { type: 'object', properties: { seq: { type: 'number' }, mailbox: { type: 'string' } }, required: ['seq'] } },
    { name: 'email_send', description: '通过 SMTP 发送邮件', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } }
  ],
  async call(name, args) {
    if (name === 'email_list') {
      return withImap(async (s) => {
        const box = args.mailbox || 'INBOX'
        await imapCmd(s, 'a2', `SELECT ${box}`)
        const lim = Math.min(20, args.limit || 10)
        const raw = await imapCmd(s, 'a3', `FETCH 1:* (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`).catch(() => '')
        // 取最后 lim 封：简化解析
        const blocks = raw.split(/\* \d+ FETCH/i).slice(1)
        return blocks.slice(-lim).map((b, i) => {
          const sub = (b.match(/Subject:\s*(.+)/i) || [])[1]?.trim() || '(无主题)'
          const from = (b.match(/From:\s*(.+)/i) || [])[1]?.trim() || '?'
          const date = (b.match(/Date:\s*(.+)/i) || [])[1]?.trim() || ''
          return `#${i + 1} ${date} | ${from} | ${sub}`
        }).join('\n') || '(空收件箱或服务器未返回 FETCH)'
      })
    }
    if (name === 'email_read') {
      return withImap(async (s) => {
        await imapCmd(s, 'a2', `SELECT ${args.mailbox || 'INBOX'}`)
        const raw = await imapCmd(s, 'a3', `FETCH ${args.seq} (BODY.PEEK[TEXT])`)
        return raw.replace(/\r/g, '').slice(0, 4000)
      })
    }
    if (name === 'email_send') {
      const host = env('smtpHost'), port = Number(env('smtpPort', '465')), user = env('email'), pass = env('password')
      if (!host) throw new Error('缺少 SMTP 主机')
      const s = await connect(host, port, port === 465 || port === 587)
      const read = () => new Promise((res) => s.once('data', res))
      const w = async (line) => { s.write(line + '\r\n'); return read() }
      await read()
      await w('EHLO localhost')
      if (port === 587) { await w('STARTTLS'); /* 简化：许多服务器 465 直接 TLS */ }
      await w('AUTH LOGIN')
      await w(Buffer.from(user).toString('base64'))
      await w(Buffer.from(pass).toString('base64'))
      await w(`MAIL FROM:<${user}>`)
      await w(`RCPT TO:<${args.to}>`)
      await w('DATA')
      const msg = `From: ${user}\r\nTo: ${args.to}\r\nSubject: ${args.subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}\r\n.`
      await w(msg)
      await w('QUIT')
      s.end()
      return `已提交发送至 ${args.to}`
    }
    throw new Error('未知工具')
  }
})
