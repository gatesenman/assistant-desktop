import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import type { ToolDef } from './llm'
import { truncate } from './util'

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: '在用户电脑上执行一条 shell 命令并返回 stdout/stderr 与退出码。默认工作目录为用户配置的工作目录。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '可选：工作目录' },
          timeout_sec: { type: 'number', description: '可选：超时时间（秒），默认 60' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件的内容（UTF-8）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径（绝对路径或相对工作目录）' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把内容写入文件（会覆盖已存在的文件，自动创建父目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的完整内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录中的文件和子目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录路径，默认工作目录' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取一个 URL 的内容并返回纯文本（HTML 会被转换为文本）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) 地址' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        '把关于用户的重要、长期有效的事实或偏好保存到长期记忆中（例如姓名、习惯、项目信息）。保存后会在以后的对话中自动提供给你。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '一句简洁的事实描述' } },
        required: ['text']
      }
    }
  }
]

export interface ToolContext {
  workDir: string
  saveMemory: (text: string) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

const MAX_OUT = 20000

export function resolvePath(p: string | undefined, workDir: string): string {
  let s = (p || '').trim()
  if (!s) return workDir
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1))
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(workDir, s)
}

export function htmlToText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'cmd.exe' : process.env.SHELL || '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd,
      env: process.env,
      windowsHide: true,
      // 非 Windows 下创建独立进程组，便于超时/停止时连同子进程一起结束
      detached: !isWin
    })
    let stdout = ''
    let stderr = ''
    let killed = ''
    const kill = (why: string): void => {
      killed = why
      try {
        if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
    const timer = setTimeout(() => kill(`超时（${Math.round(timeoutMs / 1000)} 秒）`), timeoutMs)
    const onAbort = (): void => kill('已被用户停止')
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUT * 2) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUT * 2) stderr += d.toString()
    })
    const finish = (code: number | null, err?: Error): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const parts = [`退出码: ${code ?? 'null'}${killed ? `（${killed}）` : ''}`]
      if (err) parts.push(`错误: ${err.message}`)
      if (stdout) parts.push(`stdout:\n${truncate(stdout, MAX_OUT)}`)
      if (stderr) parts.push(`stderr:\n${truncate(stderr, MAX_OUT / 2)}`)
      resolve(parts.join('\n'))
    }
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}

/** 执行一个工具，返回给模型的字符串结果。出错时抛出异常。 */
export async function executeTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  switch (name) {
    case 'run_shell': {
      if (!args.command || typeof args.command !== 'string') throw new Error('缺少参数 command')
      const cwd = resolvePath(args.cwd, ctx.workDir)
      const timeout = Math.min(Math.max(Number(args.timeout_sec) || 60, 1), 600) * 1000
      return runShell(args.command, cwd, timeout, ctx.signal)
    }
    case 'read_file': {
      const p = resolvePath(args.path, ctx.workDir)
      const st = await fs.stat(p)
      if (st.isDirectory()) throw new Error(`${p} 是一个目录`)
      if (st.size > 2 * 1024 * 1024) throw new Error(`文件过大（${st.size} 字节）`)
      const text = await fs.readFile(p, 'utf8')
      return truncate(text, 100000)
    }
    case 'write_file': {
      const p = resolvePath(args.path, ctx.workDir)
      if (typeof args.content !== 'string') throw new Error('缺少参数 content')
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, args.content, 'utf8')
      return `已写入 ${p}（${Buffer.byteLength(args.content, 'utf8')} 字节）`
    }
    case 'list_dir': {
      const p = resolvePath(args.path, ctx.workDir)
      const entries = await fs.readdir(p, { withFileTypes: true })
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      const lines: string[] = []
      for (const e of entries.slice(0, 500)) {
        if (e.isDirectory()) lines.push(`[目录] ${e.name}/`)
        else {
          let size = ''
          try {
            size = ` (${(await fs.stat(path.join(p, e.name))).size} B)`
          } catch {
            /* ignore */
          }
          lines.push(`[文件] ${e.name}${size}`)
        }
      }
      if (entries.length > 500) lines.push(`…共 ${entries.length} 项，仅显示前 500 项`)
      return `${p}\n${lines.join('\n') || '(空目录)'}`
    }
    case 'web_fetch': {
      const url = String(args.url || '')
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 地址')
      const f = ctx.fetchImpl || fetch
      const signals = [AbortSignal.timeout(20000)]
      if (ctx.signal) signals.push(ctx.signal)
      const res = await f(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 AssistantDesktop/0.1', Accept: 'text/html,text/plain,application/json,*/*' },
        redirect: 'follow',
        signal: AbortSignal.any(signals)
      })
      const ct = res.headers.get('content-type') || ''
      const raw = await res.text()
      const text = /html/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw
      return `HTTP ${res.status} ${ct}\n\n${truncate(text, MAX_OUT)}`
    }
    case 'save_memory': {
      const text = String(args.text || '').trim()
      if (!text) throw new Error('记忆内容为空')
      ctx.saveMemory(text)
      return `已保存到长期记忆：${text}`
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}
