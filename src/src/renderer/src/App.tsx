import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppEvent, AppState, ChatMessage, ComputerLogEntry, TaskInfo, UsageBucket } from '../../shared/types'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import RoutinesView from './components/RoutinesView'
import AssistantSettings from './components/AssistantSettings'
import GlobalSettings from './components/GlobalSettings'
import Avatar from './components/Avatar'
import QuickSwitcher from './components/QuickSwitcher'
import TaskPanel from './components/TaskPanel'
import ComputerLogPanel from './components/ComputerLogPanel'
import ParallelPanel from './components/ParallelPanel'
import Icon from './components/Icon'
import SetupWizard from './components/SetupWizard'
import ConnectorsView from './components/ConnectorsView'
import SkillsView from './components/SkillsView'
import MachinesView from './components/MachinesView'
import ChannelsView from './components/ChannelsView'
import OrchestratorPanel from './components/OrchestratorPanel'
import ComputerPanel from './components/ComputerPanel'
import ModelPicker from './components/ModelPicker'
import UsageView from './components/UsageView'

type Tab = 'chat' | 'routines' | 'settings' | 'connectors' | 'skills' | 'machines' | 'channels' | 'usage'
type Nav = 'chat' | 'apps' | 'automations' | 'settings' | null

function useResolvedTheme(mode: string | undefined): 'light' | 'dark' {
  const [sysDark, setSysDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = (e: MediaQueryListEvent): void => setSysDark(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  if (mode === 'light' || mode === 'dark') return mode
  return sysDark ? 'dark' : 'light'
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
export const modKey = isMac ? '⌘' : 'Ctrl'

export default function App(): JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  const [nav, setNav] = useState<Nav>('chat')
  const [showGlobal, setShowGlobal] = useState(false)
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [unread, setUnread] = useState<Record<string, boolean>>({})
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [switcher, setSwitcher] = useState(false)
  const [panel, setPanel] = useState<'tasks' | 'log' | 'parallel' | 'orch' | 'computer' | null>(null)
  const [modelPicker, setModelPicker] = useState(false)
  const [computerLog, setComputerLog] = useState<ComputerLogEntry[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [usageToday, setUsageToday] = useState<UsageBucket | null>(null)
  const [usageByRoutine, setUsageByRoutine] = useState<Record<string, UsageBucket>>({})
  const taskPanel = panel === 'tasks'
  const setTaskPanel = (v: boolean | ((x: boolean) => boolean)): void =>
    setPanel((cur) => {
      const next = typeof v === 'function' ? v(cur === 'tasks') : v
      return next ? 'tasks' : cur === 'tasks' ? null : cur
    })
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = showGlobal ? null : selected

  const theme = useResolvedTheme(state?.settings.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    if (state) document.documentElement.style.setProperty('--accent', state.settings.accent)
  }, [state?.settings.accent])

  useEffect(() => {
    void window.api.getState().then((s) => {
      setState(s)
      setSelected((cur) => cur ?? s.assistants[0]?.id ?? null)
    })
    void window.api.listTasks().then(setTasks)
    void window.api.getComputerLog().then(setComputerLog)
    const loadUsage = (): void =>
      void window.api
        .getUsage()
        .then((u) => {
          setUsageToday(u.today)
          setUsageByRoutine(u.summary.byRoutine)
        })
        .catch(() => {})
    loadUsage()
    return window.api.onEvent((ev: AppEvent) => {
      switch (ev.type) {
        case 'usage':
          setUsageToday(ev.today)
          loadUsage()
          break
        case 'state-changed':
          setState(ev.state)
          break
        case 'computer-preview':
          setState((s) => (s ? { ...s, computerPreview: { thumb: ev.thumb, at: ev.at, machineId: ev.machineId } } : s))
          break
        case 'local-vm':
          setState((s) => (s ? { ...s, localVm: ev.status } : s))
          break
        case 'vms':
          setState((s) => (s ? { ...s, vms: ev.list } : s))
          break
        case 'run-state':
          setRunning((r) => ({ ...r, [ev.assistantId]: ev.running }))
          break
        case 'messages-reset': {
          const aid = ev.assistantId
          setMessages((m) => ({ ...m, [aid]: [] }))
          void window.api.getMessages(aid).then((list) => setMessages((m) => ({ ...m, [aid]: list })))
          break
        }
        case 'navigate':
          setShowGlobal(false)
          setSelected(ev.assistantId)
          setTab('chat')
          setNav('chat')
          break
        case 'computer-log':
          setComputerLog((l) => [...l.slice(-299), ev.entry])
          break
        case 'runtime':
          setState((s) => (s ? { ...s, runtime: ev.runtime } : s))
          break
        case 'task-upsert':
          setTasks((list) => {
            const i = list.findIndex((t) => t.id === ev.task.id)
            return i >= 0 ? list.map((t, j) => (j === i ? ev.task : t)) : [...list, ev.task]
          })
          break
        case 'message-upsert':
          setMessages((all) => {
            const list = all[ev.assistantId]
            if (!list) return all
            const idx = list.findIndex((x) => x.id === ev.message.id)
            const next = idx >= 0 ? list.map((x, i) => (i === idx ? ev.message : x)) : [...list, ev.message]
            return { ...all, [ev.assistantId]: next }
          })
          if (ev.message.role === 'assistant' && !ev.message.streaming && ev.assistantId !== selectedRef.current) {
            setUnread((u) => ({ ...u, [ev.assistantId]: true }))
          }
          break
        case 'message-delta':
          setMessages((all) => {
            const list = all[ev.assistantId]
            if (!list) return all
            return { ...all, [ev.assistantId]: list.map((x) => (x.id === ev.messageId ? { ...x, content: x.content + ev.delta } : x)) }
          })
          break
      }
    })
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSwitcher((v) => !v)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  useEffect(() => {
    if (!selected) return
    setUnread((u) => (u[selected] ? { ...u, [selected]: false } : u))
    if (!messages[selected]) {
      void window.api.getMessages(selected).then((list) => setMessages((m) => ({ ...m, [selected]: m[selected] ?? list })))
      void window.api.isRunning(selected).then((r) => setRunning((x) => ({ ...x, [selected]: r })))
    }
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!state) return
    if (!selected || !state.assistants.some((a) => a.id === selected)) setSelected(state.assistants[0]?.id ?? null)
  }, [state, selected])

  const assistant = useMemo(() => state?.assistants.find((a) => a.id === selected) ?? null, [state, selected])
  const myTasks = useMemo(() => tasks.filter((t) => t.assistantId === selected || t.parentAssistantId === selected), [tasks, selected])
  const runningTasks = myTasks.filter((t) => t.status === 'running' || t.status === 'queued').length
  const busyAgents = Object.values(running).filter(Boolean).length + tasks.filter((t) => t.status === 'running').length
  const awaitingTasks = myTasks.some((t) => t.messages.some((m) => m.toolCalls?.some((c) => c.status === 'awaiting')))
  const threads = useMemo(
    () => (state && selected ? (state.threads || []).filter((t) => t.assistantId === selected && !t.hidden) : []),
    [state, selected]
  )

  const previews = useMemo(() => {
    const out: Record<string, { text: string; at: number }> = { ...(state?.previews || {}) }
    for (const [id, list] of Object.entries(messages)) {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (m.role === 'tool') continue
        const t = (m.content || (m.toolCalls?.length ? `[${m.toolCalls[m.toolCalls.length - 1].name}]` : '') || (m.images?.length ? '[图片]' : ''))
          .replace(/```[\s\S]*?```/g, '[代码]')
          .replace(/[#*_`>|-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (t) {
          out[id] = { text: t.slice(0, 60), at: m.createdAt }
          break
        }
      }
    }
    return out
  }, [messages, state?.previews])

  const toggleTheme = useCallback(() => {
    if (!state) return
    void window.api.saveSettings({ theme: theme === 'dark' ? 'light' : 'dark' }).then(setState)
  }, [state, theme])

  const select = (id: string): void => {
    setSelected(id)
    setShowGlobal(false)
    setTab('chat')
    setNav('chat')
  }

  if (!state) return <div className="loading">加载中…</div>
  if (!state.settings.setupDone) return <SetupWizard state={state} onState={setState} />

  const footerNav = showGlobal ? 'settings' : nav

  return (
    <div className="app maus-shell" data-testid="app-root" data-theme={theme}>
      <Sidebar
        state={state}
        selected={showGlobal ? null : selected}
        running={running}
        unread={unread}
        theme={theme}
        tasks={tasks}
        previews={previews}
        nav={footerNav}
        onSelect={(id) => {
          setSelected(id)
          setShowGlobal(false)
          setTab('chat')
          setNav('chat')
        }}
        onCreate={async (name) => {
          const a = await window.api.createAssistant(name)
          select(a.id)
        }}
        onRename={(id, name) => void window.api.updateAssistant(id, { name }).then(setState)}
        onDelete={(id) => void window.api.deleteAssistant(id).then(setState)}
        onDuplicate={async (id) => {
          const a = await window.api.duplicateAssistant(id)
          select(a.id)
        }}
        onPin={(id, pinned) => void window.api.pinAssistant(id, pinned).then(setState)}
        onHide={(id) => void window.api.hideAssistant(id, true).then(setState)}
        onOpenApps={() => {
          setShowGlobal(false)
          setNav('apps')
          setTab('connectors')
        }}
        onOpenAutomations={() => {
          setShowGlobal(false)
          setNav('automations')
          setTab('routines')
        }}
        onOpenSettings={() => {
          setShowGlobal(true)
          setNav('settings')
        }}
        onToggleTheme={toggleTheme}
        onOpenSwitcher={() => setSwitcher(true)}
      />
      <main className="main">
        {showGlobal ? (
          <GlobalSettings state={state} onState={setState} onClose={() => { setShowGlobal(false); setNav('chat') }} />
        ) : assistant ? (
          <>
            <header className="main-header">
              <div className="header-left">
                <nav className="tabs">
                  {(
                    [
                      ['chat', '聊天'],
                      ['routines', '自动化'],
                      ['connectors', '应用'],
                      ['skills', '技能'],
                      ['machines', '电脑'],
                      ['channels', '通道'],
                      ['usage', '用量'],
                      ['settings', '助手设置']
                    ] as [Tab, string][]
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      className={tab === k ? 'tab active' : 'tab'}
                      onClick={() => {
                        setTab(k)
                        if (k === 'connectors') setNav('apps')
                        else if (k === 'routines') setNav('automations')
                        else setNav('chat')
                      }}
                      data-testid={`tab-${k}`}
                    >
                      {label}
                      {k === 'routines' && state.routines.some((r) => r.assistantId === assistant.id && r.enabled) && <span className="tab-dot" />}
                    </button>
                  ))}
                </nav>
              </div>
              <div className="title-pill" title={assistant.model || state.settings.model}>
                <Avatar name={assistant.name} color={assistant.color} size={22} />
                <span className="name" data-testid="assistant-title">
                  {assistant.name}
                </span>
                {(messages[assistant.id] || []).some((m) => m.toolCalls?.some((c) => c.status === 'awaiting')) ? (
                  <span className="sub-typing warn">等待审批…</span>
                ) : running[assistant.id] ? (
                  <span className="sub-typing">{state.runtime?.computerActive ? '正在控制电脑…' : '正在输入…'}</span>
                ) : null}
              </div>
              <div className="header-right">
                <button
                  className="round-icon"
                  data-testid="search-btn"
                  title="搜索对话（Ctrl/⌘+F）"
                  onClick={() => {
                    setTab('chat')
                    setTimeout(() => window.dispatchEvent(new Event('open-chat-search')), 0)
                  }}
                >
                  <Icon name="search-line" />
                </button>
                <button
                  className={'task-btn' + (panel === 'computer' ? ' active' : '')}
                  data-testid="computer-panel-btn"
                  onClick={() => setPanel((p) => (p === 'computer' ? null : 'computer'))}
                  title="电脑面板"
                >
                  <Icon name="computer-line" /> 电脑
                </button>
                <button
                  className={'task-btn' + (panel === 'parallel' ? ' active' : '')}
                  data-testid="parallel-panel-btn"
                  onClick={() => setPanel((p) => (p === 'parallel' ? null : 'parallel'))}
                  title="并行智能体"
                >
                  <Icon name="node-tree" /> 并行{busyAgents > 0 && <span className="badge">{busyAgents}</span>}
                </button>
                <button
                  className={'task-btn' + (panel === 'orch' ? ' active' : '')}
                  data-testid="orch-panel-btn"
                  onClick={() => setPanel((p) => (p === 'orch' ? null : 'orch'))}
                  title="任务编排"
                >
                  <Icon name="flow-chart" /> 编排
                </button>
                <button
                  className={'task-btn' + (panel === 'log' ? ' active' : '') + (state.runtime?.computerActive ? ' live' : '')}
                  data-testid="computer-log-btn"
                  onClick={() => setPanel((p) => (p === 'log' ? null : 'log'))}
                  title="电脑操作日志"
                >
                  <Icon name="history-line" /> 操作日志
                </button>
                <button
                  className={'task-btn' + (state.runtime?.teachRecording ? ' live' : '')}
                  data-testid="teach-btn"
                  title={state.runtime?.teachRecording ? '停止示教并生成技能草稿' : '录制示教生成技能'}
                  onClick={() => {
                    void (async () => {
                      if (state.runtime?.teachRecording) {
                        const r = await window.api.stopTeach(true)
                        alert(r.message + (r.path ? '\n' + r.path : ''))
                        const st = await window.api.getState()
                        setState(st)
                      } else {
                        const title = prompt('示教标题', '新示教流程') || '新示教流程'
                        const r = await window.api.startTeach(title, assistant.id)
                        if (!r.ok) alert(r.message)
                        const st = await window.api.getState()
                        setState(st)
                      }
                    })()
                  }}
                >
                  <Icon name="record-circle-line" /> {state.runtime?.teachRecording ? '停止示教' : '录制示教'}
                </button>
                <button
                  className={'task-btn' + (taskPanel ? ' active' : '') + (awaitingTasks ? ' attention' : '')}
                  data-testid="task-panel-btn"
                  onClick={() => setTaskPanel((v) => !v)}
                  title="后台任务"
                >
                  <Icon name="flashlight-line" /> 任务{runningTasks > 0 && <span className="badge">{runningTasks}</span>}
                </button>
              </div>
            </header>
            <div className="content-row">
              <div className="content-main">
                {tab === 'chat' && (
                  <ChatView
                    assistant={assistant}
                    settings={state.settings}
                    messages={messages[assistant.id] || []}
                    loaded={!!messages[assistant.id]}
                    running={!!running[assistant.id]}
                    computerActive={!!state.runtime?.computerActive}
                    takeoverActive={!!state.runtime?.takeover && state.runtime.takeover.assistantId === assistant.id}
                    takeoverReason={state.runtime?.takeover?.reason}
                    teachRecording={!!state.runtime?.teachRecording}
                    threads={threads}
                    onOpenGlobal={() => setShowGlobal(true)}
                    onOpenRoutines={() => {
                      setTab('routines')
                      setNav('automations')
                    }}
                    onOpenTask={() => setTaskPanel(true)}
                    onOpenModelPicker={() => setModelPicker(true)}
                    onOpenComputer={() => setPanel('computer')}
                    onOpenUsage={() => setTab('usage')}
                    onState={setState}
                  />
                )}
                {tab === 'routines' && (
                  <RoutinesView
                    assistant={assistant}
                    routines={state.routines.filter((r) => r.assistantId === assistant.id)}
                    paused={state.settings.routinesPaused}
                    onState={setState}
                    usageByRoutine={usageByRoutine}
                    cnyPerUsd={state.settings.cnyPerUsd}
                  />
                )}
                {tab === 'settings' && <AssistantSettings assistant={assistant} onState={setState} state={state} />}
                {tab === 'connectors' && <ConnectorsView state={state} onState={setState} />}
                {tab === 'skills' && <SkillsView state={state} onState={setState} assistantId={assistant.id} />}
                {tab === 'machines' && <MachinesView state={state} onState={setState} />}
                {tab === 'channels' && <ChannelsView state={state} onState={setState} />}
                {tab === 'usage' && <UsageView state={state} onState={setState} />}
              </div>
              {taskPanel && (
                <TaskPanel tasks={myTasks} onClose={() => setTaskPanel(false)} onClear={async () => setTasks(await window.api.clearFinishedTasks(assistant.id))} />
              )}
              {panel === 'parallel' && <ParallelPanel state={state} tasks={tasks} running={running} onClose={() => setPanel(null)} onOpenAssistant={select} usageToday={usageToday} onOpenUsage={() => setTab('usage')} />}
              {panel === 'orch' && assistant && <OrchestratorPanel assistantId={assistant.id} open onClose={() => setPanel(null)} />}
              {panel === 'log' && (
                <ComputerLogPanel
                  log={computerLog}
                  assistantNames={Object.fromEntries(state.assistants.map((a) => [a.id, a.name]))}
                  onClose={() => setPanel(null)}
                  onClear={async () => {
                    await window.api.clearComputerLog()
                    setComputerLog([])
                  }}
                  onImage={setLightbox}
                />
              )}
              {panel === 'computer' && (
                <ComputerPanel state={state} assistant={assistant} onState={setState} open onClose={() => setPanel(null)} />
              )}
            </div>
          </>
        ) : (
          <div className="empty">请在左侧创建一个助手</div>
        )}
      </main>
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
      {switcher && (
        <QuickSwitcher
          assistants={state.assistants}
          unread={unread}
          running={running}
          onClose={() => setSwitcher(false)}
          onPick={(id) => {
            select(id)
            setSwitcher(false)
          }}
        />
      )}
      {assistant && (
        <ModelPicker state={state} assistantId={assistant.id} open={modelPicker} onClose={() => setModelPicker(false)} onState={setState} />
      )}
    </div>
  )
}
