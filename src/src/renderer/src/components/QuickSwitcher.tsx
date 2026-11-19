import { useEffect, useMemo, useRef, useState } from 'react'
import type { Assistant } from '../../../shared/types'
import Avatar from './Avatar'

export default function QuickSwitcher({
  assistants,
  unread,
  running,
  onPick,
  onClose
}: {
  assistants: Assistant[]
  unread: Record<string, boolean>
  running: Record<string, boolean>
  onPick(id: string): void
  onClose(): void
}): JSX.Element {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? assistants.filter((a) => a.name.toLowerCase().includes(s) || a.systemPrompt.toLowerCase().includes(s)) : assistants
  }, [q, assistants])
  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setIdx(0), [q])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="switcher" data-testid="quick-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="switcher-input"
          placeholder="搜索助手…（↑↓ 选择，Enter 打开，Esc 关闭）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(i + 1, list.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              if (list[idx]) onPick(list[idx].id)
            } else if (e.key === 'Escape') onClose()
          }}
        />
        <div className="switcher-list">
          {list.length === 0 && <div className="switcher-empty">没有匹配的助手</div>}
          {list.map((a, i) => (
            <div key={a.id} className={'switcher-item' + (i === idx ? ' active' : '')} onMouseEnter={() => setIdx(i)} onClick={() => onPick(a.id)}>
              <Avatar name={a.name} color={a.color} size={26} />
              <span className="switcher-name">{a.name}</span>
              {running[a.id] && <span className="pill">回复中</span>}
              {unread[a.id] && <span className="pill accent">新消息</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
