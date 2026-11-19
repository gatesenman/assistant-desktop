import { Fragment, useEffect, useMemo, useState } from 'react'
import type { AppState, PriceEntry, UsageBucket, UsageView as UsageData } from '../../../shared/types'
import { fmtCny, fmtTokens, fmtUsd, hitRate } from '../../../shared/usageFormat'
import Icon from './Icon'

const KIND_LABEL: Record<string, string> = { chat: '对话', task: '后台任务', routine: '定时任务', grounding: '定位模型', probe: '能力检测' }

function sumBuckets(list: UsageBucket[]): UsageBucket {
  return list.reduce(
    (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheHit: a.cacheHit + b.cacheHit, cost: a.cost + b.cost, calls: a.calls + b.calls, unpricedCalls: a.unpricedCalls + b.unpricedCalls }),
    { input: 0, output: 0, cacheHit: 0, cost: 0, calls: 0, unpricedCalls: 0 }
  )
}

function StatCard({ title, b, rate, testid }: { title: string; b: UsageBucket; rate: number; testid?: string }): JSX.Element {
  return (
    <div className="usage-stat" data-testid={testid}>
      <div className="us-title">{title}</div>
      <div className="us-cost">{fmtUsd(b.cost)}</div>
      <div className="muted small">≈ {fmtCny(b.cost, rate)}</div>
      <div className="us-meta">
        <span>{b.calls} 次调用</span>
        <span>输入 {fmtTokens(b.input)}</span>
        <span>输出 {fmtTokens(b.output)}</span>
        {b.input > 0 && <span>缓存命中 {Math.round(hitRate(b) * 100)}%</span>}
        {b.unpricedCalls > 0 && <span className="warn-text">{b.unpricedCalls} 次未定价</span>}
      </div>
    </div>
  )
}

