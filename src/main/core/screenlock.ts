/** 屏幕锁：只有一块屏幕，同一时间只允许一个智能体控制电脑，其它的按先来后到排队 */
export interface ScreenLockEvent {
  owner: string
  requestedAt: number
  acquiredAt: number
  releasedAt?: number
}

interface Waiter {
  key: string
  requestedAt: number
  resolve: () => void
  reject: (e: Error) => void
  cleanup: () => void
}

export class ScreenLock {
  owner: string | null = null
  private queue: Waiter[] = []
  readonly history: ScreenLockEvent[] = []

  constructor(private onChange?: (owner: string | null, queue: string[]) => void) {}

  get waiting(): string[] {
    return this.queue.map((w) => w.key)
  }

  private grant(key: string, requestedAt: number): void {
    this.owner = key
    this.history.push({ owner: key, requestedAt, acquiredAt: Date.now() })
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)
  }

  private changed(): void {
    this.onChange?.(this.owner, this.waiting)
  }

  /** 获取锁（同一 key 可重入）；signal 中止时退出队列并抛出错误 */
  acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (this.owner === key) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(new Error('已取消'))
    const requestedAt = Date.now()
    if (!this.owner) {
      this.grant(key, requestedAt)
      this.changed()
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.queue = this.queue.filter((w) => w !== waiter)
        this.changed()
        reject(new Error('已取消'))
      }
      const waiter: Waiter = {
        key,
        requestedAt,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.changed()
    })
  }

  release(key: string): void {
    if (this.owner !== key) {
      const w = this.queue.find((x) => x.key === key)
      if (w) {
        w.cleanup()
        this.queue = this.queue.filter((x) => x !== w)
        this.changed()
      }
      return
    }
    const cur = [...this.history].reverse().find((h) => h.owner === key && !h.releasedAt)
    if (cur) cur.releasedAt = Date.now()
    this.owner = null
    const next = this.queue.shift()
    if (next) {
      next.cleanup()
      this.grant(next.key, next.requestedAt)
      next.resolve()
    }
    this.changed()
  }
}
