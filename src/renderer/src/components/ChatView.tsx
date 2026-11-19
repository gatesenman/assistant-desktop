import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Assistant, ChatMessage, MessageUsage, Settings } from '../../../shared/types'
import MessageItem, { formatTime } from './MessageItem'
import Mic from './Mic'
import Onboarding from './Onboarding'
import Icon from './Icon'

interface Props {
  assistant: Assistant
  settings: Settings
  messages: ChatMessage[]
  loaded: boolean
  running: boolean
  computerActive: boolean
  takeoverActive?: boolean
  takeoverReason?: string
  teachRecording?: boolean
  threads?: { id: string; title: string }[]
  onOpenGlobal(): void
  onOpenRoutines(): void
  onOpenTask(): void
  onOpenModelPicker(): void
  onOpenComputer(): void
  onOpenUsage?(): void
  onState(s: AppState): void
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function matches(m: ChatMessage, q: string): boolean {
  const s = q.toLowerCase()
  if (m.content.toLowerCase().includes(s)) return true
  return !!m.toolCalls?.some((t) => (t.result || '').toLowerCase().includes(s) || t.arguments.toLowerCase().includes(s))
}

function dividerText(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
  return formatTime(ts)
}

export default function ChatView(p: Props): JSX.Element {
  const { assistant, settings, messages, running } = p
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)

