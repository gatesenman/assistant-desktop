// 无界面冒烟测试：启动模拟的 OpenAI 兼容接口 + Electron（需先 npm run build）
// Linux 无显示环境请使用：xvfb-run -a node scripts/smoke.mjs
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

let n = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    n++
    const json = JSON.parse(body || '{}')
    const hasTool = (json.messages || []).some((m) => m.role === 'tool')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    if (!hasTool) {
      const text = '你好！下面是示例代码：\n\n```python\nprint("hello")\n```\n\n冒烟测试回复完成'
      for (const ch of text.match(/[\s\S]{1,6}/g)) {
        send({ choices: [{ index: 0, delta: { content: ch } }] })
        await sleep(15)
      }
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'm1', type: 'function', function: { name: 'save_memory', arguments: '{"text":"用户在做冒烟测试"}' } }] } }] })
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 's1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"echo smoke-ok"}' } }] } }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      const toolOut = json.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' ')
      const ok = toolOut.includes('smoke-ok') ? 'smoke-ok' : '未获得输出'
      send({ choices: [{ index: 0, delta: { content: `工具执行完毕：${ok}` }, finish_reason: 'stop' }] })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-smoke-'))
  const child = spawn(electronPath, [root, '--no-sandbox', '--disable-gpu'], {
    env: {
      ...process.env,
      ASSISTANT_SMOKE: '1',
      ASSISTANT_SMOKE_BASEURL: `http://127.0.0.1:${port}/v1`,
      ASSISTANT_USER_DATA: userData
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
    process.stdout.write(d)
  })
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/dbus|Gtk|libva|gl_|GPU|viz_main|ozone|Fontconfig/i.test(s)) process.stderr.write(s)
  })
  child.on('exit', (code) => {
    server.close()
    const pass = code === 0 && out.includes('[SMOKE] PASS')
    console.log(`\n冒烟测试${pass ? '通过' : '失败'}（退出码 ${code}，模拟接口收到 ${n} 次请求，数据目录 ${userData}）`)
    process.exit(pass ? 0 : 1)
  })
})
