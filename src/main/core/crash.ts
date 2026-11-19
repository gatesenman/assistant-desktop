import fs from 'fs'
import path from 'path'

export interface CrashGuardOptions {
  /** 重启应用（Electron 中为 app.relaunch + app.exit） */
  relaunch: (args: string[]) => void
  argv: string[]
  enabled: boolean
  /** 时间窗口内最多自动重启次数，默认 10 分钟 3 次 */
  maxRestarts?: number
  windowMs?: number
  now?: () => number
}

/** 崩溃守护：记录崩溃日志，并在主进程未捕获异常时自动重启（带频率限制，防止重启风暴） */
export class CrashGuard {
  readonly logFile: string
  readonly stateFile: string
  readonly startFile: string
  private handling = false

  constructor(
    private dir: string,
    private opts: CrashGuardOptions
  ) {
    this.logFile = path.join(dir, 'crash.log')
    this.stateFile = path.join(dir, 'crash-state.json')
    this.startFile = path.join(dir, 'startup.log')
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  log(msg: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.logFile, `[${new Date(this.now()).toISOString()}] ${msg}\n`)
      const st = fs.statSync(this.logFile)
      if (st.size > 512 * 1024) {
        const tail = fs.readFileSync(this.logFile, 'utf8').slice(-256 * 1024)
        fs.writeFileSync(this.logFile, tail)
      }
    } catch {
      /* 忽略日志失败 */
    }
  }

  markStart(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const line = JSON.stringify({ pid: process.pid, at: this.now(), restarted: this.opts.argv.includes('--crash-restarted') })
      let prev = ''
      try {
        prev = fs.readFileSync(this.startFile, 'utf8').split('\n').filter(Boolean).slice(-49).join('\n')
      } catch {
        /* 首次启动 */
      }
      fs.writeFileSync(this.startFile, (prev ? prev + '\n' : '') + line + '\n')
    } catch {
      /* ignore */
    }
  }

  markCleanExit(): void {
    this.log(`正常退出 pid=${process.pid}`)
  }

  private recentRestarts(): number[] {
    try {
      const arr = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      return Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : []
    } catch {
      return []
    }
  }

  /** 处理致命错误；返回是否触发了重启 */
  handleFatal(err: unknown): boolean {
    const e = err as any
    this.log(`主进程未捕获异常：${e?.stack || e?.message || String(err)}`)
    if (!this.opts.enabled || this.handling) return false
    const windowMs = this.opts.windowMs ?? 10 * 60_000
    const max = this.opts.maxRestarts ?? 3
    const now = this.now()
    const recent = this.recentRestarts().filter((t) => now - t < windowMs)
    if (recent.length >= max) {
      this.log(`近 ${Math.round(windowMs / 60000)} 分钟内已自动重启 ${recent.length} 次，不再重启`)
      return false
    }
    recent.push(now)
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(recent))
    } catch {
      /* ignore */
    }
    this.handling = true
    this.log('正在自动重启…')
    const args = this.opts.argv.filter((a) => a !== '--crash-restarted')
    args.push('--crash-restarted')
    this.opts.relaunch(args)
    return true
  }

  install(): void {
    process.on('uncaughtException', (err) => {
      this.handleFatal(err)
    })
    process.on('unhandledRejection', (reason) => {
      const r = reason as any
      this.log(`未处理的 Promise 拒绝：${r?.stack || r?.message || String(reason)}`)
    })
  }
}
