import { useEffect, useState } from 'react'
import type { OrchestratorJob } from '../../../shared/types'
import Icon from './Icon'

export default function OrchestratorPanel({ assistantId, open, onClose }: { assistantId: string; open: boolean; onClose(): void }): JSX.Element | null {
  const [jobs, setJobs] = useState<OrchestratorJob[]>([])
  const [goal, setGoal] = useState('')
  useEffect(() => {
    if (!open) return
    void window.api.listOrchestratorJobs().then(setJobs)
    const off = window.api.onEvent((ev) => {
      if (ev.type === 'orchestrator') setJobs((j) => [ev.job, ...j.filter((x) => x.id !== ev.job.id)])
    })
    return off
  }, [open])
  if (!open) return null
  return (
    <div className="side-panel" data-testid="orchestrator-panel">
      <div className="side-panel-head">
        <strong>
          <Icon name="flow-chart" /> 任务编排
        </strong>
        <button className="btn sm" onClick={onClose}>
          <Icon name="close-line" />
        </button>
      </div>
      <div className="side-panel-body">
        <textarea className="input" data-testid="orch-goal" rows={3} placeholder="描述一个大目标，将自动拆成子任务 DAG…" value={goal} onChange={(e) => setGoal(e.target.value)} />
        <button
          className="btn primary sm"
          data-testid="orch-create"
          style={{ marginTop: 8 }}
          onClick={async () => {
            if (!goal.trim()) return
            const job = await window.api.createOrchestratorJob(assistantId, goal.trim())
            setJobs((j) => [job, ...j])
            setGoal('')
          }}
        >
          拆分并开始
        </button>
        {jobs.map((job) => (
          <div key={job.id} className="orch-job" data-testid={`orch-job-${job.id}`} style={{ marginTop: 14, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{job.title}</strong>
              <span className="muted small">{job.status}</span>
            </div>
            <div className="orch-timeline" data-testid="orch-timeline">
              {job.nodes.map((n) => (
                <div key={n.id} className={'timeline-row status-' + n.status} data-status={n.status} style={{ fontSize: 12, marginTop: 6 }}>
                  <Icon name={n.status === 'done' ? 'checkbox-circle-fill' : n.status === 'error' ? 'error-warning-fill' : n.status === 'running' ? 'loader-4-line' : 'checkbox-blank-circle-line'} className={n.status === 'running' ? 'spin' : ''} />{' '}
                  {n.title} <span className="muted">p{n.priority}</span>
                  {n.dependsOn?.length ? <span className="muted"> · 依赖 {n.dependsOn.length}</span> : null}
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              {job.status === 'running' && (
                <button className="btn sm" onClick={() => void window.api.pauseOrchestrator(job.id)}>
                  暂停
                </button>
              )}
              {job.status === 'paused' && (
                <button className="btn sm" onClick={() => void window.api.resumeOrchestrator(job.id)}>
                  继续
                </button>
              )}
              {!['done', 'cancelled'].includes(job.status) && (
                <button className="btn sm danger" onClick={() => void window.api.cancelOrchestrator(job.id)}>
                  取消
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
