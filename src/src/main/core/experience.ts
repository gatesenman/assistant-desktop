import fs from 'fs'
import path from 'path'
import { uid } from './util'

export interface ExperienceEntry {
  id: string
  app: string
  keywords: string[]
  summary: string
  steps: number
  success: boolean
  createdAt: number
  assistantId?: string
}

/** 成功轨迹经验库：按应用 / 关键词索引，供系统提示检索 */
export class ExperienceStore {
  private file: string
  private items: ExperienceEntry[] = []

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'experience.json')
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.items = []
    }
  }

  list(): ExperienceEntry[] {
    return [...this.items]
  }

  add(e: Omit<ExperienceEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): ExperienceEntry {
    const entry: ExperienceEntry = {
      ...e,
      id: e.id || uid(),
      createdAt: e.createdAt || Date.now(),
      keywords: (e.keywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean)
    }
    this.items.unshift(entry)
    if (this.items.length > 200) this.items = this.items.slice(0, 200)
    this.save()
    return entry
  }

  /** 简单关键词检索，返回最相关的若干条 */
  search(query: string, limit = 5): ExperienceEntry[] {
    const tokens = tokenize(query)
    if (!tokens.length) return this.items.filter((x) => x.success).slice(0, limit)
    const scored = this.items
      .filter((x) => x.success)
      .map((e) => {
        let score = 0
        const hay = [e.app, e.summary, ...e.keywords].join(' ').toLowerCase()
        for (const t of tokens) {
          if (e.keywords.includes(t)) score += 3
          if (e.app.toLowerCase().includes(t)) score += 2
          if (hay.includes(t)) score += 1
        }
        return { e, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.e.createdAt - a.e.createdAt)
    return scored.slice(0, limit).map((x) => x.e)
  }

  /** 注入系统提示的摘要段落 */
  promptBlock(query: string, limit = 5): string {
    const hits = this.search(query, limit)
    if (!hits.length) return ''
    return (
      '## 相关成功经验（可参考，勿机械照搬）\n' +
      hits.map((e, i) => `${i + 1}. [${e.app || '通用'}] ${e.summary}（约 ${e.steps} 步）`).join('\n')
    )
  }

  private save(): void {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2))
    fs.renameSync(tmp, this.file)
  }
}

function tokenize(q: string): string[] {
  return String(q || '')
    .toLowerCase()
    .split(/[\s,，、;；|/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}
