import fs from 'fs'
import path from 'path'
import type { SkillMeta, Workflow } from '../../shared/types'
import { uid } from './util'

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseFront(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(FRONT)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: md.slice(m[0].length) }
}

export function builtinSkillsDir(appPath: string): string {
  return path.join(appPath, 'skills', 'builtin')
}

export class SkillStore {
  constructor(
    private userDir: string,
    private builtinDir: string
  ) {
    fs.mkdirSync(userDir, { recursive: true })
  }

  list(): SkillMeta[] {
    const out: SkillMeta[] = []
    const scan = (root: string, builtin: boolean): void => {
      if (!fs.existsSync(root)) return
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name)
        const file = fs.existsSync(path.join(dir, 'SKILL.md')) ? path.join(dir, 'SKILL.md') : path.join(root, name)
        if (!file.endsWith('.md') && !fs.existsSync(path.join(dir, 'SKILL.md'))) continue
        const mdPath = file.endsWith('SKILL.md') || fs.existsSync(path.join(dir, 'SKILL.md')) ? path.join(dir, 'SKILL.md') : file
        if (!fs.existsSync(mdPath)) continue
        const { meta } = parseFront(fs.readFileSync(mdPath, 'utf8'))
        const id = meta.id || (builtin ? 'builtin/' + name : name.replace(/\.md$/, ''))
        out.push({
          id,
          name: meta.name || name,
          description: meta.description || '',
          path: mdPath,
          builtin,
          triggers: (meta.triggers || '').split(',').map((s) => s.trim()).filter(Boolean),
          tools: (meta.tools || '').split(',').map((s) => s.trim()).filter(Boolean)
        })
      }
    }
    scan(this.builtinDir, true)
    scan(this.userDir, false)
    return out
  }

  read(id: string): { meta: SkillMeta; body: string } {
    const m = this.list().find((s) => s.id === id)
    if (!m) throw new Error('技能不存在：' + id)
    const { body, meta } = parseFront(fs.readFileSync(m.path, 'utf8'))
    return { meta: { ...m, name: meta.name || m.name, description: meta.description || m.description }, body }
  }

  save(id: string, body: string, patch?: Partial<SkillMeta>): SkillMeta {
    if (id.startsWith('builtin/')) throw new Error('内置技能只读，请另存为用户技能')
    const dir = path.join(this.userDir, id)
    fs.mkdirSync(dir, { recursive: true })
    const name = patch?.name || id
    const description = patch?.description || ''
    const md = `---\nid: ${id}\nname: ${name}\ndescription: ${description}\ntriggers: ${(patch?.triggers || []).join(', ')}\ntools: ${(patch?.tools || []).join(', ')}\n---\n\n${body.replace(FRONT, '')}`
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md)
    return this.read(id).meta
  }

  delete(id: string): void {
    if (id.startsWith('builtin/')) throw new Error('不能删除内置技能')
    const dir = path.join(this.userDir, id)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  /** 供系统提示注入：已启用技能的摘要 */
  promptSummary(enabled?: string[]): string {
    const all = this.list()
    const list = !enabled?.length ? all : all.filter((s) => enabled.includes(s.id))
    if (!list.length) return ''
    return (
      '## 可用技能（需要时用 load_skill 加载完整说明）\n' +
      list.map((s) => `- ${s.id}：${s.name} — ${s.description}`).join('\n')
    )
  }
}

export class WorkflowStore {
  private file: string
  private items: Workflow[] = []
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'workflows.json')
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.items = []
    }
  }
  list(): Workflow[] {
    return this.items
  }
  save(w: Workflow): Workflow {
    const now = Date.now()
    const next = { ...w, id: w.id || uid(), updatedAt: now, createdAt: w.createdAt || now }
    const i = this.items.findIndex((x) => x.id === next.id)
    if (i >= 0) this.items[i] = next
    else this.items.push(next)
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2))
    return next
  }
  delete(id: string): void {
    this.items = this.items.filter((x) => x.id !== id)
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2))
  }
}
