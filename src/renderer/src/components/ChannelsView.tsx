import { useState } from 'react'
import type { AppState, ChannelKind } from '../../../shared/types'
import Icon from './Icon'

export default function ChannelsView({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const list = state.settings.channels || []
  const [kind, setKind] = useState<ChannelKind>('telegram')
  const [name, setName] = useState('Telegram')
  const [token, setToken] = useState('')
  const [defaultChannel, setDefaultChannel] = useState('')
  const [assistantId, setAssistantId] = useState(state.assistants[0]?.id || '')
  const [msg, setMsg] = useState('')

  return (
    <div className="page" data-testid="channels-view">
      <div className="page-inner">
        <div className="page-head">
          <h2>
            <Icon name="chat-3-line" /> 消息通道
          </h2>
        </div>
        <p className="muted small">Telegram 完整可用（长轮询）；Slack 用 Bot Token 轮询默认频道；微信提供本机 HTTP 桥 stub（DIY）。入站消息会写入绑定助手对话；默认外发需批准。</p>
        <section className="card form">
          <div className="segmented">
            {(
              [
                ['telegram', 'Telegram'],
                ['slack', 'Slack'],
                ['wechat_bridge', '微信桥']
              ] as [ChannelKind, string][]
            ).map(([k, l]) => (
              <button key={k} className={kind === k ? 'active' : ''} data-testid={`channel-kind-${k}`} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
          <label>
            名称
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            绑定助手
            <select className="input" value={assistantId} onChange={(e) => setAssistantId(e.target.value)}>
              {state.assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {kind !== 'wechat_bridge' && (
            <label>
              Bot Token
              <input className="input mono" type="password" data-testid="channel-token" value={token} onChange={(e) => setToken(e.target.value)} />
            </label>
          )}
          {kind === 'slack' && (
            <label>
              默认频道
              <input
                className="input"
                id="ch-default"
                placeholder="#general 或 Cxxxx"
                value={defaultChannel}
                onChange={(e) => setDefaultChannel(e.target.value)}
                data-testid="channel-default"
              />
            </label>
          )}
          <button
            className="btn primary"
            data-testid="channel-save"
            onClick={async () => {
              onState(
                await window.api.saveChannel({
                  id: 'ch-' + Date.now().toString(36),
                  kind,
                  name,
                  enabled: true,
                  assistantId,
                  config: kind === 'slack' ? { defaultChannel: defaultChannel.trim() } : {},
                  secrets: kind === 'wechat_bridge' ? {} : { botToken: token },
                  status: 'disconnected',
                  requireApproval: true,
                  createdAt: Date.now()
                })
              )
              setMsg('已保存')
              if (kind === 'wechat_bridge') setMsg((await window.api.testChannel(state.settings.channels.at(-1)?.id || '')).message)
            }}
          >
            保存通道
          </button>
          {msg && <div className="muted small">{msg}</div>}
        </section>
        <section className="card form">
          <h3>已启用</h3>
          {list.map((c) => (
            <div key={c.id} className="row" style={{ justifyContent: 'space-between' }} data-testid={`channel-row-${c.id}`}>
              <div>
                <strong>{c.name}</strong> <span className="muted small">{c.kind}</span>
                {c.kind === 'slack' && c.config?.defaultChannel && (
                  <span className="muted small"> · {c.config.defaultChannel}</span>
                )}
              </div>
              <div className="row">
                <button className="btn sm" onClick={async () => setMsg((await window.api.testChannel(c.id)).message)}>
                  测试
                </button>
                <button className="btn sm danger" onClick={async () => onState(await window.api.deleteChannel(c.id))}>
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
