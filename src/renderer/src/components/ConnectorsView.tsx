import { useMemo, useState } from 'react'
import type { AppState, ConnectorConfig, ConnectorKind } from '../../../shared/types'
import Icon from './Icon'

export default function ConnectorsView({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const packs = state.connectorPacks || []
  const list = state.settings.connectors || []
  const [kind, setKind] = useState<ConnectorKind | null>(null)
  const pack = packs.find((p) => p.id === kind)
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const byKind = useMemo(() => {
    const m = new Map<string, ConnectorConfig[]>()
    for (const c of list) {
      const arr = m.get(c.kind) || []
      arr.push(c)
      m.set(c.kind, arr)
    }
    return m
  }, [list])

  const save = async (): Promise<void> => {
    if (!pack) return
    setBusy(true)
    setMsg('')
    try {
      const config: Record<string, string> = {}
      const secrets: Record<string, string> = {}
      for (const f of pack.fields) {
        const v = fields[f.key] || ''
        if (f.secret) secrets[f.key] = v
        else config[f.key] = v
      }
      const cfg: ConnectorConfig & { secrets?: Record<string, string> } = {
        id: 'c-' + Date.now().toString(36),
        kind: pack.id,
        name: name || pack.name,
        enabled: true,
        config,
        secrets,
        status: 'disconnected',
        createdAt: Date.now()
      }
      onState(await window.api.saveConnector(cfg))
      setFields({})
      setName('')
      setKind(null)
      setMsg('已保存并同步为 MCP 工具')
    } catch (e: any) {
      setMsg(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page" data-testid="connectors-view">
      <div className="page-inner">
        <div className="page-head">
          <h2>
            <Icon name="apps-2-line" /> 已连接应用
          </h2>
        </div>
        <p className="muted small">
          市场式连接器列表（Remix 图标）。内置邮箱 / 日历 / Slack / Telegram；非 Composio/500 应用云市场 — 见进度文档 Out of MVP。
        </p>
        {msg && <div className="muted small" style={{ marginBottom: 8 }}>{msg}</div>}
        <div className="apps-market" data-testid="apps-market">
          {packs.map((p) => {
            const connected = byKind.get(p.id) || []
            const st = connected.find((c) => c.status === 'connected') ? 'connected' : connected.length ? connected[0].status : 'disconnected'
            return (
              <div key={p.id} className="app-tile" data-testid={`app-tile-${p.id}`}>
                <div className="app-ico">
                  <Icon name={p.icon || 'plug-line'} />
                </div>
                <strong>{p.name}</strong>
                <div className="muted small">{p.description}</div>
                <span className={'status-pill' + (st === 'connected' ? ' connected' : '')} data-testid={`app-status-${p.id}`}>
                  {st === 'connected' ? '已连接' : connected.length ? st : '未连接'}
                  {connected.length > 1 ? ` · ${connected.length}` : ''}
                </span>
                <button
                  className="btn sm primary"
                  data-testid={`app-connect-${p.id}`}
                  onClick={() => {
                    setKind(p.id)
                    setFields({})
                    setName(p.name)
                  }}
                >
                  {connected.length ? '再添加' : '连接'}
                </button>
              </div>
            )
          })}
        </div>

        {pack && (
          <section className="card form" style={{ marginTop: 16 }} data-testid="app-connect-form">
            <h3>连接 {pack.name}</h3>
            <p className="muted small">{pack.description}</p>
            <label>
              显示名称
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={pack.name} />
            </label>
            {pack.fields.map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  className="input mono"
                  type={f.secret ? 'password' : 'text'}
                  data-testid={`conn-field-${f.key}`}
                  placeholder={f.placeholder}
                  value={fields[f.key] || ''}
                  onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                />
              </label>
            ))}
            <div className="form-actions">
              <button className="btn" onClick={() => setKind(null)}>
                取消
              </button>
              <button className="btn primary" data-testid="connector-save" disabled={busy} onClick={() => void save()}>
                保存并启用
              </button>
            </div>
          </section>
        )}

        <section className="card form" style={{ marginTop: 16 }}>
          <h3>已配置实例</h3>
          {!list.length && <div className="muted">暂无连接器</div>}
          {list.map((c) => (
            <div key={c.id} className="row" data-testid={`connector-row-${c.id}`} style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <strong>{c.name}</strong> <span className="muted small">{c.kind}</span>
                <div className="muted small">
                  {c.status}
                  {c.error ? ' · ' + c.error : ''}
                  {c.hasSecrets ? ' · 已存密钥' : ''}
                </div>
              </div>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={async () => {
                    const r = await window.api.testConnector(c.id)
                    setMsg(r.message)
                    onState(await window.api.getState())
                  }}
                >
                  测试
                </button>
                <button className="btn sm danger" onClick={async () => onState(await window.api.deleteConnector(c.id))}>
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
