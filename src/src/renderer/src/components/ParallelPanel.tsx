import { useEffect, useState } from 'react'
import type { AppState, TaskInfo, UsageBucket } from '../../../shared/types'
import { fmtTokens, fmtUsd } from '../../../shared/usageFormat'
import Avatar from './Avatar'
import { toolLabel } from './ToolCallCard'
import Icon from './Icon'

function secs(ms: number): string {
  return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

/** 并行智能体面板：所有正在工作的智能体、屏幕锁、并发与委派时间线 */
export default function ParallelPanel({
  state,
  tasks,
  running,
  onClose,
  onOpenAssistant,
  usageToday,
  onOpenUsage
}: {
  state: AppState
  tasks: TaskInfo[]
  running: Record<string, boolean>
  onClose(): void
  onOpenAssistant(id: string): void
  usageToday?: UsageBucket | null
  onOpenUsage?(): void
}): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 300)
    return () => clearInterval(t)
  }, [])
  const byId = Object.fromEntries(state.assistants.map((a) => [a.id, a]))
  const keyName = (k?: string | null): string => {
    if (!k) return ''
    if (k.startsWith('task:')) {
      const t = tasks.find((x) => x.id === k.slice(5))
      return t ? `${byId[t.assistantId]?.name || '?'} · ${t.title}` : k
    }
    return byId[k]?.name || k
  }
  const chats = state.assistants.filter((a) => running[a.id])
  const live = tasks.filter((t) => t.status === 'running' || t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  const activeTasks = live.filter((t) => t.status === 'running').length
  const rt = state.runtime
  // 最近一次委派任务组的时间线
  const groups = tasks.filter((t) => t.groupId).sort((a, b) => b.createdAt - a.createdAt)
  const gid = groups[0]?.groupId
  const group = gid ? tasks.filter((t) => t.groupId === gid).sort((a, b) => a.createdAt - b.createdAt) : []
  const g0 = Math.min(...group.map((t) => t.startedAt || t.createdAt))
  const g1 = Math.max(...group.map((t) => t.finishedAt || now))
  const span = Math.max(1, g1 - g0)

  const lastTool = (t: TaskInfo): string => {
    const calls = t.messages.flatMap((m) => m.toolCalls || [])
    const c = calls[calls.length - 1]
    return c ? toolLabel(c.name) : t.messages.some((m) => m.streaming) ? '思考中' : '准备中'
  }

  return (
    <aside className="task-panel parallel-panel" data-testid="parallel-panel">
      <div className="task-panel-head">
        <strong>
          <Icon name="node-tree" /> 并行智能体
        </strong>
        <span className="pill accent" data-testid="parallel-count">
          {chats.length + activeTasks} 运行中
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭">
          <Icon name="close-line" />
        </button>
      </div>
      <div className="task-list">
        {usageToday && (
          <div className="par-usage" data-testid="parallel-usage" onClick={onOpenUsage} title="打开用量页">
            <Icon name="coins-line" /> 今日 <b>{fmtUsd(usageToday.cost)}</b>
            <span className="muted small">
              · {usageToday.calls} 次调用 · 输入 {fmtTokens(usageToday.input)} / 输出 {fmtTokens(usageToday.output)}
              {state.settings.budget?.perDayUsd > 0 ? ` · 日预算 ${fmtUsd(state.settings.budget.perDayUsd)}` : ''}
            </span>
            {state.settings.budget?.perDayUsd > 0 && (
              <div className="usage-meter">
                <div className={'usage-meter-bar' + (usageToday.cost >= state.settings.budget.perDayUsd ? ' over' : '')} style={{ width: `${Math.min(100, (usageToday.cost / state.settings.budget.perDayUsd) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        <div className="par-section">
          <div className="par-title">
            <Icon name="lock-line" /> 屏幕控制权
          </div>
          <div className="par-screen" data-testid="screen-lock">
            {rt?.screenOwner ? (
              <>
                <Icon name="computer-line" className="live-icon" /> <b>{keyName(rt.screenOwner)}</b> 正在操作电脑
              </>
            ) : (
              <span className="muted">
                <Icon name="checkbox-blank-circle-line" /> 空闲
              </span>
            )}
            {!!rt?.screenQueue?.length && (
              <div className="muted small" data-testid="screen-queue">
                排队：{rt.screenQueue.map(keyName).join('、')}
              </div>
            )}
          </div>
        </div>

        <div className="par-section">
          <div className="par-title">
            工作中 <span className="muted small">· 后台并发上限 {state.settings.maxConcurrentAgents}（{activeTasks} 个占用）</span>
          </div>
          {chats.length + live.length === 0 && <div className="empty-card small">当前没有智能体在工作</div>}
          {chats.map((a) => (
            <div key={a.id} className="agent-row" data-testid="agent-row" data-kind="chat" onClick={() => onOpenAssistant(a.id)}>
              <Avatar name={a.name} color={a.color} size={28} />
              <div className="agent-main">
                <div className="agent-line">
                  <b>{a.name}</b>
                  <span className="pill">对话</span>
                  {rt?.screenOwner === a.id && <span className="pill warn">
                      <Icon name="computer-line" /> 控制中
                    </span>}
                  {rt?.screenQueue?.includes(a.id) && <span className="pill">
                      <Icon name="hourglass-line" /> 等待屏幕
                    </span>}
                </div>
                <div className="agent-bar indeterminate" />
              </div>
            </div>
          ))}
          {live.map((t) => {
            const a = byId[t.assistantId]
            const awaiting = t.messages.some((m) => m.toolCalls?.some((c) => c.status === 'awaiting'))
            const steps = t.messages.flatMap((m) => m.toolCalls || []).length
            return (
              <div key={t.id} className="agent-row" data-testid="agent-row" data-kind="task" data-status={t.status} onClick={() => a && onOpenAssistant(t.parentAssistantId || a.id)}>
                {a && <Avatar name={a.name} color={a.color} size={28} />}
                <div className="agent-main">
                  <div className="agent-line">
                    <b>{a?.name || '?'}</b>
                    <span className="ellipsis">{t.title}</span>
                    <span className="spacer" />
                    <span className="muted small">{t.status === 'queued' ? '排队中' : secs(now - (t.startedAt || t.createdAt))}</span>
                  </div>
                  <div className="muted small agent-line">
                    {t.parentAssistantId ? `由 ${byId[t.parentAssistantId]?.name || '?'} 委派` : '后台任务'} · {steps} 步 · {awaiting ? '等待审批' : lastTool(t)}
                    {t.usage && (
                      <span className="task-cost" data-testid="task-cost">
                        {' '}· {fmtTokens(t.usage.input + t.usage.output)} token{t.usage.priced ? ` · ${fmtUsd(t.usage.cost)}` : ''}
                      </span>
                    )}
                  </div>
                  <div className={'agent-bar' + (t.status === 'running' ? ' indeterminate' : '')} />
                </div>
              </div>
            )
          })}
        </div>

        {group.length > 0 && (
          <div className="par-section" data-testid="parallel-timeline">
            <div className="par-title">
              <Icon name="git-branch-line" /> 最近一次委派 · {byId[group[0].parentAssistantId || '']?.name || ''} → {group.length} 个智能体
            </div>
            {group.map((t) => {
              const s = (t.startedAt || now) - g0
              const e = (t.finishedAt || now) - g0
              return (
                <div key={t.id} className="tl-row" data-testid="timeline-row">
                  <span className="tl-name ellipsis">{byId[t.assistantId]?.name}</span>
                  <div className="tl-track">
                    <div
                      className={'tl-bar s-' + t.status}
                      style={{ left: `${t.startedAt ? (s / span) * 100 : 0}%`, width: `${t.startedAt ? Math.max(2, ((e - s) / span) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="muted small tl-dur">
                    {t.startedAt ? secs(e - s) : '排队'}
                    {t.usage?.priced ? ` · ${fmtUsd(t.usage.cost)}` : ''}
                  </span>
                </div>
              )
            })}
            <div className="muted small">
              总用时 {secs(span)}，各智能体时间段重叠表示并行执行
              {group.some((t) => t.usage) && ` · 合计 ${fmtTokens(group.reduce((n, t) => n + (t.usage ? t.usage.input + t.usage.output : 0), 0))} token / ${fmtUsd(group.reduce((n, t) => n + (t.usage?.cost || 0), 0))}`}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