  useEffect(() => {
    stick.current = true
    setText('')
    setImages([])
    setErr('')
    setQuery('')
    setSearchOpen(false)
    taRef.current?.focus()
  }, [assistant.id])

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchRef.current?.focus(), 0)
      }
    }
    const open = (): void => {
      setSearchOpen(true)
      setTimeout(() => searchRef.current?.focus(), 0)
    }
    window.addEventListener('keydown', h)
    window.addEventListener('open-chat-search', open)
    return () => {
      window.removeEventListener('keydown', h)
      window.removeEventListener('open-chat-search', open)
    }
  }, [])

  const q = searchOpen ? query.trim() : ''
  const visible = useMemo(() => (q ? messages.filter((m) => m.role !== 'tool' && matches(m, q)) : messages), [messages, q])
  // v0.7：每轮回复的累计用量，显示在该轮最后一条回复下
  const turnUsage = useMemo(() => {
    const out = new Map<string, MessageUsage>()
    if (settings.showUsage === false) return out
    let acc: MessageUsage | undefined
    let lastAsst: ChatMessage | undefined
    const flush = (): void => {
      if (acc && lastAsst && !lastAsst.streaming) out.set(lastAsst.id, acc)
      acc = undefined
      lastAsst = undefined
    }
    for (const m of messages) {
      if (m.role === 'user') flush()
      else if (m.role === 'assistant') {
        lastAsst = m
        const u = m.usage
        if (u)
          acc = acc
            ? { ...acc, input: acc.input + u.input, output: acc.output + u.output, cacheHit: acc.cacheHit + u.cacheHit, reasoning: (acc.reasoning || 0) + (u.reasoning || 0) || undefined, cost: acc.cost + u.cost, priced: acc.priced && u.priced, calls: acc.calls + u.calls, estimated: acc.estimated || u.estimated, peak: acc.peak || u.peak, model: u.model }
            : { ...u }
      }
    }
    flush()
    return out
  }, [messages, settings.showUsage])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current && !q) el.scrollTop = el.scrollHeight
  }, [messages, q])

  // 内容尺寸变化（图片加载、窗口从托盘恢复等）时保持贴底
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const toBottom = (): void => {
      if (stick.current && !q) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(toBottom)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return
      // 窗口从托盘恢复后等布局完成再贴底
      requestAnimationFrame(toBottom)
      setTimeout(toBottom, 150)
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [q, p.loaded, messages.length === 0])

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }, [text])

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    for (const f of Array.from(files).filter((f) => f.type.startsWith('image/'))) {
      if (f.size > 8 * 1024 * 1024) {
        setErr(`图片 ${f.name} 超过 8MB`)
        continue
      }
      const url = await readAsDataUrl(f)
      setImages((x) => [...x, url])
    }
  }

  const send = async (t = text): Promise<void> => {
    const content = t.trim()
    if ((!content && images.length === 0) || running) return
    setErr('')
    try {
      stick.current = true
      await window.api.sendMessage(assistant.id, content, images)
      setText('')
      setImages([])
    } catch (e: any) {
      setErr(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="chat">
      {searchOpen && (
        <div className="search-bar" data-testid="search-bar">
          <Icon name="search-line" className="muted" />
          <input
            ref={searchRef}
            className="input sm"
            data-testid="search-input"
            placeholder="搜索当前对话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false)
                setQuery('')
              }
            }}
          />
          <span className="muted small" data-testid="search-count">
            {q ? `${visible.length} 条匹配` : ''}
          </span>
          <button
            className="icon-btn"
            onClick={() => {
              setSearchOpen(false)
              setQuery('')
            }}
          >
            <Icon name="close-line" />
          </button>
        </div>
      )}
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          // 窗口隐藏期间的滚动事件（布局变化导致）不代表用户意图
          if (document.visibilityState !== 'visible') return
          const el = e.currentTarget
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight
          // 只有用户向上滚动才取消「贴底」；内容增长（图片加载）不会取消
          if (dist < 80) stick.current = true
          else if (el.scrollTop < lastTop.current - 2) stick.current = false
          lastTop.current = el.scrollTop
        }}
      >
        {p.loaded && messages.length === 0 ? (
          <Onboarding assistant={assistant} settings={settings} onSend={(s) => void send(s)} onOpenGlobal={p.onOpenGlobal} onOpenRoutines={p.onOpenRoutines} onState={p.onState} />
        ) : (
          <div className="messages-inner">
            {q && visible.length === 0 && <div className="empty-card">没有找到「{q}」</div>}
            {visible.map((m, i) => {
              const prev = visible[i - 1]
              const showDivider = !prev || m.createdAt - prev.createdAt > 15 * 60_000 || new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString()
              return (
                <div key={m.id} className="msg-wrap">
                  {showDivider && m.role !== 'tool' && <div className="time-divider">{dividerText(m.createdAt)}</div>}
                  <MessageItem
                    message={m}
                    assistant={assistant}
                    highlight={q || undefined}
                    onImage={setLightbox}
                    onOpenTask={p.onOpenTask}
                    onRespond={(id, ok) => void window.api.respondTool(id, ok)}
                    onAskRespond={(id, ans) => void window.api.respondAskUser(id, ans)}
                    onConfirmPlan={(mid, action, text) => void window.api.confirmPlan(mid, action, text)}
                    onAlwaysAllow={async (id, tool) => {
                      if (!tool.startsWith('mcp__')) p.onState(await window.api.saveSettings({ autoApprove: { [tool]: true } }))
                      await window.api.respondTool(id, true)
                    }}
                    onTrust={async (id) => {
                      p.onState(await window.api.saveSettings({ trustedMode: true }))
                      await window.api.respondTool(id, true)
                    }}
                    onRetry={!running && i === visible.length - 1 && m.error && !q ? () => void window.api.retryLast(assistant.id) : undefined}
                    onOpenGlobal={p.onOpenGlobal}
                    turnUsage={turnUsage.get(m.id)}
                    cnyPerUsd={settings.cnyPerUsd}
                    onResumeBudget={!running && i === visible.length - 1 && m.errorKind === 'budget' ? () => void window.api.resumeBudget(assistant.id) : undefined}
                    onOpenUsage={p.onOpenUsage}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {(p.threads?.length || 0) > 0 && (
        <div className="thread-bar" data-testid="thread-bar">
          <button
            className="btn sm"
            data-testid="new-thread"
            onClick={async () => {
              await window.api.createThread(assistant.id)
              p.onState(await window.api.getState())
            }}
          >
            <Icon name="chat-new-line" /> 新对话
          </button>
          {(p.threads || []).slice(0, 8).map((t) => (
            <button
              key={t.id}
              className={'chip' + (assistant.activeThreadId === t.id ? ' active' : '')}
              data-testid={`thread-${t.id}`}
              onClick={async () => p.onState(await window.api.switchThread(assistant.id, t.id))}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
      {!settings.apiKeySet && !/localhost|127\.0\.0\.1/.test(settings.baseUrl) && (
        <div className="signin-card" data-testid="signin-needed-card">
          <Icon name="key-2-line" />
          <div>
            <strong>需要登录 / API Key</strong>
            <div className="muted small">配置模型服务商密钥后才能对话。点击下方打开设置。</div>
          </div>
          <button className="btn primary sm" onClick={p.onOpenGlobal}>
            去设置
          </button>
        </div>
      )}
      <div className="composer-wrap">
        {(p.computerActive || p.takeoverActive) && (
          <div className="computer-banner" data-testid="computer-banner" data-takeover={p.takeoverActive ? '1' : '0'}>
            <Icon name={p.takeoverActive ? 'hand-heart-line' : 'computer-line'} className="cb-icon" />
            <span className="cb-text">
              {p.takeoverActive
                ? `你已接管电脑${p.takeoverReason ? ' · ' + p.takeoverReason : ''} · 完成后点「交还继续」`
                : '正在控制电脑 · 按 Ctrl+Alt+Esc 可随时紧急停止'}
            </span>
            {!p.takeoverActive && (
              <button className="btn sm" data-testid="takeover-btn" onClick={() => void window.api.takeover(p.assistant.id, '用户从聊天栏接管')}>
                <Icon name="hand-heart-line" /> 我来接管
              </button>
            )}
            {p.takeoverActive && (
              <button className="btn sm primary" data-testid="handback-btn" onClick={() => void window.api.handback(p.assistant.id, '')}>
                <Icon name="play-circle-line" /> 交还继续
              </button>
            )}
            <button className="cb-stop" data-testid="computer-stop-btn" onClick={() => void window.api.emergencyStop()}>
              <Icon name="stop-circle-line" /> 停止控制
            </button>
          </div>
        )}
        {err && <div className="composer-error">{err}</div>}
        {images.length > 0 && (
          <div className="attach-row">
            {images.map((src, i) => (
              <div className="attach" key={i}>
                <img src={src} alt="" />
                <button onClick={() => setImages((x) => x.filter((_, j) => j !== i))}>
                  <Icon name="close-line" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            void addFiles(e.dataTransfer.files)
          }}
        >
          <button className="cp-icon" title="添加图片" data-testid="attach-btn" onClick={() => fileRef.current?.click()}>
            <Icon name="add-line" size={18} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <textarea
            ref={taRef}
            data-testid="composer"
            rows={1}
            value={text}
            placeholder={`给 ${assistant.name} 发消息`}
            title="Enter 发送，Shift+Enter 换行，可粘贴图片；Ctrl/⌘+K 切换助手，Ctrl/⌘+F 搜索"
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files)
              if (files.some((f) => f.type.startsWith('image/'))) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <Mic
            onText={(t) => {
              setText((cur) => (cur ? cur + (cur.endsWith(' ') ? '' : ' ') + t : t))
              taRef.current?.focus()
            }}
            onError={setErr}
          />
          <div className="composer-tools" data-testid="composer-tools">
            <div className="ask-auto" data-testid="ask-auto-toggle">
              <button
                className={(assistant.runStyle || 'ask') === 'ask' ? 'active' : ''}
                data-testid="run-ask"
                onClick={() => void window.api.setRunStyle(assistant.id, 'ask').then(p.onState)}
                title="Ask：逐步审批工具"
              >
                Ask
              </button>
              <button
                className={(assistant.runStyle || 'ask') === 'auto' ? 'active' : ''}
                data-testid="run-auto"
                onClick={() => void window.api.setRunStyle(assistant.id, 'auto').then(p.onState)}
                title="Auto：信任模式自动批准"
              >
                Auto
              </button>
            </div>
            <button className="model-chip" data-testid="model-chip" title="选择模型" onClick={p.onOpenModelPicker}>
              <Icon name="cpu-line" /> {(assistant.model || settings.model || '模型').split('/').pop()}
            </button>
            <button className="cp-icon" data-testid="open-computer-panel" title="电脑面板" onClick={p.onOpenComputer}>
              <Icon name="computer-line" />
            </button>
          </div>
          {running ? (
            <button className="send-round stop" data-testid="stop-btn" title="停止" onClick={() => void window.api.stop(assistant.id)}>
              <Icon name="stop-fill" size={16} />
            </button>
          ) : (
            <button className="send-round" data-testid="send-btn" title="发送" disabled={!text.trim() && images.length === 0} onClick={() => void send()}>
              <Icon name="arrow-up-line" size={18} />
            </button>
          )}
        </div>
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  )
}
