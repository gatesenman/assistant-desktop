import { useEffect, useState } from 'react'
import type { AppState, Assistant, Routine, UsageBucket } from '../../../shared/types'
import { fmtTokens, fmtUsd, usageLine } from '../../../shared/usageFormat'
import Icon from './Icon'

const PRESETS: [string, string][] = [
  ['每 30 秒', '*/30 * * * * *'],
  ['每天 9:00', '0 9 * * *'],
  ['工作日 18:00', '0 18 * * 1-5'],
  ['每小时', '0 * * * *'],
  ['每 15 分钟', '*/15 * * * *'],
  ['每周一 10:00', '0 10 * * 1']
]

interface Draft {
  id?: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  unattended?: boolean
}
const EMPTY: Draft = { name: '', cron: '0 9 * * *', prompt: '', enabled: true }

function errMsg(e: any): string {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export default function RoutinesView({
  assistant,
  routines,
  paused,
  onState,
  usageByRoutine,
  cnyPerUsd
}: {
  assistant: Assistant
  routines: Routine[]
  paused: boolean
  onState(s: AppState): void
  /** v0.7：每个定时任务的累计用量 */
  usageByRoutine?: Record<string, UsageBucket>
  cnyPerUsd?: number
}): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [cronOk, setCronOk] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!draft) return
    let alive = true
    void window.api.validateCron(draft.cron).then((ok) => alive && setCronOk(ok))
    return () => {
      alive = false
    }
  }, [draft?.cron])

  useEffect(() => setDraft(null), [assistant.id])

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim() || !draft.prompt.trim()) return setErr('请填写名称和提示词')
    if (!cronOk) return setErr('cron 表达式无效')
    try {
      const s = draft.id
        ? await window.api.updateRoutine(draft.id, { name: draft.name, cron: draft.cron, prompt: draft.prompt, enabled: draft.enabled, unattended: !!draft.unattended })
        : await window.api.createRoutine({ assistantId: assistant.id, name: draft.name, cron: draft.cron, prompt: draft.prompt, enabled: draft.enabled, unattended: !!draft.unattended })
      onState(s)
      setDraft(null)
      setErr('')
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h2>定时任务</h2>
            <p className="muted">按 cron 计划自动向「{assistant.name}」发送提示词，结果会出现在聊天中并弹出桌面通知（应用需保持运行）。</p>
          </div>
          {!draft && (
            <button className="btn primary" data-testid="routine-new" onClick={() => setDraft({ ...EMPTY })}>
              <Icon name="add-line" /> 新建任务
            </button>
          )}
        </div>

        {paused && (
          <div className="notice-bar">
            <Icon name="pause-circle-line" /> 所有定时任务已暂停（可在托盘菜单或这里恢复）
            <button className="btn sm" onClick={async () => onState(await window.api.saveSettings({ routinesPaused: false }))}>
              恢复
            </button>
          </div>
        )}
        {draft && (
          <div className="card form">
            <label>
              名称
              <input className="input" data-testid="routine-name" value={draft.name} placeholder="例如：每日新闻摘要" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              Cron 表达式 <span className="muted">（分 时 日 月 周，可选第 1 位为秒）</span>
              <input
                className={'input mono' + (cronOk ? '' : ' invalid')}
                data-testid="routine-cron"
                value={draft.cron}
                onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
              />
            </label>
            <div className="chips">
              {PRESETS.map(([l, c]) => (
                <button key={c} className={'chip' + (draft.cron === c ? ' active' : '')} onClick={() => setDraft({ ...draft, cron: c })}>
                  {l}
                </button>
              ))}
            </div>
            {!cronOk && <div className="field-error">无效的 cron 表达式</div>}
            <label>
              提示词
              <textarea
                className="input"
                rows={4}
                data-testid="routine-prompt"
                value={draft.prompt}
                placeholder="例如：抓取 https://news.ycombinator.com 并用中文总结今天最热门的 5 条新闻"
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </label>
            <label className="row">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              启用
            </label>
            <label className="row">
              <input type="checkbox" data-testid="routine-unattended" checked={!!draft.unattended} onChange={(e) => setDraft({ ...draft, unattended: e.target.checked })} />
              无人值守：自动批准此任务中的所有操作（包括电脑控制、命令执行）
            </label>
            {err && <div className="field-error">{err}</div>}
            <div className="form-actions">
              <button className="btn" onClick={() => setDraft(null)}>
                取消
              </button>
              <button className="btn primary" data-testid="routine-save" onClick={() => void save()}>
                保存
              </button>
            </div>
          </div>
        )}

        {routines.length === 0 && !draft && <div className="empty-card">暂无定时任务</div>}
        {routines.map((r) => (
          <div className={'card routine' + (r.enabled ? '' : ' disabled')} key={r.id}>
            <div className="routine-main">
              <div className="routine-title">
                <span>{r.name}</span>
                <code className="cron">{r.cron}</code>
                {r.unattended && <span className="pill warn" title="自动批准所有操作">
                    <Icon name="shield-check-line" /> 无人值守
                  </span>}
              </div>
              <div className="routine-prompt">{r.prompt}</div>
              <div className="muted small">
                {r.lastRunAt
                  ? `上次运行：${new Date(r.lastRunAt).toLocaleString('zh-CN', { hour12: false })} · ${r.lastStatus === 'ok' ? '成功' : '失败' + (r.lastError ? '：' + r.lastError : '')}`
                  : '尚未运行'}
              </div>
              {(r.lastUsage || usageByRoutine?.[r.id]) && (
                <div className="muted small routine-usage" data-testid="routine-usage">
                  <Icon name="coins-line" />
                  {r.lastUsage && <> 上次：{usageLine(r.lastUsage, cnyPerUsd)}</>}
                  {usageByRoutine?.[r.id] && (
                    <>
                      {' '}· 累计 {usageByRoutine[r.id].calls} 次调用 / {fmtTokens(usageByRoutine[r.id].input + usageByRoutine[r.id].output)} token / {fmtUsd(usageByRoutine[r.id].cost)}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="routine-actions">
              <label className="switch" title={r.enabled ? '已启用' : '已停用'}>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={async (e) => onState(await window.api.updateRoutine(r.id, { enabled: e.target.checked }))}
                />
                <span />
              </label>
              <button className="btn sm" onClick={() => void window.api.runRoutineNow(r.id)}>
                立即运行
              </button>
              <button className="btn sm" onClick={() => setDraft({ id: r.id, name: r.name, cron: r.cron, prompt: r.prompt, enabled: r.enabled, unattended: r.unattended })}>
                编辑
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (confirm(`删除定时任务「${r.name}」？`)) onState(await window.api.deleteRoutine(r.id))
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      
      <section className="card form webhook-card" data-testid="webhook-trigger">
        <h3>
          <Icon name="webhook-line" /> Webhook 触发（入口）
        </h3>
        <p className="muted small">MVP：登记本地 webhook URL 占位。完整云端 Webhook / 外网隧道为 Out of MVP。</p>
        <label>
          路径后缀
          <input className="input mono" data-testid="webhook-path" defaultValue="/hooks/routine" readOnly />
        </label>
        <div className="muted small">示例：POST http://127.0.0.1:18789/hooks/&lt;routineId&gt; （需在设置中启用本地 HTTP，当前为占位 UI）</div>
      </section>
</div>
    </div>
  )
}
