import { useEffect, useState } from 'react'
import type { AppState, SkillMeta, Workflow } from '../../../shared/types'
import Icon from './Icon'

export default function SkillsView({ state, onState, assistantId }: { state: AppState; onState(s: AppState): void; assistantId: string }): JSX.Element {
  const skills = state.skills || []
  const [selected, setSelected] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [meta, setMeta] = useState<SkillMeta | null>(null)
  const [workflows, setWorkflows] = useState<Workflow[]>(state.settings.workflows || [])
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void window.api.listWorkflows().then(setWorkflows)
  }, [state.settings.workflows])

  const open = async (id: string): Promise<void> => {
    const r = await window.api.readSkill(id)
    setSelected(id)
    setMeta(r.meta)
    setBody(r.body)
  }

  return (
    <div className="page" data-testid="skills-view">
      <div className="page-inner">
        <div className="page-head">
          <h2>
            <Icon name="book-open-line" /> 技能与工作流
          </h2>
        </div>
        <div className="skills-grid" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
          <div className="card">
            <h3>技能</h3>
            {skills.map((s) => (
              <button key={s.id} className={'chip' + (selected === s.id ? ' active' : '')} style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }} data-testid={`skill-${s.id}`} onClick={() => void open(s.id)}>
                {s.builtin ? '内置 · ' : ''}
                {s.name}
              </button>
            ))}
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              onClick={async () => {
                const id = 'custom-' + Date.now().toString(36)
                await window.api.saveSkill(id, '# 新技能\n\n在此编写步骤…', { name: '自定义技能', description: '用户技能' })
                onState(await window.api.getState())
                await open(id)
              }}
            >
              新建技能
            </button>
          </div>
          <div className="card form">
            {meta ? (
              <>
                <h3>{meta.name}</h3>
                <p className="muted small">{meta.description}</p>
                <textarea className="input mono" style={{ minHeight: 280 }} data-testid="skill-body" value={body} readOnly={meta.builtin} onChange={(e) => setBody(e.target.value)} />
                {!meta.builtin && (
                  <div className="form-actions">
                    <button
                      className="btn primary"
                      onClick={async () => {
                        await window.api.saveSkill(meta.id, body, meta)
                        setMsg('已保存')
                        onState(await window.api.getState())
                      }}
                    >
                      保存
                    </button>
                    <button className="btn danger" onClick={async () => { await window.api.deleteSkill(meta.id); setSelected(null); onState(await window.api.getState()) }}>
                      删除
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="muted">选择左侧技能查看 SKILL.md</div>
            )}
            {msg && <div className="ok-text">{msg}</div>}
          </div>
        </div>
        <section className="card form" style={{ marginTop: 16 }}>
          <h3>工作流</h3>
          <p className="muted small">工作流是多步骤配方，可串联技能与提示词，运行时进入编排引擎。</p>
          <button
            className="btn sm primary"
            data-testid="workflow-new"
            onClick={async () => {
              const w = await window.api.saveWorkflow({
                id: '',
                name: '晨间简报',
                description: '分拣邮件 + 看日程 + 写三句话摘要',
                steps: [
                  { id: 's1', title: '邮件分拣', kind: 'skill', ref: 'builtin/email-triage' },
                  { id: 's2', title: '日程', kind: 'skill', ref: 'builtin/calendar-schedule', dependsOn: ['s1'] },
                  { id: 's3', title: '写摘要', kind: 'prompt', ref: '', input: '根据前两步结果写三句话中文晨间简报', dependsOn: ['s2'] }
                ],
                createdAt: 0,
                updatedAt: 0
              })
              setWorkflows(await window.api.listWorkflows())
              setMsg('已创建工作流 ' + w.name)
            }}
          >
            新建示例工作流
          </button>
          {workflows.map((w) => (
            <div key={w.id} className="row" style={{ justifyContent: 'space-between', marginTop: 8 }} data-testid={`workflow-${w.id}`}>
              <div>
                <strong>{w.name}</strong>
                <div className="muted small">{w.description} · {w.steps.length} 步</div>
              </div>
              <div className="row">
                <button className="btn sm" onClick={async () => { const r = await window.api.runWorkflow(w.id, assistantId); setMsg('已启动编排 ' + r.jobId) }}>
                  运行
                </button>
                <button className="btn sm danger" onClick={async () => { await window.api.deleteWorkflow(w.id); setWorkflows(await window.api.listWorkflows()) }}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
