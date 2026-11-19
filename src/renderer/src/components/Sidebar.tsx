import { useMemo, useState } from 'react'
import type { AppState, TaskInfo } from '../../../shared/types'
import Avatar from './Avatar'
import Icon from './Icon'

interface Props {
  state: AppState
  selected: string | null
  running: Record<string, boolean>
  unread: Record<string, boolean>
  previews: Record<string, { text: string; at: number }>
  theme: 'light' | 'dark'
  nav: 'chat' | 'apps' | 'automations' | 'settings' | null
  onSelect(id: string): void
  onCreate(name: string): void
  onRename(id: string, name: string): void
  onDelete(id: string): void
  onDuplicate(id: string): void
  onPin(id: string, pinned: boolean): void
  onHide(id: string): void
  onOpenApps(): void
  onOpenAutomations(): void
  onOpenSettings(): void
  onToggleTheme(): void
  onOpenSwitcher(): void
  tasks: TaskInfo[]
}

function shortTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function Sidebar(p: Props): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<string | null>(null)

  const bots = useMemo(() => {
    let list = p.state.assistants.filter((a) => !a.hidden)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      list = list.filter((a) => a.name.toLowerCase().includes(s) || (p.previews[a.id]?.text || '').toLowerCase().includes(s))
    }
    return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (p.previews[b.id]?.at || b.createdAt) - (p.previews[a.id]?.at || a.createdAt))
  }, [p.state.assistants, p.previews, q])

  const commitRename = (): void => {
    if (editing && draft.trim()) p.onRename(editing, draft.trim())
    setEditing(null)
  }
  const commitCreate = (): void => {
    if (newName.trim()) p.onCreate(newName.trim())
    setCreating(false)
    setNewName('')
  }

  return (
    <aside className="sidebar maus-sidebar" data-testid="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <Icon name="robot-2-line" /> 小助手
        </div>
        <div className="sidebar-icons">
          <button className="round-icon" data-testid="switcher-trigger" title="搜索（Ctrl/⌘+K）" onClick={p.onOpenSwitcher}>
            <Icon name="search-line" />
          </button>
          <button className="round-icon" data-testid="new-assistant" title="新建助手" onClick={() => setCreating(true)}>
            <Icon name="add-line" />
          </button>
        </div>
      </div>
      <div className="sidebar-search">
        <Icon name="search-line" />
        <input className="input bare" data-testid="bot-search" placeholder="搜索助手或消息" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="bot-list" data-testid="bot-list">
        {creating && (
          <div className="bot-item editing">
            <input
              autoFocus
              className="input sm"
              placeholder="助手名称，回车确认"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitCreate()
                if (e.key === 'Escape') setCreating(false)
              }}
              onBlur={commitCreate}
            />
          </div>
        )}
        {bots.map((a) => {
          const pv = p.previews[a.id]
          const busy = !!p.running[a.id] || p.tasks.some((t) => t.assistantId === a.id && (t.status === 'running' || t.status === 'queued'))
          const unread = !!p.unread[a.id]
          return (
            <div
              key={a.id}
              className={'bot-item' + (p.selected === a.id && p.nav === 'chat' ? ' active' : '') + (busy ? ' busy' : '')}
              data-testid={`bot-${a.id}`}
              data-busy={busy ? '1' : '0'}
              onClick={() => p.onSelect(a.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu(a.id)
              }}
            >
              <div className="bot-avatar-wrap">
                <Avatar name={a.name} color={a.color} size={40} />
                {busy && <span className="busy-dot" data-testid="busy-indicator" />}
                {unread && !busy && <span className="unread-dot" />}
              </div>
              <div className="bot-meta">
                <div className="bot-top">
                  <span className="bot-name">
                    {a.pinned && <Icon name="pushpin-2-fill" className="pin-icon" />}
                    {editing === a.id ? (
                      <input
                        autoFocus
                        className="input sm"
                        value={draft}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        onBlur={commitRename}
                      />
                    ) : (
                      a.name
                    )}
                  </span>
                  <span className="bot-time">{shortTime(pv?.at || a.createdAt)}</span>
                </div>
                <div className="bot-preview muted">{busy ? '正在处理…' : pv?.text || '暂无消息'}</div>
              </div>
              {menu === a.id && (
                <div className="ctx-menu" data-testid="bot-ctx-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => {
                      setEditing(a.id)
                      setDraft(a.name)
                      setMenu(null)
                    }}
                  >
                    重命名
                  </button>
                  <button
                    onClick={() => {
                      p.onPin(a.id, !a.pinned)
                      setMenu(null)
                    }}
                  >
                    {a.pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    onClick={() => {
                      void p.onDuplicate(a.id)
                      setMenu(null)
                    }}
                  >
                    复制
                  </button>
                  <button
                    onClick={() => {
                      p.onHide(a.id)
                      setMenu(null)
                    }}
                  >
                    隐藏
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`删除「${a.name}」？`)) p.onDelete(a.id)
                      setMenu(null)
                    }}
                  >
                    删除
                  </button>
                  <button onClick={() => setMenu(null)}>取消</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="sidebar-footer maus-footer" data-testid="sidebar-footer">
        <button className={'footer-nav' + (p.nav === 'apps' ? ' active' : '')} data-testid="nav-apps" onClick={p.onOpenApps}>
          <Icon name="apps-2-line" /> 已连接应用
        </button>
        <button className={'footer-nav' + (p.nav === 'automations' ? ' active' : '')} data-testid="nav-automations" onClick={p.onOpenAutomations}>
          <Icon name="alarm-line" /> 自动化
        </button>
        <button className={'footer-nav' + (p.nav === 'settings' ? ' active' : '')} data-testid="global-settings-btn" onClick={p.onOpenSettings}>
          <Icon name="settings-3-line" /> 设置
        </button>
        <button className="round-icon" title="切换主题" data-testid="theme-toggle" onClick={p.onToggleTheme}>
          <Icon name={p.theme === 'dark' ? 'sun-line' : 'moon-line'} />
        </button>
      </div>
      {menu && <div className="ctx-backdrop" onClick={() => setMenu(null)} />}
    </aside>
  )
}
