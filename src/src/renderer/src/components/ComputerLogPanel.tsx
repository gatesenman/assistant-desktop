import { useMemo, useState } from 'react'
import type { ComputerLogEntry } from '../../../shared/types'
import { computerSummary, toolLabel } from './ToolCallCard'
import Icon from './Icon'

function parse(a: string): Record<string, any> {
  try {
    return JSON.parse(a || '{}')
  } catch {
    return {}
  }
}

type Group = {
  runId: string
  assistantId: string
  taskId?: string
  startedAt: number
  frames: ComputerLogEntry[]
}

function groupLog(log: ComputerLogEntry[]): Group[] {
  const map = new Map<string, Group>()
  for (const e of log) {
    const runId = e.runId || e.taskId || `solo:${e.assistantId}`
    let g = map.get(runId)
    if (!g) {
      g = { runId, assistantId: e.assistantId, taskId: e.taskId, startedAt: e.at, frames: [] }
      map.set(runId, g)
    }
    g.frames.push(e)
    g.startedAt = Math.min(g.startedAt, e.at)
  }
  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** 电脑控制操作日志：按任务分组时间轴，支持逐帧回放与导出 */
export default function ComputerLogPanel({
  log,
  assistantNames,
  onClose,
  onClear,
  onImage
}: {
  log: ComputerLogEntry[]
  assistantNames: Record<string, string>
  onClose(): void
  onClear(): void
  onImage(src: string): void
}): JSX.Element {
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [activeRun, setActiveRun] = useState<string | null>(null)
  const [frameIdx, setFrameIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  const groups = useMemo(() => groupLog(log), [log])
  const current = groups.find((g) => g.runId === activeRun) || groups[0]
  const frames = (current?.frames || []).filter((e) => !onlyErrors || !e.ok)

  const play = (): void => {
    if (!frames.length) return
    setPlaying(true)
    let i = frameIdx
    const tick = (): void => {
      i += 1
      if (i >= frames.length) {
        setPlaying(false)
        setFrameIdx(frames.length - 1)
        return
      }
      setFrameIdx(i)
      window.setTimeout(tick, 700)
    }
    window.setTimeout(tick, 700)
  }

  const exportReplay = async (format: 'gif' | 'mp4'): Promise<void> => {
    if (!current) return
    setExportMsg('导出中…')
    try {
      const r = await window.api.exportComputerReplay({ runId: current.runId, format })
      setExportMsg(r.message + (r.path ? ` → ${r.path}` : ''))
    } catch (e: any) {
      setExportMsg(e?.message || String(e))
    }
  }

  return (
    <aside className="task-panel computer-log" data-testid="computer-log-panel">
      <div className="task-panel-head">
        <strong>
          <Icon name="history-line" /> 轨迹回放
        </strong>
        <span className="pill">{log.length}</span>
        <span className="spacer" />
        <label className="row small muted" style={{ gap: 4 }}>
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> 仅错误
        </label>
        <button className="btn sm ghost" onClick={onClear} disabled={!log.length}>
          清空
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <Icon name="close-line" />
        </button>
      </div>

      <div className="row wrap" style={{ gap: 6, padding: '6px 10px' }} data-testid="computer-log-runs">
        {groups.length === 0 && <div className="empty-card">还没有电脑控制操作。</div>}
        {groups.map((g) => (
          <button
            key={g.runId}
            className={'btn sm' + (current?.runId === g.runId ? '' : ' ghost')}
            data-testid="computer-log-run"
            onClick={() => {
              setActiveRun(g.runId)
              setFrameIdx(0)
            }}
          >
            {new Date(g.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} · {g.frames.length} 步
            {assistantNames[g.assistantId] ? ` · ${assistantNames[g.assistantId]}` : ''}
          </button>
        ))}
      </div>

      {current && frames.length > 0 && (
        <div className="replay-stage" data-testid="computer-log-replay" style={{ padding: '0 10px 8px' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <button className="btn sm" disabled={frameIdx <= 0} onClick={() => setFrameIdx((x) => Math.max(0, x - 1))}>
              <Icon name="arrow-left-s-line" />
            </button>
            <button className="btn sm" data-testid="computer-log-play" onClick={play} disabled={playing}>
              <Icon name="play-line" /> {playing ? '回放中' : '逐帧回放'}
            </button>
            <button className="btn sm" disabled={frameIdx >= frames.length - 1} onClick={() => setFrameIdx((x) => Math.min(frames.length - 1, x + 1))}>
              <Icon name="arrow-right-s-line" />
            </button>
            <span className="muted small">
              {frameIdx + 1} / {frames.length}
            </span>
            <span className="spacer" />
            <button className="btn sm ghost" data-testid="computer-log-export-gif" onClick={() => void exportReplay('gif')}>
              导出 GIF
            </button>
            <button className="btn sm ghost" data-testid="computer-log-export-mp4" onClick={() => void exportReplay('mp4')}>
              导出 MP4
            </button>
          </div>
          {exportMsg && <div className="muted small" data-testid="computer-log-export-msg">{exportMsg}</div>}
          {(() => {
            const e = frames[frameIdx]
            const args = parse(e.args)
            const label = toolLabel(e.tool).replace(/^电脑 · /, '')
            return (
              <div className={'log-item' + (e.ok ? '' : ' fail')} data-testid="computer-log-item" data-tool={e.tool}>
                {e.thumb ? (
                  <img className="log-thumb" src={e.thumb} alt="" onClick={() => onImage(e.thumb!)} />
                ) : (
                  <div className="log-thumb empty">
                    <Icon name="image-line" size={20} />
                  </div>
                )}
                <div className="log-main">
                  <div className="log-title">
                    <span className="log-step">#{frameIdx + 1}</span>
                    <span>{label}</span>
                    <Icon name={e.ok ? 'checkbox-circle-fill' : 'error-warning-fill'} className={'st-icon ' + (e.ok ? 's-done' : 's-error')} />
                  </div>
                  <div className="log-args mono">{computerSummary(e.tool, args) || '—'}</div>
                  {e.reasoning && <div className="muted small">思考：{e.reasoning}</div>}
                  {e.error && <div className="err-text">{e.error}</div>}
                  <div className="muted small">
                    {new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}
                    {assistantNames[e.assistantId] ? ` · ${assistantNames[e.assistantId]}` : ''}
                    {e.taskId ? ' · 后台任务' : ''}
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      <div className="task-list" data-testid="computer-log-timeline">
        {frames.map((e, i) => {
          const args = parse(e.args)
          const label = toolLabel(e.tool).replace(/^电脑 · /, '')
          return (
            <button
              key={e.id}
              type="button"
              className={'log-item' + (e.ok ? '' : ' fail') + (i === frameIdx ? ' active' : '')}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none', background: i === frameIdx ? 'rgba(59,130,246,.12)' : 'transparent' }}
              data-testid="computer-log-item"
              data-tool={e.tool}
              onClick={() => setFrameIdx(i)}
            >
              {e.thumb ? <img className="log-thumb" src={e.thumb} alt="" /> : <div className="log-thumb empty"><Icon name="image-line" size={20} /></div>}
              <div className="log-main">
                <div className="log-title">
                  <span className="log-step">#{i + 1}</span>
                  <span>{label}</span>
                </div>
                <div className="log-args mono">{computerSummary(e.tool, args) || '—'}</div>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
