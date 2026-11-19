import { memo, useState } from 'react'
import type { Assistant, ChatMessage, MessageUsage } from '../../../shared/types'
import { usageLine } from '../../../shared/usageFormat'
import Markdown from './Markdown'
import ToolCallCard from './ToolCallCard'
import Icon from './Icon'

interface Props {
  message: ChatMessage
  assistant: Assistant
  highlight?: string
  onImage(src: string): void
  onRespond(callId: string, approved: boolean): void
  onAskRespond?(callId: string, answer: string | null): void
  onConfirmPlan?(messageId: string, action: 'confirm' | 'reject' | 'edit', text?: string): void
  onAlwaysAllow(callId: string, tool: string): void
  onTrust?(callId: string): void
  onRetry?(): void
  onOpenGlobal?(): void
  onOpenTask?(): void
  /** v0.7：本轮（到这条回复为止）的累计用量；只在一轮的最后一条回复上传入 */
  turnUsage?: MessageUsage
  cnyPerUsd?: number
  onResumeBudget?(): void
  onOpenUsage?(): void
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  if (sameDay) return hm
  const y = new Date(now.getTime() - 86400000)
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

function Highlighted({ text, q }: { text: string; q?: string }): JSX.Element {
  if (!q) return <>{text}</>
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return <>{parts.map((p, i) => (p.toLowerCase() === q.toLowerCase() ? <mark key={i}>{p}</mark> : p))}</>
}

function TaskResultCard({ m, onOpenTask }: { m: ChatMessage; onOpenTask?(): void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const first = m.content.split('\n')[0].replace(/^【|】/g, ' ').trim()
  const ok = m.content.includes('已完成')
  return (
    <div className="msg system-card" data-testid="task-result-card">
      <div className={'task-result-card' + (ok ? ' ok' : ' fail')}>
        <div className="trc-head" onClick={() => setOpen(!open)}>
          <Icon name={ok ? 'checkbox-circle-fill' : 'error-warning-fill'} className={ok ? 'ok-icon' : 'warn-icon'} />
          <span className="trc-title">{first}</span>
          <span className="spacer" />
          <span className="muted small">{formatTime(m.createdAt)}</span>
          <Icon name="arrow-right-s-line" className={'chev' + (open ? ' down' : '')} />
        </div>
        {open && <pre className="tool-output">{m.content}</pre>}
        {onOpenTask && (
          <button className="link-btn small" onClick={onOpenTask}>
            查看任务详情 <Icon name="arrow-right-line" />
          </button>
        )}
      </div>
    </div>
  )
}

function MessageItem({ message: m, highlight, onImage, onRespond, onAskRespond, onConfirmPlan, onAlwaysAllow, onTrust, onOpenTask, onRetry, onOpenGlobal, turnUsage, cnyPerUsd, onResumeBudget, onOpenUsage }: Props): JSX.Element | null {
  const [planEdit, setPlanEdit] = useState(m.plan?.text || '')
  if (m.role === 'tool') return null
  if (m.role === 'user' && m.source === 'task') return <TaskResultCard m={m} onOpenTask={onOpenTask} />
  if (m.role === 'user') {
    return (
      <div className="msg user" data-msg-id={m.id}>
        <div className="bubble">
          {m.source === 'routine' && <div className="routine-tag">
              <Icon name="alarm-line" /> 定时任务：{m.routineName}
            </div>}
          {m.images && m.images.length > 0 && (
            <div className="msg-images">
              {m.images.map((src, i) => (
                <img key={i} src={src} alt="" onClick={() => onImage(src)} />
              ))}
            </div>
          )}
          {m.content && (
            <div className="user-text">
              <Highlighted text={m.content} q={highlight} />
            </div>
          )}
        </div>
        <div className="msg-time" title={new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}>
          {formatTime(m.createdAt)}
        </div>
      </div>
    )
  }
  const empty = !m.content && !m.toolCalls?.length && !m.error
  return (
    <div className="msg assistant" data-msg-id={m.id}>
      <div className="msg-body">
        {m.source === 'routine' && m.routineName && <div className="routine-tag muted">
            <Icon name="alarm-line" /> {m.routineName}
          </div>}
        {m.content && (
          <div className="bubble asst">
            {highlight ? (
              <div className="markdown plain">
                <Highlighted text={m.content} q={highlight} />
              </div>
            ) : (
              <Markdown text={m.content} onImage={onImage} />
            )}
            {m.streaming && <span className="caret" />}
          </div>
        )}
        {empty && m.streaming && (
          <div className="bubble asst typing-bubble">
            <div className="typing" data-testid="typing-indicator">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {m.plan && (
          <div className="plan-card" data-testid="plan-card" data-status={m.plan.status}>
            <div className="plan-head">
              <Icon name="roadmap-line" /> 执行计划
              <span className="pill">{m.plan.status === 'pending' ? '待确认' : m.plan.status === 'confirmed' ? '已确认' : m.plan.status === 'edited' ? '已编辑' : '已拒绝'}</span>
            </div>
            {m.plan.status === 'pending' ? (
              <>
                <textarea className="input" data-testid="plan-edit" rows={6} value={planEdit} onChange={(e) => setPlanEdit(e.target.value)} />
                <div className="btns row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn" data-testid="plan-reject" onClick={() => onConfirmPlan?.(m.id, 'reject')}>拒绝</button>
                  <button className="btn ghost" data-testid="plan-edit-confirm" onClick={() => onConfirmPlan?.(m.id, 'edit', planEdit)}>按编辑执行</button>
                  <button className="btn primary" data-testid="plan-confirm" onClick={() => onConfirmPlan?.(m.id, 'confirm')}>确认执行</button>
                </div>
              </>
            ) : (
              <pre className="tool-output" style={{ whiteSpace: 'pre-wrap' }}>{m.plan.text}</pre>
            )}
          </div>
        )}
        {m.toolCalls?.map((tc) => (
          <ToolCallCard
            key={tc.id}
            call={tc}
            onImage={onImage}
            onRespond={(ok) => onRespond(tc.id, ok)}
            onAskRespond={onAskRespond ? (ans) => onAskRespond(tc.id, ans) : undefined}
            onAlwaysAllow={() => onAlwaysAllow(tc.id, tc.name)}
            onTrust={onTrust ? () => onTrust(tc.id) : undefined}
          />
        ))}
        {m.notice && (
          <div className="msg-notice" data-testid="msg-notice">
            <Icon name="loader-4-line" className="spin" /> {m.notice}
          </div>
        )}
        {m.error && (
          <div className="msg-error" data-testid="msg-error" data-kind={m.errorKind || ''}>
            <Icon name="error-warning-line" />
            <span className="me-text">{m.error}</span>
            {(onRetry || (onOpenGlobal && ['auth', 'network', 'proxy', 'model_not_found', 'no_vision', 'quota'].includes(m.errorKind || ''))) && (
              <span className="me-actions">
                {onRetry && (
                  <button className="btn sm" data-testid="retry-btn" onClick={onRetry}>
                    <Icon name="refresh-line" /> 重试
                  </button>
                )}
                {onOpenGlobal && ['auth', 'network', 'proxy', 'model_not_found', 'no_vision', 'quota'].includes(m.errorKind || '') && (
                  <button className="btn sm ghost" onClick={onOpenGlobal}>
                    <Icon name="settings-3-line" /> 打开设置
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {m.stopReason && m.errorKind === 'budget' ? (
          <div className="msg-budget" data-testid="budget-pause">
            <Icon name="pause-circle-fill" />
            <span className="mb-text">{m.stopReason.replace(/^⏸\s*/, '')}</span>
            <span className="me-actions">
              {onOpenUsage && (
                <button className="btn sm ghost" data-testid="budget-open-usage" onClick={onOpenUsage}>
                  <Icon name="bar-chart-2-line" /> 用量与预算
                </button>
              )}
              {onResumeBudget && (
                <button className="btn sm" data-testid="budget-resume" onClick={onResumeBudget}>
                  <Icon name="play-line" /> 继续
                </button>
              )}
            </span>
          </div>
        ) : m.stopReason ? (
          <div className="msg-stopped emergency" data-testid="stop-reason">
            <Icon name="stop-circle-fill" /> {m.stopReason}
          </div>
        ) : (
          m.stopped && <div className="msg-stopped">已停止生成</div>
        )}
        {!m.streaming && (m.content || turnUsage) && (
          <div className={'msg-time' + (turnUsage ? ' has-usage' : '')} title={new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}>
            {m.content ? formatTime(m.createdAt) : ''}
            {turnUsage && (
              <span className="usage-line" data-testid="usage-line" title={`模型 ${turnUsage.model}${turnUsage.estimated ? '（服务商未返回用量，按字数估算）' : ''}`}>
                <Icon name="coins-line" /> {usageLine(turnUsage, cnyPerUsd)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(MessageItem)