/** 每日柱状图（SVG，按费用或 token） */
function DailyChart({ days, metric }: { days: { day: string; bucket: UsageBucket }[]; metric: 'cost' | 'tokens' }): JSX.Element {
  const W = 760
  const H = 180
  const pad = { l: 46, r: 8, t: 12, b: 26 }
  const val = (b: UsageBucket): number => (metric === 'cost' ? b.cost : b.input + b.output)
  const max = Math.max(...days.map((d) => val(d.bucket)), metric === 'cost' ? 0.01 : 1000)
  const bw = (W - pad.l - pad.r) / days.length
  const ticks = [0, 0.5, 1].map((f) => max * f)
  const fmt = (v: number): string => (metric === 'cost' ? fmtUsd(v) : fmtTokens(v))
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div className="usage-chart" data-testid="usage-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" role="img" aria-label="每日用量">
        {ticks.map((t, i) => {
          const y = pad.t + (H - pad.t - pad.b) * (1 - t / max)
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="grid" />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" className="axis">
                {fmt(t)}
              </text>
            </g>
          )
        })}
        {days.map((d, i) => {
          const v = val(d.bucket)
          const h = ((H - pad.t - pad.b) * v) / max
          const x = pad.l + i * bw + bw * 0.15
          const y = H - pad.b - h
          const hitH = metric === 'tokens' && d.bucket.input ? (h * d.bucket.cacheHit) / (d.bucket.input + d.bucket.output) : 0
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              <rect x={x} y={y} width={bw * 0.7} height={Math.max(v > 0 ? 1.5 : 0, h)} rx={2} className={'bar' + (i === days.length - 1 ? ' today' : '')} />
              {hitH > 0 && <rect x={x} y={H - pad.b - hitH} width={bw * 0.7} height={hitH} rx={2} className="bar hit" />}
              {(i % 5 === 0 || i === days.length - 1) && (
                <text x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="axis">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="usage-chart-tip muted small">
        {hover !== null
          ? `${days[hover].day}：${fmtUsd(days[hover].bucket.cost)} · ${days[hover].bucket.calls} 次调用 · 输入 ${fmtTokens(days[hover].bucket.input)}（命中 ${fmtTokens(days[hover].bucket.cacheHit)}）· 输出 ${fmtTokens(days[hover].bucket.output)}`
          : '把鼠标移到柱子上查看当天明细' + (metric === 'tokens' ? '；深色部分为缓存命中的输入 token' : '')}
      </div>
    </div>
  )
}

function num(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function PriceEditor({ prices, onSave, onReset }: { prices: PriceEntry[]; onSave(p: PriceEntry[]): Promise<void>; onReset(): Promise<void> }): JSX.Element {
  const [rows, setRows] = useState<PriceEntry[]>(prices)
  const [msg, setMsg] = useState('')
  useEffect(() => setRows(prices), [prices])
  const dirty = JSON.stringify(rows) !== JSON.stringify(prices)
  const upd = (i: number, patch: Partial<PriceEntry>): void => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const updPrice = (i: number, k: 'input' | 'cacheHit' | 'output', v: string, peak = false): void =>
    setRows((r) =>
      r.map((x, j) => {
        if (j !== i) return x
        if (peak && x.peak) return { ...x, peak: { ...x.peak, [k]: num(v) } }
        return { ...x, price: { ...x.price, [k]: num(v) } }
      })
    )
  return (
    <div className="price-editor" data-testid="price-editor">
      <table className="usage-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>服务商（Base URL 包含）</th>
            <th>模型（逗号分隔，* 通配）</th>
            <th>币种</th>
            <th title="每百万 token">输入·未命中</th>
            <th title="每百万 token">输入·命中缓存</th>
            <th title="每百万 token">输出</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <Fragment key={p.id}>
              <tr data-testid="price-row">
                <td>
                  <input className="input sm" value={p.label} onChange={(e) => upd(i, { label: e.target.value })} />
                </td>
                <td>
                  <input className="input sm mono" value={p.provider} placeholder="任意" onChange={(e) => upd(i, { provider: e.target.value })} />
                </td>
                <td>
                  <input className="input sm mono" value={p.models} onChange={(e) => upd(i, { models: e.target.value })} />
                </td>
                <td>
                  <select className="input sm" value={p.currency} onChange={(e) => upd(i, { currency: e.target.value as 'USD' | 'CNY' })}>
                    <option value="USD">USD</option>
                    <option value="CNY">CNY</option>
                  </select>
                </td>
                <td>
                  <input className="input sm num" type="number" step="0.001" value={p.price.input} onChange={(e) => updPrice(i, 'input', e.target.value)} />
                </td>
                <td>
                  <input className="input sm num" type="number" step="0.001" value={p.price.cacheHit ?? ''} placeholder="同未命中" onChange={(e) => updPrice(i, 'cacheHit', e.target.value)} />
                </td>
                <td>
                  <input className="input sm num" type="number" step="0.001" value={p.price.output} onChange={(e) => updPrice(i, 'output', e.target.value)} />
                </td>
                <td>
                  <button className="icon-btn" title="删除" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                    <Icon name="delete-bin-line" />
                  </button>
                </td>
              </tr>
              {p.peak && (
                <tr className="peak-row">
                  <td colSpan={4} className="muted small">
                    ↳ 高峰价（UTC {p.peak.utcHours.map(([a, b]) => `${String(a).padStart(2, '0')}–${String(b).padStart(2, '0')}`).join('、')}
                    {p.peak.weekdaysOnly ? '，周一至周五' : ''}）{p.note ? ` · ${p.note}` : ''}
                  </td>
                  <td>
                    <input className="input sm num" type="number" step="0.001" value={p.peak.input} onChange={(e) => updPrice(i, 'input', e.target.value, true)} />
                  </td>
                  <td>
                    <input className="input sm num" type="number" step="0.001" value={p.peak.cacheHit ?? ''} onChange={(e) => updPrice(i, 'cacheHit', e.target.value, true)} />
                  </td>
                  <td>
                    <input className="input sm num" type="number" step="0.001" value={p.peak.output} onChange={(e) => updPrice(i, 'output', e.target.value, true)} />
                  </td>
                  <td />
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="form-actions">
        {msg && <span className="ok-text">{msg}</span>}
        <button
          className="btn"
          data-testid="price-add"
          onClick={() =>
            setRows((r) => [...r, { id: 'custom-' + Date.now().toString(36), label: '自定义模型', provider: '', models: 'my-model', currency: 'USD', price: { input: 0, cacheHit: 0, output: 0 } }])
          }
        >
          <Icon name="add-line" /> 添加价格
        </button>
        <button
          className="btn ghost"
          data-testid="price-reset"
          onClick={async () => {
            if (!confirm('恢复默认价格表？自定义条目会被删除。')) return
            await onReset()
            setMsg('已恢复默认价格')
          }}
        >
          恢复默认
        </button>
        <button
          className="btn primary"
          data-testid="price-save"
          disabled={!dirty}
          onClick={async () => {
            await onSave(rows)
            setMsg('价格表已保存，新的调用按新价格计费')
            setTimeout(() => setMsg(''), 2500)
          }}
        >
          保存价格表
        </button>
      </div>
    </div>
  )
}

export default function UsageView({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const [data, setData] = useState<UsageData | null>(null)
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const [budget, setBudget] = useState({ perTaskUsd: '', perDayUsd: '', perTaskTokens: '' })
  const [msg, setMsg] = useState('')
  const rate = state.settings.cnyPerUsd || 7.1
  const load = async (): Promise<void> => {
    const d = await window.api.getUsage()
    setData(d)
    setBudget({
      perTaskUsd: d.budget.perTaskUsd ? String(d.budget.perTaskUsd) : '',
      perDayUsd: d.budget.perDayUsd ? String(d.budget.perDayUsd) : '',
      perTaskTokens: d.budget.perTaskTokens ? String(d.budget.perTaskTokens) : ''
    })
  }
  useEffect(() => {
    void load()
    return window.api.onEvent((ev) => {
      if (ev.type === 'usage') void window.api.getUsage().then(setData)
    })
  }, [])
  const names = useMemo(() => Object.fromEntries(state.assistants.map((a) => [a.id, a.name])), [state.assistants])
  const routineNames = useMemo(() => Object.fromEntries(state.routines.map((r) => [r.id, r.name])), [state.routines])
  if (!data) return <div className="page"><div className="page-inner muted">加载中…</div></div>
  const last7 = sumBuckets(data.days.slice(-7).map((d) => d.bucket))
  const last30 = sumBuckets(data.days.map((d) => d.bucket))
  const empty = data.summary.total.calls === 0
  const table = (rec: Record<string, UsageBucket>, label: (k: string) => string, testid: string): JSX.Element => {
    const rows = Object.entries(rec).sort((a, b) => b[1].cost - a[1].cost || b[1].input - a[1].input)
    return rows.length ? (
      <table className="usage-table" data-testid={testid}>
        <thead>
          <tr>
            <th>名称</th>
            <th>调用</th>
            <th>输入</th>
            <th>命中缓存</th>
            <th>输出</th>
            <th>费用</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map(([k, b]) => (
            <tr key={k}>
              <td className="ellipsis">{label(k)}</td>
              <td>{b.calls}</td>
              <td>{fmtTokens(b.input)}</td>
              <td>{b.input ? Math.round(hitRate(b) * 100) + '%' : '-'}</td>
              <td>{fmtTokens(b.output)}</td>
              <td>
                {fmtUsd(b.cost)}
                {b.unpricedCalls > 0 && <span className="muted small"> （{b.unpricedCalls} 次未定价）</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className="muted small">暂无数据</div>
    )
  }
  const dayBudget = data.budget.perDayUsd
  return (
    <div className="page" data-testid="usage-page">
      <div className="page-inner wide">
        <div className="page-head">
          <h2>
            <Icon name="bar-chart-2-line" /> 用量与费用
          </h2>
          <span className="muted small">费用按「价格表」实时计算（美元，人民币按 1 USD ≈ ¥{rate} 显示）；数据只保存在本机。</span>
        </div>

        {data.paused.length > 0 && (
          <div className="usage-paused" data-testid="usage-paused">
            {data.paused.map((p) => (
              <div key={p.assistantId} className="msg-budget">
                <Icon name="pause-circle-fill" />
                <span className="mb-text">
                  <b>{names[p.assistantId] || '助手'}</b>：{p.message.replace(/^⏸\s*/, '')}
                </span>
                <button className="btn sm" data-testid="usage-resume" onClick={async () => {
                  await window.api.resumeBudget(p.assistantId)
                  void load()
                }}>
                  <Icon name="play-line" /> 继续
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="usage-stats">
          <StatCard title="今天" b={data.today} rate={rate} testid="usage-today" />
          <StatCard title="近 7 天" b={last7} rate={rate} />
          <StatCard title="近 30 天" b={last30} rate={rate} />
          <StatCard title="累计" b={data.summary.total} rate={rate} />
        </div>
        {dayBudget > 0 && (
          <div className="usage-budget-meter" data-testid="usage-day-meter">
            今日预算 {fmtUsd(data.today.cost)} / {fmtUsd(dayBudget)}
            <div className="usage-meter">
              <div className={'usage-meter-bar' + (data.today.cost >= dayBudget ? ' over' : data.today.cost >= dayBudget * 0.8 ? ' near' : '')} style={{ width: `${Math.min(100, (data.today.cost / dayBudget) * 100)}%` }} />
            </div>
          </div>
        )}

        <section className="card">
          <div className="card-head">
            <h3>每日用量（近 30 天）</h3>
            <div className="segmented sm">
              <button className={metric === 'cost' ? 'active' : ''} onClick={() => setMetric('cost')} data-testid="metric-cost">
                费用
              </button>
              <button className={metric === 'tokens' ? 'active' : ''} onClick={() => setMetric('tokens')} data-testid="metric-tokens">
                Token
              </button>
            </div>
          </div>
          {empty ? (
            <div className="empty-card" data-testid="usage-empty">
              <Icon name="coins-line" /> 还没有用量记录。和助手对话、运行任务后，这里会按天统计 token 和费用。
            </div>
          ) : (
            <DailyChart days={data.days} metric={metric} />
          )}
        </section>

        <div className="usage-grid">
          <section className="card">
            <h3>按模型</h3>
            {table(data.summary.byModel, (k) => k, 'usage-by-model')}
          </section>
          <section className="card">
            <h3>按助手</h3>
            {table(data.summary.byAssistant, (k) => names[k] || '（已删除的助手）', 'usage-by-assistant')}
          </section>
          {Object.keys(data.summary.byRoutine).length > 0 && (
            <section className="card">
              <h3>按定时任务</h3>
              {table(data.summary.byRoutine, (k) => routineNames[k] || '（已删除的定时任务）', 'usage-by-routine')}
            </section>
          )}
          <section className="card">
            <h3>最近调用</h3>
            {data.recent.length ? (
              <div className="usage-recent" data-testid="usage-recent">
                {data.recent.slice(0, 15).map((r, i) => (
                  <div key={i} className="usage-recent-row">
                    <span className="muted small mono">{new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    <span className="pill">{KIND_LABEL[r.kind] || r.kind}</span>
                    <span className="ellipsis">{r.assistantId ? names[r.assistantId] || '' : ''}</span>
                    <span className="mono small ellipsis">{r.model}</span>
                    <span className="small">
                      {fmtTokens(r.input)}→{fmtTokens(r.output)}
                      {r.cacheHit ? `（命中 ${fmtTokens(r.cacheHit)}）` : ''}
                    </span>
                    <span className="small">{r.priced ? fmtUsd(r.cost) : '未定价'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted small">暂无</div>
            )}
          </section>
        </div>

        <section className="card form" data-testid="budget-section">
          <h3>
            <Icon name="wallet-3-line" /> 预算
          </h3>
          <p className="muted small">超出预算时智能体会在下一次调用模型前自动暂停，并在对话中提示；提高上限后点「继续」即可接着做。留空表示不限制。</p>
          <div className="budget-grid">
            <label>
              单个任务上限（美元）
              <input className="input" data-testid="budget-task" type="number" min={0} step={0.01} placeholder="不限" value={budget.perTaskUsd} onChange={(e) => setBudget({ ...budget, perTaskUsd: e.target.value })} />
              <span className="muted small">一轮对话 / 一个后台任务 / 一次定时任务</span>
            </label>
            <label>
              每天上限（美元）
              <input className="input" data-testid="budget-day" type="number" min={0} step={0.01} placeholder="不限" value={budget.perDayUsd} onChange={(e) => setBudget({ ...budget, perDayUsd: e.target.value })} />
              <span className="muted small">按本机日期统计所有助手</span>
            </label>
            <label>
              单个任务 token 上限
              <input className="input" data-testid="budget-tokens" type="number" min={0} step={1000} placeholder="不限" value={budget.perTaskTokens} onChange={(e) => setBudget({ ...budget, perTaskTokens: e.target.value })} />
              <span className="muted small">适合没有价格的本地模型</span>
            </label>
          </div>
          <div className="form-actions">
            {msg && <span className="ok-text" data-testid="budget-msg">{msg}</span>}
            <button
              className="btn primary"
              data-testid="budget-save"
              onClick={async () => {
                const d = await window.api.saveBudget({ perTaskUsd: num(budget.perTaskUsd), perDayUsd: num(budget.perDayUsd), perTaskTokens: num(budget.perTaskTokens) })
                setData(d)
                setMsg('预算已保存')
                setTimeout(() => setMsg(''), 2000)
              }}
            >
              保存预算
            </button>
          </div>
        </section>

        <section className="card form" data-testid="prices-section">
          <h3>
            <Icon name="price-tag-3-line" /> 价格表（每百万 token）
          </h3>
          <p className="muted small">
            默认内置 DeepSeek 官方价格（2026-10-19 核对 api-docs.deepseek.com，含高峰 / 低谷时段）。其它服务商请自行添加；没有匹配价格的模型只统计 token，不计费用。
          </p>
          <PriceEditor
            prices={data.prices}
            onSave={async (p) => {
              setData(await window.api.savePrices(p))
              onState(await window.api.getState())
            }}
            onReset={async () => setData(await window.api.resetPrices())}
          />
        </section>

        <section className="card form">
          <h3>显示</h3>
          <label className="row">
            <input type="checkbox" data-testid="show-usage" checked={state.settings.showUsage !== false} onChange={async (e) => onState(await window.api.saveSettings({ showUsage: e.target.checked }))} />
            在每轮回复下显示 token 用量与费用
          </label>
          <label>
            人民币汇率（仅用于显示）
            <input className="input" type="number" step={0.01} min={1} value={rate} onChange={async (e) => onState(await window.api.saveSettings({ cnyPerUsd: Math.max(1, Number(e.target.value) || 7.1) }))} />
          </label>
          <div className="form-actions">
            <button
              className="btn danger"
              data-testid="usage-clear"
              onClick={async () => {
                if (!confirm('清空所有用量记录？此操作不可撤销。')) return
                setData(await window.api.clearUsage())
              }}
            >
              清空用量记录
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
