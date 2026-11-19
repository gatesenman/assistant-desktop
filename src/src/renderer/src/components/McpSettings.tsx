import { useState } from 'react'
import type { AppState, McpServerConfig } from '../../../shared/types'
import Icon from './Icon'

function parseArgs(s: string): string[] {
  // 支持引号包裹的参数
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}
function parseKv(s: string, sep: string): Record<string, string> {
  const o: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const i = line.indexOf(sep)
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return o
}
const kvText = (o: Record<string, string>, sep: string): string =>
  Object.entries(o || {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')

interface Draft {
  id?: string
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string
  env: string
  url: string
  headers: string
}

const STATUS: Record<string, [string, string]> = {
  connected: ['已连接', 's-done'],
  connecting: ['连接中…', 's-running'],
  error: ['错误', 's-error'],
  disconnected: ['已停用', 's-cancelled']
}

export default function McpSettings({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const servers = state.settings.mcpServers

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) return setErr('请填写名称')
    if (draft.type === 'stdio' && !draft.command.trim()) return setErr('请填写启动命令')
    if (draft.type === 'http' && !/^https?:\/\//.test(draft.url.trim())) return setErr('请填写 http(s) 地址')
    const old = servers.find((s) => s.id === draft.id)
    const cfg: McpServerConfig = {
      id: draft.id || crypto.randomUUID(),
      name: draft.name.trim(),
      type: draft.type,
      command: draft.command.trim(),
      args: parseArgs(draft.args),
      env: parseKv(draft.env, '='),
      url: draft.url.trim(),
      headers: parseKv(draft.headers, ':'),
      enabled: old?.enabled ?? true,
      disabledTools: old?.disabledTools ?? [],
      autoApprove: old?.autoApprove ?? false
    }
    setBusy(true)
    setErr('')
    try {
      onState(await window.api.saveMcpServer(cfg))
      setDraft(null)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
    setBusy(false)
  }

  const update = async (cfg: McpServerConfig, patch: Partial<McpServerConfig>): Promise<void> => {
    onState(await window.api.saveMcpServer({ ...cfg, ...patch }))
  }

  return (
    <section className="card form" data-testid="mcp-section">
      <div className="row between">
        <h3>连接器（MCP 服务器）</h3>
        {!draft && (
          <button
            className="btn sm primary"
            data-testid="mcp-add"
            onClick={() => setDraft({ name: '', type: 'stdio', command: '', args: '', env: '', url: '', headers: '' })}
          >
            <Icon name="add-line" /> 添加服务器
          </button>
        )}
      </div>
      <p className="muted small">支持 stdio（本地命令）和 Streamable HTTP。工具以 mcp__服务器__工具 的名称提供给模型，默认每次调用都需要审批。</p>

      {draft && (
        <div className="subcard form">
          <label>
            名称（英文更佳，用作工具命名空间）
            <input className="input" data-testid="mcp-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如 filesystem" />
          </label>
          <div className="segmented">
            {(['stdio', 'http'] as const).map((t) => (
              <button key={t} className={draft.type === t ? 'active' : ''} onClick={() => setDraft({ ...draft, type: t })} data-testid={`mcp-type-${t}`}>
                {t === 'stdio' ? 'stdio 命令' : 'Streamable HTTP'}
              </button>
            ))}
          </div>
          {draft.type === 'stdio' ? (
            <>
              <label>
                命令
                <input className="input mono" data-testid="mcp-command" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx / node / uvx / python" />
              </label>
              <label>
                参数（空格分隔，可用引号）
                <input
                  className="input mono"
                  data-testid="mcp-args"
                  value={draft.args}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                />
              </label>
              <label>
                环境变量（每行 KEY=VALUE）
                <textarea className="input mono" rows={2} value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label>
                URL
                <input className="input mono" data-testid="mcp-url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/mcp" />
              </label>
              <label>
                请求头（每行 Name: Value，例如 Authorization: Bearer xxx）
                <textarea className="input mono" rows={2} value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} />
              </label>
            </>
          )}
          {err && <div className="field-error">{err}</div>}
          <div className="form-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <button className="btn primary" disabled={busy} data-testid="mcp-save" onClick={() => void save()}>
              {busy ? '连接中…' : '保存并连接'}
            </button>
          </div>
        </div>
      )}

      {servers.length === 0 && !draft && <div className="empty-card small">尚未添加 MCP 服务器</div>}
      {servers.map((s) => {
        const st = state.mcpStatus.find((x) => x.id === s.id)
        const [label, cls] = STATUS[st?.status || 'disconnected']
        return (
          <div className="subcard mcp-server" key={s.id} data-testid="mcp-server" data-status={st?.status}>
            <div className="row">
              <Icon name="plug-line" className="mcp-icon" />
              <strong>{s.name}</strong>
              <span className="muted small mono ellipsis">{s.type === 'http' ? s.url : [s.command, ...s.args].join(' ')}</span>
              <span className="spacer" />
              <span className={`tool-status ${cls}`}>{label}</span>
              <label className="switch" title="启用">
                <input type="checkbox" checked={s.enabled} onChange={(e) => void update(s, { enabled: e.target.checked })} />
                <span />
              </label>
            </div>
            {st?.error && <pre className="tool-output err">{st.error}</pre>}
            {st && st.tools.length > 0 && (
              <div className="mcp-tools">
                {st.tools.map((t) => (
                  <label key={t.name} className="mcp-tool" title={t.description}>
                    <input
                      type="checkbox"
                      checked={!s.disabledTools.includes(t.name)}
                      onChange={(e) =>
                        void update(s, { disabledTools: e.target.checked ? s.disabledTools.filter((x) => x !== t.name) : [...s.disabledTools, t.name] })
                      }
                    />
                    <code>{t.exposedName}</code>
                    <span className="muted small ellipsis">{t.description}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="row">
              <label className="row small">
                <input type="checkbox" checked={s.autoApprove} onChange={(e) => void update(s, { autoApprove: e.target.checked })} />
                自动批准此服务器的工具
              </label>
              <span className="spacer" />
              <button className="btn sm" data-testid="mcp-refresh" onClick={async () => onState(await window.api.refreshMcpServer(s.id))}>
                重新连接
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  setDraft({ id: s.id, name: s.name, type: s.type, command: s.command, args: s.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), env: kvText(s.env, '='), url: s.url, headers: kvText(s.headers, ': ') })
                }
              >
                编辑
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (confirm(`删除 MCP 服务器「${s.name}」？`)) onState(await window.api.deleteMcpServer(s.id))
                }}
              >
                删除
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
