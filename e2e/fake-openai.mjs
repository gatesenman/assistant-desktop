// 可编排工具调用的假 OpenAI 兼容服务器（用于端到端测试）
import http from 'http'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/** 解码 data URL 图片（PNG / JPEG）为 RGBA */
function decodeImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/s.exec(dataUrl || '')
  if (!m) return null
  const buf = Buffer.from(m[2], 'base64')
  if (m[1] === 'png') {
    const { PNG } = require('pngjs')
    const p = PNG.sync.read(buf)
    return { width: p.width, height: p.height, data: p.data }
  }
  const jpeg = require('jpeg-js')
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true })
  return { width: j.width, height: j.height, data: j.data }
}
/** 找到图中「红色」像素的外接框与中心（模拟 grounding 模型「看图定位」） */
export function findRed(img) {
  let n = 0
  let sx = 0
  let sy = 0
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -1
  let y2 = -1
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const r = img.data[i]
      const g = img.data[i + 1]
      const b = img.data[i + 2]
      if (r > 180 && g < 80 && b < 80) {
        n++
        sx += x
        sy += y
        if (x < x1) x1 = x
        if (y < y1) y1 = y
        if (x > x2) x2 = x
        if (y > y2) y2 = y
      }
    }
  if (n < 30) return null
  return { x: Math.round(sx / n), y: Math.round(sy / n), box: [x1, y1, x2, y2], n }
}
/** Qwen2.5-VL / UI-TARS-1.5 的 smart_resize */
export function smartResize(h, w, factor = 28, minPixels = 100 * 28 * 28, maxPixels = 16384 * 28 * 28) {
  let hb = Math.max(factor, Math.round(h / factor) * factor)
  let wb = Math.max(factor, Math.round(w / factor) * factor)
  if (hb * wb > maxPixels) {
    const beta = Math.sqrt((h * w) / maxPixels)
    hb = Math.floor(h / beta / factor) * factor
    wb = Math.floor(w / beta / factor) * factor
  } else if (hb * wb < minPixels) {
    const beta = Math.sqrt(minPixels / (h * w))
    hb = Math.ceil((h * beta) / factor) * factor
    wb = Math.ceil((w * beta) / factor) * factor
  }
  return { height: hb, width: wb }
}

