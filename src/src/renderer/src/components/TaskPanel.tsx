import { useState } from 'react'
import type { TaskInfo } from '../../../shared/types'
import ToolCallCard from './ToolCallCard'
import Markdown from './Markdown'
import Icon from './Icon'

const STATUS: Record<string, [string, string]> = {
  queued: ['排队中', 's-cancelled'],
  running: ['运行中', 's-running'],
  done: ['已完成', 's-done'],
  error: ['失败', 's-error'],
  cancelled: ['已取消', 's-cancelled']
}

function duration(t: TaskInfo): string {
  const ms = (t.finishedAt || Date.now()) - t.createdAt
  return ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`
}

export default function TaskPanel({ tasks, onClose, onClear }: { tasks: TaskInfo[]; onClose(): void; onClear(): void }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <aside className="task-panel" data-testid="task-panel">
      <div className="task-panel-head">
        <strong>
          <Icon name="flashlight-line" /> 后台任务
        </strong>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={onClear} disabled={!tasks.some((t) => t.status !== 'running')}>
          清除已结束
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <Icon name="close-line" />
        </button>
      </div>
      <div className="task-list">
        {sorted.length === 0 && <div className="empty-card small">暂无后台任务。让助手「在后台」做某件事时会出现在这里。</div>}
        {sorted.map((t) => {
          const [label, cls] = STATUS[t.status]
          const awaiting = t.messages.some((m) => m.toolCalls?.some((c) => c.status === 'awaiting'))
          const expanded = open === t.id || awaiting
          const steps = t.messages.flatMap((m) => m.toolCalls || [])
          return (
            <div key={t.id} className={'task-item' + (expanded ? ' open' : '')} data-testid="task-item" data-status={t.status}>
              <div className="task-item-head" onClick={() => setOpen(open === t.id ? null : t.id)}>
                {t.status === 'running' ? <span className="spinner" /> : <Icon name={t.status === 'done' ? 'checkbox-circle-fill' : t.status === 'queued' ? 'time-line' : t.status === 'error' ? 'error-warning-fill' : 'close-circle-line'} className={`st-icon ${cls}`} />}
                <span className="task-title">{t.title}</span>
                {t.parentAssistantId && <span className="pill">委派</span>}
                <span className={`tool-status ${cls}`}>{awaiting ? '待审批' : label}</span>
              </div>
              <div className="task-meta muted small">
                #{t.id} · {new Date(t.createdAt).toLocaleTimeString('zh-CN', { hour12: false })} · {duration(t)} · {steps.length} 步
              </div>
              {expanded && (
                <div className="task-detail">
                  <div className="task-prompt">{t.prompt}</div>
                  {steps.map((c) => (
                    <ToolCallCard
                      key={c.id}
                      call={c}
                      compact
                      onRespond={(ok) => void window.api.respondTool(c.id, ok)}
                      onAlwaysAllow={() => void window.api.respondTool(c.id, true)}
                    />
                  ))}
                  {t.result && (
                    <div className="task-result">
                      <div className="muted small">结果</div>
                      <Markdown text={t.result} />
                    </div>
                  )}
                  {t.error && <div className="msg-error">{t.error}</div>}
                  {(t.status === 'running' || t.status === 'queued') && (
                    <button className="btn sm danger" onClick={() => void window.api.cancelTask(t.id)}>
                      取消任务
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
