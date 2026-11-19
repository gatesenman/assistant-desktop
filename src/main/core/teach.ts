import fs from 'fs'
import path from 'path'
import { uid } from './util'
import type { SkillStore } from './skills'

export interface TeachEvent {
  at: number
  kind: 'click' | 'type' | 'key' | 'scroll' | 'uia' | 'note'
  x?: number
  y?: number
  text?: string
  key?: string
  target?: string
  role?: string
  name?: string
}

export interface TeachSession {
  id: string
  title: string
  startedAt: number
  endedAt?: number
  events: TeachEvent[]
  assistantId?: string
}

/** 录制示教：记录键鼠 / UIA 目标，启发式生成可审阅的 SKILL.md 草稿 */
export class TeachRecorder {
  private current: TeachSession | null = null
  private dir: string

  constructor(dir: string, private skills?: SkillStore) {
    this.dir = path.join(dir, 'teach')
    fs.mkdirSync(this.dir, { recursive: true })
  }

  get active(): TeachSession | null {
    return this.current
  }

  start(title: string, assistantId?: string): TeachSession {
    if (this.current) throw new Error('已有进行中的示教录制，请先停止')
    this.current = {
      id: uid(),
      title: title.trim() || '未命名示教',
      startedAt: Date.now(),
      events: [],
      assistantId
    }
    return this.current
  }

  record(ev: Omit<TeachEvent, 'at'> & { at?: number }): void {
    if (!this.current) throw new Error('未在录制')
    this.current.events.push({ ...ev, at: ev.at || Date.now() })
  }

  stop(): TeachSession {
    if (!this.current) throw new Error('未在录制')
    this.current.endedAt = Date.now()
    const s = this.current
    this.current = null
    fs.writeFileSync(path.join(this.dir, `${s.id}.json`), JSON.stringify(s, null, 2))
    return s
  }

  /** 启发式模板生成技能草稿（无真实 LLM Key 时也可审阅） */
  toSkillDraft(session: TeachSession): { id: string; body: string; meta: { name: string; description: string; triggers: string[]; tools: string[] } } {
    const id = 'taught-' + session.title.replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || session.id.slice(0, 8)
    const steps = session.events.map((e, i) => {
      const n = i + 1
      switch (e.kind) {
        case 'click':
          return `${n}. 点击${e.target || e.name ? `「${e.target || e.name}」` : ''}（${e.role || '控件'}）${e.x != null ? ` @(${e.x},${e.y})` : ''}`
        case 'type':
          return `${n}. 输入「${(e.text || '').slice(0, 80)}」${e.target ? ` 到「${e.target}」` : ''}`
        case 'key':
          return `${n}. 按键 ${e.key || ''}`
        case 'scroll':
          return `${n}. 滚动${e.text || ''}`
        case 'uia':
          return `${n}. 操作 UIA 目标「${e.name || e.target || ''}」（${e.role || ''}）`
        default:
          return `${n}. ${e.text || '备注'}`
      }
    })
    const tools = ['computer_screenshot', 'mouse_click', 'type_text', 'key_press', 'get_ui_elements', 'click_element']
    const body = [
      `# ${session.title}`,
      '',
      `> 由示教录制自动生成（${new Date(session.startedAt).toLocaleString('zh-CN', { hour12: false })}），请人工审阅后再启用。`,
      '',
      '## 目标',
      `复现用户示教的操作流程：${session.title}`,
      '',
      '## 步骤',
      ...(steps.length ? steps : ['1. （示教中未记录到有效动作）']),
      '',
      '## 注意事项',
      '- 每步后截图核对；控件编号优先于纯坐标。',
      '- 遇到登录 / 验证码时调用 ask_user 或请求用户接管。',
      ''
    ].join('\n')
    return {
      id,
      body,
      meta: {
        name: session.title,
        description: `示教生成：${session.title}（${session.events.length} 步）`,
        triggers: [session.title],
        tools
      }
    }
  }

  saveAsSkill(session: TeachSession): { id: string; path?: string } {
    const draft = this.toSkillDraft(session)
    if (!this.skills) {
      const dir = path.join(this.dir, 'skills-draft', draft.id)
      fs.mkdirSync(dir, { recursive: true })
      const md = `---\nid: ${draft.id}\nname: ${draft.meta.name}\ndescription: ${draft.meta.description}\ntriggers: ${draft.meta.triggers.join(', ')}\ntools: ${draft.meta.tools.join(', ')}\n---\n\n${draft.body}`
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md)
      return { id: draft.id, path: path.join(dir, 'SKILL.md') }
    }
    const meta = this.skills.save(draft.id, draft.body, draft.meta)
    return { id: meta.id, path: meta.path }
  }
}