export const TEST_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>E2E 测试表单</title>
<style>body{font-family:sans-serif;padding:40px;background:#f6f7fb}.card{background:#fff;border-radius:12px;padding:24px;max-width:420px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
input{padding:8px;border:1px solid #ccc;border-radius:6px;width:240px}button{padding:8px 16px;margin-left:8px;border:0;border-radius:6px;background:#6366f1;color:#fff}
#result{margin-top:16px;font-size:20px;color:#16a34a}</style></head><body><div class="card"><h1>浏览器自动化测试页</h1>
<input id="name" placeholder="请输入姓名"><button id="go" onclick="document.getElementById('result').textContent='你好，'+document.getElementById('name').value+'！表单已提交'">提交</button>
<p id="result">尚未提交</p></div></body></html>`

export const DESK_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>电脑控制测试页</title>
<style>body{margin:0;background:linear-gradient(135deg,#1e3a8a,#0f172a);color:#fff;font:20px "Noto Sans CJK SC",sans-serif;height:100vh}
.wrap{padding:150px 60px 0}h1{margin:0 0 24px;font-size:30px}input{width:380px;height:46px;font-size:20px;padding:0 12px;border-radius:10px;border:2px solid #93c5fd}
button{height:50px;width:140px;font-size:20px;margin-left:14px;border:0;border-radius:10px;background:#22c55e;color:#fff;font-weight:700}
#out{margin-top:26px;font-size:26px;color:#fde047}</style></head><body><div class="wrap"><h1>🖥 电脑控制测试页</h1>
<input id="t" placeholder="点击这里输入"><button id="ok">提交</button><p id="out">等待输入…</p></div>
<script>
function report(){const r=(id)=>{const b=document.getElementById(id).getBoundingClientRect();const top=window.outerHeight-window.innerHeight;
return {x:Math.round(window.screenX+b.left+b.width/2),y:Math.round(window.screenY+top+b.top+b.height/2)}};
fetch('/desk-pos',{method:'POST',body:JSON.stringify({input:r('t'),button:r('ok'),screen:{w:screen.width,h:screen.height}})})}
window.addEventListener('load',()=>setTimeout(report,300));window.addEventListener('resize',report);
document.getElementById('ok').onclick=()=>{const v=document.getElementById('t').value;document.getElementById('out').textContent='已提交：'+v;
fetch('/desk-result',{method:'POST',body:v})};
</script></body></html>`

export function startFakeServer(opts = {}) {
  const log = { requests: [], auth: [], visionReceived: false, routinePings: 0, subtaskRequests: 0, deskPos: null, deskResult: null, computerLoopSteps: 0, routineComputer: 0, transcriptions: 0, workers: [], screenDone: [] }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handle(req, res, body).catch((e) => {
      console.error('[fake] error', e)
      res.writeHead(500)
      res.end(String(e))
    }))
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 末尾的 usage 块（OpenAI include_usage 格式 + DeepSeek 缓存字段） */
  function writeUsage(res, completionChars) {
    const u = res.__usage
    if (!u) return
    const completion = u.completion ?? Math.max(4, Math.ceil(completionChars / 1.6))
    const usage = { prompt_tokens: u.prompt, completion_tokens: completion, total_tokens: u.prompt + completion, prompt_cache_hit_tokens: u.hit, prompt_cache_miss_tokens: u.prompt - u.hit }
    log.usageChunks = (log.usageChunks || 0) + 1
    res.write(`data: ${JSON.stringify({ id: 'u', object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
  }
  async function stream(res, text, { delay = 20, size = 4 } = {}) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (let i = 0; i < text.length; i += size) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(i, i + size) } }] })}\n\n`)
      if (delay) await sleep(delay)
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    writeUsage(res, text.length)
    res.write('data: [DONE]\n\n')
    res.end()
  }
  function toolCall(res, name, args, pre = '') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (pre) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: pre } }] })}\n\n`)
    const id = 'call_' + Math.random().toString(36).slice(2, 10)
    const a = JSON.stringify(args)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: a.slice(0, 5) } }] } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(5) } }] } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    writeUsage(res, a.length + pre.length)
    res.write('data: [DONE]\n\n')
    res.end()
  }

  async function handle(req, res, raw) {
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.method === 'GET' && req.url.startsWith('/test-page')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(TEST_PAGE)
    }
    if (req.method === 'GET' && req.url.startsWith('/desk-page')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(DESK_PAGE)
    }
    if (req.method === 'POST' && req.url === '/desk-pos') {
      log.deskPos = JSON.parse(raw)
      res.writeHead(200)
      return res.end('ok')
    }
    if (req.method === 'POST' && req.url === '/desk-result') {
      log.deskResult = raw
      res.writeHead(200)
      return res.end('ok')
    }
    if (req.method === 'POST' && req.url.endsWith('/audio/transcriptions')) {
      log.transcriptions++
      const ct = String(req.headers['content-type'] || '')
      const ok = ct.startsWith('multipart/form-data') && raw.includes('whisper-1') && raw.includes('filename="voice.')
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(ok ? { text: '语音转写测试成功' } : { error: 'bad multipart' }))
    }
    if (req.method === 'GET' && req.url.startsWith('/update/latest.json')) {
      log.updateChecks = (log.updateChecks || 0) + 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ version: '9.9.9', notes: '测试用新版本', url: base + '/download' }))
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }] }))
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404)
      return res.end('not found')
    }
    const json = JSON.parse(raw)
    // ---------- grounding 模型（UI-TARS / Fara，非流式） ----------
    if (json.stream === false && /ui-tars|uitars|fara|ground/i.test(String(json.model || ''))) {
      const imgPart = (json.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'image_url')
      const instr = (json.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }])).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      const img = imgPart ? decodeImage(imgPart.image_url.url) : null
      if (!img) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'image required' } }))
      }
      const red = findRed(img) || { x: Math.round(img.width / 2), y: Math.round(img.height / 2), box: null }
      const model = String(json.model)
      let content
      if (/fara/i.test(model)) {
        content = `我看到了红色按钮，点击它。\n<tool_call>\n${JSON.stringify({ name: 'computer_use', arguments: { action: 'left_click', coordinate: [red.x, red.y] } })}\n</tool_call>`
      } else if (/v1|1\.0|72b-dpo|7b-sft/i.test(model) && !/1\.5/.test(model)) {
        content = `Thought: 红色按钮在这里。\nAction: click(start_box='(${Math.round((red.x / img.width) * 1000)},${Math.round((red.y / img.height) * 1000)})')`
      } else {
        const sr = smartResize(img.height, img.width)
        content = `Thought: 目标是红色的按钮。\nAction: click(start_box='(${Math.round((red.x * sr.width) / img.width)},${Math.round((red.y * sr.height) / img.height)})')`
      }
      log.grounding = [...(log.grounding || []), { model, width: img.width, height: img.height, red, instr: instr.slice(-120), content, auth: String(req.headers.authorization || '') }]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ id: 'g', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1450, completion_tokens: 32, total_tokens: 1482 } }))
    }
    // ---------- usage（stream_options.include_usage） ----------
    if (json.stream_options?.include_usage) {
      log.includeUsage = (log.includeUsage || 0) + 1
      const textLen = JSON.stringify(json.messages || []).replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'IMG'.repeat(300)).length
      const imgs = (JSON.stringify(json.messages || []).match(/data:image\//g) || []).length
      let prompt = Math.ceil(textLen / 3.2) + imgs * 1100 + 300
      const lastUser = [...(json.messages || [])].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')
      if (lastUser && String(lastUser.content).includes('E2E_BUDGET')) prompt = 180000
      const hit = (json.messages || []).length > 2 ? Math.floor(prompt * 0.62 / 64) * 64 : 0
      res.__usage = { prompt, hit }
    } else log.noIncludeUsage = (log.noIncludeUsage || 0) + 1
    const authz = String(req.headers.authorization || '')
    log.hostHeaders = log.hostHeaders || []
    log.hostHeaders.push(String(req.headers.host || ''))
    if (authz === 'Bearer sk-bad') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-bad', type: 'invalid_request_error', code: 'invalid_api_key' } }))
    }
    // 能力检测
    const first = json.messages?.[0]
    const firstText = typeof first?.content === 'string' ? first.content : Array.isArray(first?.content) ? first.content.map((c) => c.text || '').join('') : ''
    if (firstText.includes('CAPABILITY_PROBE_TOOLS') || firstText.includes('CAPABILITY_PROBE_VISION') || firstText.includes('这是一次连接测试')) {
      log.probes = (log.probes || 0) + 1
      const textOnly = /textonly/.test(json.model)
      if (firstText.includes('CAPABILITY_PROBE_TOOLS')) return toolCall(res, 'capability_ping', { word: 'pong' })
      if (firstText.includes('CAPABILITY_PROBE_VISION')) {
        if (textOnly) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'image_url is not supported by this model' } }))
        }
        return stream(res, '红色', { delay: 0 })
      }
      return stream(res, 'OK', { delay: 0 })
    }
    log.requests.push(json)
    log.auth.push(req.headers.authorization || '')
    const msgs = json.messages
    const system = String(msgs[0]?.role === 'system' ? msgs[0].content : '')
    let lu = msgs.length - 1
    while (lu >= 0 && !(msgs[lu].role === 'user' && typeof msgs[lu].content === 'string')) lu--
    const lastUserText = lu >= 0 ? msgs[lu].content : ''
    // 反思 / 系统注入时回退到含 E2E_ 的原始任务消息，避免脚本分支丢失
    let e2eLu = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && typeof msgs[i].content === 'string' && /E2E_/.test(msgs[i].content)) {
        e2eLu = i
        break
      }
    }
    const injected = /（系统）|请根据最新截图核对|用户刚才做了/.test(lastUserText)
    const userText = injected && e2eLu >= 0 ? msgs[e2eLu].content : lastUserText
    const toolMsgs = msgs.slice((injected && e2eLu >= 0 ? e2eLu : lu) + 1).filter((m) => m.role === 'tool')
    const step = toolMsgs.length
    const lastTool = toolMsgs[toolMsgs.length - 1]?.content || ''
    if (msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'))) log.visionReceived = true

    // 被协调者委派的智能体
    if (system.includes('委派给你')) {
      const name = system.match(/你是名为「(.+?)」/)?.[1] || '?'
      const w = { name, task: userText, start: Date.now(), end: 0 }
      log.workers.push(w)
      await sleep(2500)
      w.end = Date.now()
      return stream(res, `「${name}」完成：${userText.replace('E2E_WORKER ', '')} → 结论 ${log.workers.length}`, { delay: 5 })
    }
    if (userText.includes('E2E_DELEGATE')) {
      if (step === 0)
        return toolCall(
          res,
          'delegate_to_agent',
          {
            tasks: ['调研市场', '分析竞品', '撰写文案'].map((title, i) => ({
              agent: `写手${String(i + 1).padStart(2, '0')}`,
              title,
              prompt: `E2E_WORKER ${title}`
            }))
          },
          '这个任务可以拆成三部分，我分给三位助手同时做。'
        )
      return stream(res, `📦 汇总完成：三位助手已并行完成全部子任务。\n\n${lastTool}`, { delay: 2, size: 20 })
    }
    if (/E2E_SCREEN_[AB]/.test(userText)) {
      const tag = userText.match(/E2E_SCREEN_([AB])/)[1]
      const seq = [
        ['computer_screenshot', {}],
        ['mouse_move', { x: 200, y: 200 }],
        ['mouse_move', { x: 400, y: 300 }]
      ]
      await sleep(300)
      if (step < seq.length) return toolCall(res, seq[step][0], seq[step][1])
      log.screenDone.push(tag)
      return stream(res, `屏幕任务 ${tag} 完成`)
    }
    // 后台子任务
    if (system.includes('后台子任务模式')) {
      log.subtaskRequests++
      if (step === 0) return toolCall(res, 'list_dir', {}, '我先查看一下工作目录。')
      await sleep(2500)
      const n = (lastTool.match(/\[(文件|目录)\]/g) || []).length
      return stream(res, `子任务完成：工作目录中共有 ${n} 项。`)
    }
    if (userText.includes('【后台任务已完成】')) return stream(res, '📋 总结：后台任务「统计文件」已完成，子任务完成，结果已汇总。')
    if (userText.includes('E2E_STREAM'))
      return stream(res, '## 流式输出测试\n\n这是一段**流式**回复，包含代码：\n\n```js\nconst answer = 6 * 7\nconsole.log(`answer = ${answer}`)\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 流式 | ✅ |\n\n流式回复完成 ✅', { delay: 45, size: 3 })
    if (userText.includes('E2E_SHELL_APPROVE')) {
      if (step === 0) return toolCall(res, 'run_shell', { command: 'echo e2e-approved-$((6*7)) && uname -s' }, '我来执行这个命令。')
      return stream(res, `命令输出是：\n\n\`\`\`\n${lastTool}\n\`\`\``)
    }
    if (userText.includes('E2E_SHELL_DENY')) {
      if (step === 0) return toolCall(res, 'run_shell', { command: 'echo SHOULD_NOT_RUN > denied.txt' })
      return stream(res, lastTool.includes('拒绝') ? '好的，已取消执行该命令。' : '命令竟然执行了：' + lastTool)
    }
    if (userText.includes('E2E_SPAWN')) {
      if (step === 0) return toolCall(res, 'spawn_task', { title: '统计文件', prompt: 'E2E_SUBTASK 统计工作目录中的文件数量' })
      return stream(res, '已在后台启动任务，你可以继续和我聊天。')
    }
    if (userText.includes('E2E_PING_DURING_TASK')) return stream(res, '我还在，主对话没有被阻塞。')
    if (userText.includes('E2E_BROWSER')) {
      const seq = [
        ['browser_open', { url: `${base}/test-page` }],
        ['browser_type', { selector: '#name', text: '小明' }],
        ['browser_click', { text: '提交' }],
        ['browser_get_text', { selector: '#result' }],
        ['browser_screenshot', {}]
      ]
      if (step < seq.length) return toolCall(res, seq[step][0], seq[step][1])
      const hasImg = msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'))
      return stream(res, hasImg ? `我看到了截图，页面显示：${toolMsgs[3]?.content.split('\n').pop()}` : '没有收到截图')
    }
    if (userText.includes('E2E_MCP')) {
      const t = (json.tools || []).map((x) => x.function.name).find((n) => /^mcp__.*__add$/.test(n))
      if (!t) return stream(res, '没有找到 MCP 工具')
      if (step === 0) return toolCall(res, t, { a: 20, b: 22 })
      return stream(res, `MCP 计算结果：${lastTool}`)
    }
    if (userText.includes('E2E_ROUTINE_PING')) {
      log.routinePings++
      return stream(res, `⏰ 定时任务结果：pong #${log.routinePings}`, { delay: 0 })
    }
    if (userText.includes('E2E_COMPUTER_DESK')) {
      // 截图尺寸（模型以截图坐标操作；应用负责缩放到真实屏幕坐标）
      const dims = msgs.map((m) => (m.role === 'tool' ? String(m.content).match(/屏幕截图 (\d+)x(\d+)/) : null)).filter(Boolean).pop()
      const toShot = (p) => {
        const sw = log.deskPos.screen.w
        const sh = log.deskPos.screen.h
        const w = dims ? Number(dims[1]) : sw
        const h = dims ? Number(dims[2]) : sh
        return { x: Math.round((p.x * w) / sw), y: Math.round((p.y * h) / sh) }
      }
      if (step === 0) return toolCall(res, 'computer_screenshot', {}, '我先看一下屏幕。')
      if (step === 1) {
        log.deskPos = null
        return toolCall(res, 'open_app', {
          name: opts.chromium,
          args: [`--app=${base}/desk-page`, '--window-position=0,0', '--window-size=900,620', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${opts.chromeProfile}`]
        })
      }
      if (step === 2) {
        for (let i = 0; i < 100 && !log.deskPos; i++) await sleep(150)
        if (!log.deskPos) return stream(res, '测试页没有打开（未收到坐标）')
        return toolCall(res, 'mouse_click', toShot(log.deskPos.input))
      }
      if (step === 3) return toolCall(res, 'type_text', { text: 'Hello 电脑' })
      if (step === 4) return toolCall(res, 'mouse_click', toShot(log.deskPos.button))
      if (step === 5) return toolCall(res, 'computer_screenshot', {})
      const hasImg = msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'))
      return stream(res, `电脑操作完成 ✅ 页面已提交「${log.deskResult ?? '（未收到）'}」，${hasImg ? '我已在最终截图中确认结果' : '没有收到截图'}。`)
    }
    if (userText.includes('E2E_COMPUTER_LOOP')) {
      log.computerLoopSteps++
      await sleep(250)
      return toolCall(res, 'mouse_move', { x: 300 + (step % 10) * 20, y: 700 })
    }
    if (userText.includes('E2E_ROUTINE_COMPUTER')) {
      const seq = [
        ['computer_screenshot', {}],
        ['mouse_move', { x: 640, y: 600 }],
        ['key_press', { keys: 'shift' }]
      ]
      if (step < seq.length) return toolCall(res, seq[step][0], seq[step][1])
      log.routineComputer++
      return stream(res, `无人值守电脑任务完成 ✅ #${log.routineComputer}`, { delay: 0 })
    }
    if (userText.includes('E2E_FAIL3')) {
      log.fail3 = (log.fail3 || 0) + 1
      if (log.fail3 <= 3) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'upstream overloaded' } }))
      }
      return stream(res, `重试成功 ✅（第 ${log.fail3} 次请求）`)
    }
    if (userText.includes('E2E_BADJSON')) {
      if (step === 0) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const w = (d) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`)
        w({ tool_calls: [{ index: 0, id: 'bj1', type: 'function', function: { name: 'list_dir', arguments: '{"path": "' } }] })
        w({ tool_calls: [{ index: 0, function: { arguments: '.",' } }] })
        w({ tool_calls: [{ index: 1, id: 'bj2', type: 'function', function: { name: 'make_coffee', arguments: '{}' } }] })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      const ok = toolMsgs.length === 2 && !toolMsgs[0].content.includes('参数不是合法')
      const unknown = toolMsgs.some((m) => m.content.includes('不存在名为「make_coffee」'))
      return stream(res, `参数修复${ok ? '成功' : '失败'}，未知工具${unknown ? '已提示' : '未提示'} ✅`)
    }
    if (userText.includes('E2E_OVERFLOW')) {
      const size = JSON.stringify(msgs.filter((m) => m.role !== 'system')).length
      log.overflowSizes = [...(log.overflowSizes || []), size]
      if (size > 3000) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens. However, your messages resulted in 9000 tokens.", code: 'context_length_exceeded' } }))
      }
      return stream(res, `裁剪历史后成功 ✅`)
    }
    if (userText.includes('E2E_COMPUTER_GATE')) {
      if (step === 0) return toolCall(res, 'computer_screenshot', {})
      return stream(res, `能力检查结果：${lastTool.slice(0, 60)}`)
    }
    // ---------- v0.7 ----------
    const allToolText = toolMsgs.map((m) => String(m.content || ''))
    const findLine = (re) => {
      for (let i = allToolText.length - 1; i >= 0; i--) {
        const lines = allToolText[i].split('\n')
        const hit = lines.find((l) => re.test(l))
        if (hit) return hit
        if (lines.some((l) => /^\[\d+\] /.test(l))) {
          // 最新的列表里没有：不再回看旧列表（编号已失效）
          return null
        }
      }
      return null
    }
    const idOf = (line) => Number(/^\[(\d+)\]/.exec(line || '')?.[1] || 0)
    if (userText.includes('E2E_SOM_VM')) {
      if (step === 0) return toolCall(res, 'open_app', { name: 'mousepad' }, '我先打开记事本。')
      if (step === 1) {
        await sleep(1500)
        return toolCall(res, 'get_ui_elements', {}, '看看窗口里有哪些控件。')
      }
      if (step === 2) {
        const line = findLine(/^\[\d+\] 输入框/)
        log.somLists = [...(log.somLists || []), allToolText[allToolText.length - 1].slice(0, 4000)]
        if (!line) return stream(res, '没有在元素列表里找到输入框：\n' + lastTool.slice(0, 600))
        return toolCall(res, 'type_into_element', { id: idOf(line), text: 'Hello SoM v0.7 编号点击' }, `在 [${idOf(line)}] 输入框里输入文字。`)
      }
      if (step === 3) {
        const line = findLine(/^\[\d+\] 菜单 "(Help|帮助)/)
        if (!line) return stream(res, '没有找到 Help 菜单：\n' + lastTool.slice(0, 600))
        log.somHelpLine = line
        return toolCall(res, 'click_element', { id: idOf(line) }, `点击 [${idOf(line)}] Help 菜单。`)
      }
      if (step === 4) return toolCall(res, 'computer_screenshot', {}, 'Help 菜单已展开，截图确认。')
      if (step === 5) return toolCall(res, 'key_press', { keys: 'escape' }, '确认完毕，关闭菜单。')
      return stream(res, `编号控件操作完成 ✅\n\n- ${allToolText[2]?.split('\n')[0] || ''}\n- ${allToolText[3]?.split('\n')[0] || ''}`, { delay: 2, size: 12 })
    }
    if (userText.includes('E2E_GROUND_VM')) {
      if (step === 0) return toolCall(res, 'open_app', { name: 'xterm', args: ['-bg', 'red', '-fg', 'white', '-geometry', '28x6+760+460', '-T', 'RedTarget', '-e', 'sleep', '3600'] }, '打开一个红色的目标窗口。')
      if (step === 1) {
        await sleep(1500)
        return toolCall(res, 'click_target', { description: '屏幕上红色背景的小窗口' }, '让 grounding 模型找到红色窗口并点击。')
      }
      return stream(res, `grounding 点击完成 ✅ ${lastTool.split('\n')[0]}`)
    }
    if (userText.includes('E2E_BUDGET')) {
      log.budgetCalls = (log.budgetCalls || 0) + 1
      return toolCall(res, 'list_dir', {}, step === 0 ? '这个任务要反复读取大量资料……' : '')
    }
    if (userText.includes('E2E_VNC_QEMU')) {
      const seq = [
        ['computer_screenshot', {}, '先看一下虚拟机屏幕。'],
        ['type_text', { text: 'root' }, '在登录提示处输入用户名。'],
        ['key_press', { keys: 'enter' }],
        ['type_text', { text: 'echo VNC-OK-$((6*7)) > /dev/ttyS0; echo VNC-OK-$((6*7))' }, '输入一条命令（结果同时写到串口，方便核对）。'],
        ['key_press', { keys: 'enter' }],
        ['computer_screenshot', {}]
      ]
      if (step === 3) await sleep(2500)
      if (step < seq.length) return toolCall(res, seq[step][0], seq[step][1], seq[step][2] || '')
      return stream(res, `虚拟机里的命令已执行 ✅（全程通过 QEMU 的 VNC 键鼠通道，没有操作本机）`)
    }
    if (userText.includes('E2E_VNC_WIN')) {
      if (step === 0) return toolCall(res, 'computer_screenshot', {}, '先看看 Windows 虚拟机的屏幕。')
      if (step === 1) return toolCall(res, 'get_ui_elements', {})
      if (step === 2) {
        const b = opts.vncButton || { x1: 0, y1: 0, x2: 0, y2: 0 }
        const lines = (allToolText[1] || '').split('\n').filter((l) => /^\[\d+\]/.test(l))
        const inBtn = lines.find((l) => {
          const m = /@\((\d+),(\d+)\)/.exec(l)
          return m && +m[1] >= b.x1 && +m[1] <= b.x2 && +m[2] >= b.y1 && +m[2] <= b.y2
        })
        log.vncList = allToolText[1]?.slice(0, 2000)
        if (inBtn) return toolCall(res, 'click_element', { id: idOf(inBtn) }, `点击 [${idOf(inBtn)}]（「确定」按钮）。`)
        return toolCall(res, 'mouse_click', { x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) }, '列表里没有编号，按坐标点击。')
      }
      if (step === 3) return toolCall(res, 'type_text', { text: 'hello vnc' })
      if (step === 4) return toolCall(res, 'key_press', { keys: 'enter' })
      return stream(res, `Windows 虚拟机操作完成 ✅（通过 VNC）。${lastTool.split('\n')[0]}`)
    }
    if (userText.includes('E2E_PROXY')) return stream(res, `代理连通 ✅ host=${req.headers.host}`)
    if (userText.includes('E2E_KEY_CHECK')) return stream(res, `收到，鉴权头：${(req.headers.authorization || '').slice(0, 13)}…`)
    return stream(res, `收到：${userText.slice(0, 50)}`)
  }

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${server.address().port}` })))
}
