import fs from 'fs'
import path from 'path'
import util from 'util'

/** 去除日志中的敏感信息 */
export function redact(text: string, secrets: string[] = []): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[已隐藏]')
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[已隐藏]')
    .replace(/\b(sk|xai|gsk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-[已隐藏]')
    .replace(/("?(api[_-]?key|apiKeyEnc|authorization|password|token)"?\s*[:=]\s*")[^"]+"/gi, '$1[已隐藏]"')
}

/** 把主进程的 console 输出同时写入 logs/main.log（超过 2MB 轮转一次） */
export function teeConsole(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'main.log')
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1')
  } catch {
    /* ignore */
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`)
      } catch {
        /* ignore */
      }
    }
  }
  return file
}

function tail(file: string, max = 200_000): string {
  try {
    const buf = fs.readFileSync(file)
    return buf.subarray(Math.max(0, buf.length - max)).toString('utf8')
  } catch {
    return '(无)'
  }
}

/** 生成用于反馈问题的诊断包（纯文本，已去除密钥） */
export function buildLogBundle(o: { userData: string; info: Record<string, unknown>; settings: Record<string, unknown>; secrets: string[] }): string {
  const parts: string[] = []
  parts.push('=== 助手桌面版 诊断信息 ===')
  parts.push(`生成时间：${new Date().toISOString()}`)
  for (const [k, v] of Object.entries(o.info)) parts.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  const { apiKey: _k, apiKeyEnc: _e, ...safe } = o.settings as any
  void _k
  void _e
  parts.push('\n=== 设置（已去除 API Key）===\n' + JSON.stringify({ ...safe, apiKeySet: !!_k }, null, 2))
  for (const f of ['logs/main.log.1', 'logs/main.log', 'startup.log', 'crash.log']) {
    const p = path.join(o.userData, f)
    if (fs.existsSync(p)) parts.push(`\n=== ${f} ===\n` + tail(p))
  }
  return redact(parts.join('\n'), o.secrets)
}
